#!/usr/bin/env python3
"""Build PixelStrike collision and placement QA from the authoritative Mineways OBJ."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


WORLD = {"xmin": -379, "xmax": 380, "zmin": -536, "zmax": 537, "ground": 3.0}

# Exact outer edges of the iron-block scope lines in the supplied MC world.
TARGETS = {
    "north_admin": {"x0": 158.0, "x1": 246.0, "z0": -360.0, "z1": -279.0, "base_y": 3.0},
    "activity_center": {"x0": 158.0, "x1": 241.0, "z0": -174.0, "z1": 59.0, "base_y": 3.0},
    "stadium": {"x0": -170.0, "x1": -7.0, "z0": 107.0, "z1": 333.0, "base_y": 3.0},
}

# Three.js bounds of the old GLB (X east, Y up, Z campus north/south).
SOURCES = {
    "north_admin": {"x0": 96.88742, "x1": 166.09271, "z0": -241.65723, "z1": -180.06543, "y0": 0.0, "y1": 25.392},
    "activity_center": {"x0": 91.05960, "x1": 182.84769, "z0": -84.05469, "z1": 117.74902, "y0": 0.0, "y1": 24.6476},
    "stadium": {"x0": -165.0, "x1": -30.59603, "z0": 111.22754, "z1": 269.55469, "y0": 0.0, "y1": 19.7635},
}

IGNORED_TOP_MATERIAL_FRAGMENTS = (
    "leaves", "sapling", "flower", "dandelion", "orchid", "bluet", "tulip", "mushroom",
    "dead_bush", "bush", "wheat", "beetroot", "water", "lava", "rail", "torch", "ladder",
    "pane_top", "iron_bars", "tripwire", "cobweb", "door", "furnace", "shulker", "chest",
    "command_block", "crafting_table", "dispenser", "dropper", "beacon", "sponge", "tnt",
    "pumpkin", "snow", "log", "sapling", "ore", "flower_pot", "daylight_detector",
    # White iron-block rectangles are construction scope guides in the supplied
    # MC map, not finished walls. They remain visible in the OBJ but must never
    # block players or bullets.
    "iron_block",
)

SURFACE_THICKNESS = 0.12
VERTICAL_CELL = 0.5


def inside_target(x: float, z: float, padding: float = 0.0) -> bool:
    return any(
        target["x0"] - padding <= x <= target["x1"] + padding
        and target["z0"] - padding <= z <= target["z1"] + padding
        for target in TARGETS.values()
    )


def target_transform(name: str, margin: float = 2.0) -> dict[str, object]:
    source, target = SOURCES[name], TARGETS[name]
    inner = {
        "x0": target["x0"] + margin,
        "x1": target["x1"] - margin,
        "z0": target["z0"] + margin,
        "z1": target["z1"] - margin,
    }
    sx = (inner["x1"] - inner["x0"]) / (source["x1"] - source["x0"])
    sz = (inner["z1"] - inner["z0"]) / (source["z1"] - source["z0"])
    source_center = ((source["x0"] + source["x1"]) / 2, (source["z0"] + source["z1"]) / 2)
    target_center = ((inner["x0"] + inner["x1"]) / 2, (inner["z0"] + inner["z1"]) / 2)
    return {
        "scale": [sx, 1.0, sz],
        "position": [
            target_center[0] - sx * source_center[0],
            target["base_y"] - source["y0"],
            target_center[1] - sz * source_center[1],
        ],
        "rotation_y_degrees": 0.0,
        "source_bounds": source,
        "target_outer_bounds": target,
        "result_bounds": {
            "x0": inner["x0"], "x1": inner["x1"],
            "z0": inner["z0"], "z1": inner["z1"],
            "y0": target["base_y"], "y1": target["base_y"] + source["y1"],
        },
        "clearance": {
            "west": inner["x0"] - target["x0"], "east": target["x1"] - inner["x1"],
            "south": inner["z0"] - target["z0"], "north": target["z1"] - inner["z1"],
        },
    }


def merge_boolean_mask(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Merge true cells into non-overlapping rectangles (x0, x1, row0, row1)."""
    active: dict[tuple[int, int], list[int]] = {}
    rectangles: list[tuple[int, int, int, int]] = []
    for row_index, row in enumerate(mask):
        segments: list[tuple[int, int]] = []
        start = 0
        while start < row.shape[0]:
            if not row[start]:
                start += 1
                continue
            end = start + 1
            while end < row.shape[0] and row[end]:
                end += 1
            segments.append((start, end))
            start = end
        current = set(segments)
        for key in list(active):
            if key not in current:
                rectangles.append((key[0], key[1], active[key][0], active[key][1]))
                del active[key]
        for key in current:
            if key in active:
                active[key][1] = row_index + 1
            else:
                active[key] = [row_index, row_index + 1]
    for key, rows in active.items():
        rectangles.append((key[0], key[1], rows[0], rows[1]))
    return rectangles


def parse_obj_collision_surfaces(obj_path: Path) -> tuple[list[dict[str, float | int]], np.ndarray, dict[str, object], int, int]:
    width = WORLD["xmax"] - WORLD["xmin"]
    depth = WORLD["zmax"] - WORLD["zmin"]
    vertices: list[tuple[float, float, float]] = []
    material = ""
    platform_polygons: dict[float, list[list[tuple[float, float]]]] = {}
    wall_x_rects: dict[float, list[tuple[float, float, float, float]]] = {}
    wall_z_rects: dict[float, list[tuple[float, float, float, float]]] = {}
    surface_counts: Counter[str] = Counter()
    ignored_diagonal_faces = 0
    ignored_fractional_walls = 0
    vertex_count = 0
    triangle_count = 0

    with obj_path.open("r", encoding="utf-8", errors="replace") as source:
        for raw in source:
            if raw.startswith("v "):
                _, x, y, z = raw.split()[:4]
                vertices.append((float(x), float(y), float(z)))
                vertex_count += 1
            elif raw.startswith("usemtl "):
                material = raw.strip()[7:]
            elif raw.startswith("f "):
                refs = [part.split("/") for part in raw.split()[1:]]
                face_triangles = max(1, len(refs) - 2)
                triangle_count += face_triangles
                normal_indices = {int(ref[2]) for ref in refs if len(ref) > 2 and ref[2]}
                if len(normal_indices) != 1 or any(fragment in material.lower() for fragment in IGNORED_TOP_MATERIAL_FRAGMENTS):
                    continue
                indices = [int(ref[0]) - 1 for ref in refs]
                polygon = [vertices[index] for index in indices]
                cx = sum(vertex[0] for vertex in polygon) / len(polygon)
                cz = sum(vertex[2] for vertex in polygon) / len(polygon)
                if inside_target(cx, cz, padding=0.5):
                    continue
                normal = next(iter(normal_indices))
                x0, x1 = min(vertex[0] for vertex in polygon), max(vertex[0] for vertex in polygon)
                y0, y1 = min(vertex[1] for vertex in polygon), max(vertex[1] for vertex in polygon)
                z0, z1 = min(vertex[2] for vertex in polygon), max(vertex[2] for vertex in polygon)
                if normal == 5 and y1 > WORLD["ground"] + 0.03:
                    level = round(y1 * 16.0) / 16.0
                    points = [(vertex[0] - WORLD["xmin"], WORLD["zmax"] - vertex[2]) for vertex in polygon]
                    platform_polygons.setdefault(level, []).append(points)
                    surface_counts[f"platform:{material}"] += face_triangles
                elif normal in (1, 4) and y1 > WORLD["ground"] + 0.05 and z1 - z0 > 0.03:
                    plane = round(sum(vertex[0] for vertex in polygon) / len(polygon) * 16.0) / 16.0
                    if abs(plane * 2 - round(plane * 2)) > 0.02:
                        ignored_fractional_walls += 1
                        continue
                    wall_x_rects.setdefault(plane, []).append((z0, z1, max(y0, WORLD["ground"]), y1))
                    surface_counts[f"wall_x:{material}"] += face_triangles
                elif normal in (3, 6) and y1 > WORLD["ground"] + 0.05 and x1 - x0 > 0.03:
                    plane = round(sum(vertex[2] for vertex in polygon) / len(polygon) * 16.0) / 16.0
                    if abs(plane * 2 - round(plane * 2)) > 0.02:
                        ignored_fractional_walls += 1
                        continue
                    wall_z_rects.setdefault(plane, []).append((x0, x1, max(y0, WORLD["ground"]), y1))
                    surface_counts[f"wall_z:{material}"] += face_triangles
                elif normal not in (2,):
                    ignored_diagonal_faces += 1

    blocks: list[dict[str, float | int]] = []
    spawn_heights = np.full((depth, width), WORLD["ground"], dtype=np.float32)
    for level, polygons in sorted(platform_polygons.items()):
        image = Image.new("1", (width, depth), 0)
        draw = ImageDraw.Draw(image)
        for polygon in polygons:
            draw.polygon(polygon, fill=1)
        mask = np.asarray(image, dtype=np.uint8).astype(bool)
        if level <= 3.55:
            spawn_heights[mask] = np.maximum(spawn_heights[mask], level)
        for col0, col1, row0, row1 in merge_boolean_mask(mask):
            blocks.append({
                "x": float(WORLD["xmin"] + col0), "y": round(level - SURFACE_THICKNESS, 4),
                "z": float(WORLD["zmax"] - row1), "w": float(col1 - col0),
                "h": SURFACE_THICKNESS, "d": float(row1 - row0), "t": 1,
            })

    max_y = max((vertex[1] for vertex in vertices), default=WORLD["ground"])
    vertical_cells = int(math.ceil((max_y - WORLD["ground"]) / VERTICAL_CELL))

    for plane, rectangles in wall_x_rects.items():
        mask = np.zeros((vertical_cells, depth), dtype=bool)
        for z0, z1, y0, y1 in rectangles:
            c0 = max(0, int(math.floor(z0 - WORLD["zmin"])))
            c1 = min(depth, int(math.ceil(z1 - WORLD["zmin"])))
            r0 = max(0, int(math.floor((y0 - WORLD["ground"]) / VERTICAL_CELL)))
            r1 = min(vertical_cells, int(math.ceil((y1 - WORLD["ground"]) / VERTICAL_CELL)))
            if c1 > c0 and r1 > r0:
                mask[r0:r1, c0:c1] = True
        for col0, col1, row0, row1 in merge_boolean_mask(mask):
            blocks.append({
                "x": round(plane - SURFACE_THICKNESS / 2, 4),
                "y": round(WORLD["ground"] + row0 * VERTICAL_CELL, 4),
                "z": float(WORLD["zmin"] + col0), "w": SURFACE_THICKNESS,
                "h": round((row1 - row0) * VERTICAL_CELL, 4), "d": float(col1 - col0), "t": 1,
            })

    for plane, rectangles in wall_z_rects.items():
        mask = np.zeros((vertical_cells, width), dtype=bool)
        for x0, x1, y0, y1 in rectangles:
            c0 = max(0, int(math.floor(x0 - WORLD["xmin"])))
            c1 = min(width, int(math.ceil(x1 - WORLD["xmin"])))
            r0 = max(0, int(math.floor((y0 - WORLD["ground"]) / VERTICAL_CELL)))
            r1 = min(vertical_cells, int(math.ceil((y1 - WORLD["ground"]) / VERTICAL_CELL)))
            if c1 > c0 and r1 > r0:
                mask[r0:r1, c0:c1] = True
        for col0, col1, row0, row1 in merge_boolean_mask(mask):
            blocks.append({
                "x": float(WORLD["xmin"] + col0),
                "y": round(WORLD["ground"] + row0 * VERTICAL_CELL, 4),
                "z": round(plane - SURFACE_THICKNESS / 2, 4), "w": float(col1 - col0),
                "h": round((row1 - row0) * VERTICAL_CELL, 4), "d": SURFACE_THICKNESS, "t": 1,
            })

    stats = {
        "platform_levels": len(platform_polygons),
        "x_wall_planes": len(wall_x_rects),
        "z_wall_planes": len(wall_z_rects),
        "ignored_diagonal_faces": ignored_diagonal_faces,
        "ignored_fractional_walls": ignored_fractional_walls,
        "surface_triangle_counts": dict(surface_counts),
    }
    return blocks, spawn_heights, stats, vertex_count, triangle_count
    blocks: list[dict[str, float | int]] = []
    for col0, col1, row0, row1, top in rectangles:
        z0 = WORLD["zmax"] - row1
        blocks.append({
            "x": float(WORLD["xmin"] + col0), "y": ground, "z": float(z0),
            "w": float(col1 - col0), "h": round(float(top - ground), 4), "d": float(row1 - row0), "t": 1,
        })
    return blocks


def transform_old_collision(old_map: dict[str, object], transforms: dict[str, dict[str, object]]) -> tuple[list[dict[str, float | int]], dict[str, int]]:
    result: list[dict[str, float | int]] = []
    counts: dict[str, int] = {}
    for name, source in SOURCES.items():
        transform = transforms[name]
        sx, sy, sz = transform["scale"]
        px, py, pz = transform["position"]
        chosen = []
        for block in old_map["blocks"]:
            if block["t"] == 12 or block["y"] < -0.1:
                continue
            center_x = block["x"] + block["w"] / 2
            center_z = block["z"] + block["d"] / 2
            if not (source["x0"] - 1 <= center_x <= source["x1"] + 1 and source["z0"] - 1 <= center_z <= source["z1"] + 1):
                continue
            transformed = {
                "x": round(block["x"] * sx + px, 4),
                "y": round(block["y"] * sy + py, 4),
                "z": round(block["z"] * sz + pz, 4),
                "w": round(block["w"] * sx, 4),
                "h": round(block["h"] * sy, 4),
                "d": round(block["d"] * sz, 4),
                "t": block["t"],
            }
            chosen.append(transformed)
        result.extend(chosen)
        counts[name] = len(chosen)
    return result, counts


def boxes_overlap_2d(a: dict[str, float], b: dict[str, float]) -> bool:
    return a["x0"] < b["x1"] and a["x1"] > b["x0"] and a["z0"] < b["z1"] and a["z1"] > b["z0"]


def choose_spawns(blocks: list[dict[str, float | int]], heights: np.ndarray) -> list[list[float]]:
    preferred = [
        # All points are on the connected outdoor campus network. In
        # particular, none is inside a courtyard or reserved landmark shell.
        (-38.0, -119.0), (36.0, -155.0), (-100.0, -105.0), (66.0, -77.0),
        (-120.0, 19.0), (-6.0, 95.0), (-220.0, 179.0), (282.0, -181.0),
    ]

    def collides(x: float, y: float, z: float) -> bool:
        for block in blocks:
            if (
                x - 0.3 < block["x"] + block["w"] and x + 0.3 > block["x"]
                and y < block["y"] + block["h"] and y + 1.8 > block["y"]
                and z - 0.3 < block["z"] + block["d"] and z + 0.3 > block["z"]
            ):
                return True
        return False

    offsets = [(0, 0)]
    for radius in range(2, 82, 2):
        for dx in range(-radius, radius + 1, 2):
            offsets.extend(((dx, -radius), (dx, radius)))
        for dz in range(-radius + 2, radius - 1, 2):
            offsets.extend(((-radius, dz), (radius, dz)))

    result: list[list[float]] = []
    for preferred_x, preferred_z in preferred:
        found = None
        for dx, dz in offsets:
            x, z = preferred_x + dx, preferred_z + dz
            col = int(math.floor(x - WORLD["xmin"]))
            row = int(math.floor(WORLD["zmax"] - z))
            if not (1 <= col < heights.shape[1] - 1 and 1 <= row < heights.shape[0] - 1):
                continue
            local = heights[row - 1:row + 2, col - 1:col + 2]
            top = float(local.max())
            if top > 3.55 or float(local.max() - local.min()) > 0.51:
                continue
            y = top + 0.001
            if not collides(x, y, z):
                found = [round(x, 3), round(y, 3), round(z, 3)]
                break
        if found is None:
            raise RuntimeError(f"no safe spawn near {(preferred_x, preferred_z)}")
        result.append(found)
    return result


def placement_validation(transforms: dict[str, dict[str, object]]) -> dict[str, object]:
    buildings = []
    result_bounds: dict[str, dict[str, float]] = {}
    for name, transform in transforms.items():
        result = transform["result_bounds"]
        target = transform["target_outer_bounds"]
        in_bounds = (
            result["x0"] >= target["x0"] and result["x1"] <= target["x1"]
            and result["z0"] >= target["z0"] and result["z1"] <= target["z1"]
        )
        result_bounds[name] = result
        buildings.append({
            "name": name, "status": "pass" if in_bounds else "fail",
            "direction": "unchanged axes; no mirror; no 90-degree rotation",
            "transform": transform,
        })
    overlaps = []
    names = list(result_bounds)
    for index, left in enumerate(names):
        for right in names[index + 1:]:
            if boxes_overlap_2d(result_bounds[left], result_bounds[right]):
                overlaps.append([left, right])
    return {
        "authority": "Mineways OBJ plus iron-block scope lines",
        "coordinate_system": "X east/west, Y up, Z campus north/south; meters",
        "mirrored": False,
        "rotated_180": False,
        "buildings": buildings,
        "landmark_overlap_pairs": overlaps,
        "status": "pass" if not overlaps and all(item["status"] == "pass" for item in buildings) else "fail",
    }


def render_qa(base_preview: Path, validation: dict[str, object], output: Path) -> None:
    image = Image.open(base_preview).convert("RGBA")
    draw = ImageDraw.Draw(image, "RGBA")
    colors = {"north_admin": (66, 133, 244, 210), "activity_center": (255, 145, 48, 210), "stadium": (255, 74, 138, 210)}
    for building in validation["buildings"]:
        name = building["name"]
        result = building["transform"]["result_bounds"]
        x0 = (result["x0"] - WORLD["xmin"]) * 2
        x1 = (result["x1"] - WORLD["xmin"]) * 2
        y0 = (WORLD["zmax"] - result["z1"]) * 2
        y1 = (WORLD["zmax"] - result["z0"]) * 2
        color = colors[name]
        draw.rectangle((x0, y0, x1, y1), outline=color, width=5, fill=(*color[:3], 30))
        draw.text((x0 + 8, y0 + 8), name, fill=(255, 255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    image.convert("RGB").save(output, quality=95)


def validate_material_bundle(mtl_path: Path) -> dict[str, object]:
    references = []
    material_count = 0
    for raw in mtl_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if line.startswith("newmtl "):
            material_count += 1
        elif line.startswith("map_Kd "):
            references.append(line[7:].strip())
    missing = [reference for reference in references if not (mtl_path.parent / reference).exists()]
    return {
        "material_count": material_count,
        "map_Kd_references": len(references),
        "unique_textures": len(set(references)),
        "missing_textures": missing,
        "status": "pass" if not missing and material_count == len(references) else "fail",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--obj", required=True, type=Path)
    parser.add_argument("--mtl", required=True, type=Path)
    parser.add_argument("--old-map", required=True, type=Path)
    parser.add_argument("--preview", required=True, type=Path)
    parser.add_argument("--map-output", required=True, type=Path)
    parser.add_argument("--validation-output", required=True, type=Path)
    parser.add_argument("--qa-output", required=True, type=Path)
    args = parser.parse_args()

    mc_blocks, spawn_heights, collision_stats, vertices, triangles = parse_obj_collision_surfaces(args.obj)
    transforms = {name: target_transform(name) for name in TARGETS}
    old_map = json.loads(args.old_map.read_text(encoding="utf-8"))
    landmark_blocks, landmark_collision_counts = transform_old_collision(old_map, transforms)
    ground = {
        "x": float(WORLD["xmin"]), "y": -1.0, "z": float(WORLD["zmin"]),
        "w": float(WORLD["xmax"] - WORLD["xmin"]), "h": 4.0,
        "d": float(WORLD["zmax"] - WORLD["zmin"]), "t": 0,
    }
    collision_blocks = [ground, *mc_blocks, *landmark_blocks]
    spawns = choose_spawns(collision_blocks, spawn_heights)
    map_data = {
        "size": [float(WORLD["xmax"] - WORLD["xmin"]), float(WORLD["zmax"] - WORLD["zmin"])],
        "origin": [float(WORLD["xmin"]), float(WORLD["zmin"])],
        "blocks": collision_blocks,
        "spawns": spawns,
    }
    args.map_output.write_text(json.dumps(map_data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    validation = placement_validation(transforms)
    material_validation = validate_material_bundle(args.mtl)
    validation.update({
        "source_obj": {"vertices": vertices, "triangles": triangles},
        "mc_collision_boxes": len(mc_blocks),
        "landmark_collision_boxes": landmark_collision_counts,
        "total_collision_boxes": len(map_data["blocks"]),
        "spawn_surface_min_max": [float(spawn_heights.min()), float(spawn_heights.max())],
        "collision_generation": {
            "mode": "thin surface shells; no roof-to-ground columns",
            "surface_thickness": SURFACE_THICKNESS,
            "vertical_cell": VERTICAL_CELL,
            **collision_stats,
        },
        "material_bundle": material_validation,
    })
    if material_validation["status"] != "pass":
        validation["status"] = "fail"
    args.validation_output.write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    render_qa(args.preview, validation, args.qa_output)
    print(json.dumps({
        "status": validation["status"], "mc_collision_boxes": len(mc_blocks),
        "landmark_collision_boxes": landmark_collision_counts,
        "total_collision_boxes": len(map_data["blocks"]),
        "map_output": str(args.map_output), "qa_output": str(args.qa_output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

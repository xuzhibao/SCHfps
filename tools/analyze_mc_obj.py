#!/usr/bin/env python3
"""Analyze and render a Mineways OBJ without third-party mesh dependencies."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageStat


def parse_mtl(path: Path) -> dict[str, dict[str, object]]:
    materials: dict[str, dict[str, object]] = {}
    current: dict[str, object] | None = None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0] == "newmtl":
            current = materials.setdefault(" ".join(parts[1:]), {})
        elif current is not None and parts[0] == "Kd" and len(parts) >= 4:
            current["kd"] = tuple(float(value) for value in parts[1:4])
        elif current is not None and parts[0] == "map_Kd" and len(parts) >= 2:
            current["texture"] = " ".join(parts[1:])
    return materials


def material_color(material: str, material_data: dict[str, dict[str, object]], root: Path) -> tuple[int, int, int, int]:
    data = material_data.get(material, {})
    texture = data.get("texture")
    if isinstance(texture, str):
        texture_path = root / texture
        if texture_path.exists():
            with Image.open(texture_path) as source:
                rgba = source.convert("RGBA")
                stat = ImageStat.Stat(rgba)
                return tuple(int(value) for value in stat.mean[:4])
    kd = data.get("kd", (0.65, 0.65, 0.65))
    return tuple(int(float(value) * 255) for value in kd[:3]) + (255,)


def analyze(obj_path: Path, mtl_path: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    materials = parse_mtl(mtl_path)
    vertices: list[tuple[float, float, float]] = []
    top_faces: list[tuple[float, str, list[int]]] = []
    face_counts: Counter[str] = Counter()
    top_counts: Counter[str] = Counter()
    elevations: Counter[int] = Counter()
    current_material = "__none__"

    with obj_path.open("r", encoding="utf-8", errors="replace") as source:
        for raw in source:
            if raw.startswith("v "):
                _, x, y, z = raw.split()[:4]
                vertices.append((float(x), float(y), float(z)))
            elif raw.startswith("usemtl "):
                current_material = raw.strip()[7:]
            elif raw.startswith("f "):
                refs = raw.split()[1:]
                face_counts[current_material] += max(1, len(refs) - 2)
                parsed = [ref.split("/") for ref in refs]
                normal_indices = {int(ref[2]) for ref in parsed if len(ref) >= 3 and ref[2]}
                if normal_indices != {5}:
                    continue
                indices = [int(ref[0]) - 1 for ref in parsed]
                y = max(vertices[index][1] for index in indices)
                top_faces.append((y, current_material, indices))
                top_counts[current_material] += max(1, len(indices) - 2)
                elevations[int(round(y))] += 1

    vertex_array = np.asarray(vertices, dtype=np.float32)
    mins = vertex_array.min(axis=0)
    maxs = vertex_array.max(axis=0)
    width = int(round(maxs[0] - mins[0])) + 1
    height = int(round(maxs[2] - mins[2])) + 1
    scale = max(1, min(3, 2400 // max(width, height)))
    canvas = Image.new("RGBA", (width * scale, height * scale), (32, 38, 39, 255))
    draw = ImageDraw.Draw(canvas, "RGBA")
    colors = {name: material_color(name, materials, mtl_path.parent) for name in set(face_counts)}
    top_faces.sort(key=lambda item: item[0])
    for y, material, indices in top_faces:
        points = [
            ((vertices[index][0] - mins[0]) * scale, (maxs[2] - vertices[index][2]) * scale)
            for index in indices
        ]
        draw.polygon(points, fill=colors.get(material, (160, 160, 160, 255)))
    preview_path = output_dir / "mc_obj_topdown.png"
    canvas.convert("RGB").save(preview_path, quality=95)

    summary = {
        "obj": str(obj_path),
        "mtl": str(mtl_path),
        "vertex_count": len(vertices),
        "triangle_count": sum(face_counts.values()),
        "bounds": {"min": mins.tolist(), "max": maxs.tolist()},
        "render_scale_px_per_meter": scale,
        "materials": {
            name: {"triangles": count, "top_triangles": top_counts[name], "color": colors[name]}
            for name, count in face_counts.most_common()
        },
        "top_face_elevations": dict(sorted(elevations.items())),
        "topdown": str(preview_path),
    }
    (output_dir / "mc_obj_analysis.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in summary.items() if key != "materials"}, ensure_ascii=False, indent=2))
    print("materials", len(face_counts), "top_faces", len(top_faces))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("obj", type=Path)
    parser.add_argument("mtl", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    analyze(args.obj, args.mtl, args.output)


if __name__ == "__main__":
    main()

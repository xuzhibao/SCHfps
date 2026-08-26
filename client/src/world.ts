import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { MapData } from './constants.js';

export type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/**
 * PixelStrike world adapter for the SJZU campus.
 *
 * The original project generates a voxel scene from map.json. The campus uses
 * the same AABB map contract for movement and server hit validation. The new
 * authoritative visual base is the user's Mineways OBJ/MTL/tex export. Only
 * the three unfinished landmarks are taken from the earlier v007 GLB and are
 * transformed into the iron-block scope lines measured from the MC world.
 */
export class WorldView {
  group = new THREE.Group();
  clouds = new THREE.Group();
  sun = new THREE.Group();
  boxes: Box[] = [];
  private spatial = new Map<string, Box[]>();
  private readonly spatialCell = 16;
  private pickups = new Map<number, THREE.Group>();
  private pickupTemplates: THREE.Group[];

  constructor(scene: THREE.Scene, map: MapData) {
    this.pickupTemplates = [this.createPickup(0), this.createPickup(1), this.createPickup(2)];
    for (const b of map.blocks) {
      if (b.t !== 12) {
        const box = { x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h, z0: b.z, z1: b.z + b.d };
        this.boxes.push(box);
        this.indexBox(box);
      }
    }
    scene.add(this.group, this.clouds, this.sun);
    this.setupLighting();
    this.loadMinecraftCampus();
    this.loadReservedLandmarks();
  }

  private spatialKey(x: number, z: number) { return `${x},${z}`; }

  private indexBox(box: Box) {
    const x0 = Math.floor(box.x0 / this.spatialCell);
    const x1 = Math.floor((box.x1 - 1e-6) / this.spatialCell);
    const z0 = Math.floor(box.z0 / this.spatialCell);
    const z1 = Math.floor((box.z1 - 1e-6) / this.spatialCell);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = this.spatialKey(x, z);
      const cell = this.spatial.get(key);
      if (cell) cell.push(box);
      else this.spatial.set(key, [box]);
    }
  }

  queryBoxes(x: number, z: number, radius = 2.5) {
    const x0 = Math.floor((x - radius) / this.spatialCell);
    const x1 = Math.floor((x + radius) / this.spatialCell);
    const z0 = Math.floor((z - radius) / this.spatialCell);
    const z1 = Math.floor((z + radius) / this.spatialCell);
    const result: Box[] = [];
    const seen = new Set<Box>();
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      for (const box of this.spatial.get(this.spatialKey(cx, cz)) ?? []) {
        if (seen.has(box)) continue;
        seen.add(box);
        result.push(box);
      }
    }
    return result;
  }

  private loadMinecraftCampus() {
    const base = `${import.meta.env.BASE_URL}assets/mcmap/`;
    const mtlLoader = new MTLLoader().setPath(base).setResourcePath(base);
    mtlLoader.load('mcmap.mtl', (materials) => {
      materials.preload();
      new OBJLoader().setMaterials(materials).setPath(base).load('campus_mc.obj', (campus) => {
        campus.name = 'SJZU_MC_AUTHORITATIVE_BASE';
        let meshCount = 0;
        let triangleCount = 0;
        campus.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          meshCount++;
          triangleCount += obj.geometry.index ? obj.geometry.index.count / 3 : obj.geometry.attributes.position.count / 3;
          obj.frustumCulled = true;
          obj.castShadow = false;
          obj.receiveShadow = true;
          const list = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const raw of list) {
            const material = raw as THREE.MeshPhongMaterial;
            if (material.map) {
              material.map.colorSpace = THREE.SRGBColorSpace;
              material.map.magFilter = THREE.NearestFilter;
              material.map.minFilter = THREE.NearestMipmapLinearFilter;
              material.map.generateMipmaps = true;
              material.map.needsUpdate = true;
            }
            material.side = material.transparent ? THREE.DoubleSide : THREE.FrontSide;
            material.needsUpdate = true;
          }
        });
        this.group.add(campus);
        console.info(`[SJZU] MC base loaded: ${meshCount} meshes, ${Math.round(triangleCount)} triangles`);
      }, (event) => {
        if (event.total > 0) console.info(`[SJZU] MC base ${Math.round(event.loaded / event.total * 100)}%`);
      }, (error) => console.error('[SJZU] authoritative MC OBJ failed to load', error));
    }, undefined, (error) => console.error('[SJZU] Mineways MTL failed to load', error));
  }

  private loadReservedLandmarks() {
    const placements = {
      north_admin: {
        scale: [1.2137800448491727, 1, 1.2501664182569756],
        position: [42.399983007079356, 3, -55.88824632499785],
        target: [158, 246, -360, -279],
      },
      activity_center: {
        scale: [0.86067811194241, 1, 1.1347660555893646],
        position: [81.62699539776894, 3, -76.6175909749132],
        target: [158, 241, -174, 59],
      },
      stadium: {
        scale: [1.1830007699921363, 1, 1.4021600211966174],
        position: [27.19512704870249, 3, -46.958809844047664],
        target: [-170, -7, 107, 333],
      },
    } as const;
    new GLTFLoader().load(`${import.meta.env.BASE_URL}assets/SJZU_Campus_Master_v007_Textured.glb`, (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const landmarkRoot = new THREE.Group();
      landmarkRoot.name = 'SJZU_RESERVED_LANDMARKS';
      for (const [name, placement] of Object.entries(placements)) {
        const selected: THREE.Object3D[] = [];
        gltf.scene.traverse((obj) => {
          if (!obj.name.startsWith(`${name}__`)) return;
          if (obj.parent && obj.parent.name.startsWith(`${name}__`)) return;
          selected.push(obj);
        });
        const building = new THREE.Group();
        building.name = `MC_PLACED__${name}`;
        for (const obj of selected) {
          const worldMatrix = obj.matrixWorld.clone();
          building.add(obj);
          worldMatrix.decompose(obj.position, obj.quaternion, obj.scale);
        }
        building.scale.set(placement.scale[0], placement.scale[1], placement.scale[2]);
        building.position.set(placement.position[0], placement.position[1], placement.position[2]);
        landmarkRoot.add(building);
        building.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(building);
        const [x0, x1, z0, z1] = placement.target;
        const inside = bounds.min.x >= x0 - 0.01 && bounds.max.x <= x1 + 0.01 && bounds.min.z >= z0 - 0.01 && bounds.max.z <= z1 + 0.01;
        console.info(`[SJZU] ${name} placed ${inside ? 'inside' : 'OUTSIDE'} MC scope`, bounds.min.toArray(), bounds.max.toArray());
      }
      landmarkRoot.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.frustumCulled = true;
        obj.castShadow = false;
        obj.receiveShadow = true;
      });
      this.group.add(landmarkRoot);
      const atlasUrl = `${import.meta.env.BASE_URL}assets/SJZU_Campus_Material_Atlas_v001.png`;
      new THREE.TextureLoader().load(atlasUrl, (atlas) => {
        atlas.colorSpace = THREE.SRGBColorSpace;
        this.applyMaterialAtlas(landmarkRoot, atlas);
      }, undefined, (error) => console.error(`[SJZU] material atlas failed to load: ${atlasUrl}`, error));
    }, undefined, (error) => console.error('[SJZU] campus GLB failed to load', error));
  }

  private applyMaterialAtlas(campus: THREE.Object3D, atlas: THREE.Texture) {
    // Atlas rows are: architectural walls, glass/metal, brick/roof, seats/paving.
    // UVs in the v007 GLB are normalized per primitive, so each semantic
    // material can safely address one inset quadrant without changing geometry.
    const tiles: Record<string, [number, number]> = {
      road: [3, 3], plaza: [1, 0], paving: [3, 3], brick: [0, 2],
      whitewall: [0, 0], concrete: [2, 0], glass: [0, 1], roof: [2, 1],
      metal: [3, 2], accent_blue: [3, 1], signage: [0, 0],
      seat_blue: [0, 3], seat_yellow: [1, 3], seat_red: [2, 3],
    };
    const inset = 0.006;
    let mapped = 0;
    const seen = new Set<THREE.Material>();
    campus.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const raw of materials) {
        if (seen.has(raw)) continue;
        seen.add(raw);
        const material = raw as THREE.MeshStandardMaterial;
        let key = (material.name || '').toLowerCase();
        if (!tiles[key]) {
          const meshName = obj.name.toLowerCase();
          key = Object.keys(tiles).find((candidate) => meshName.includes(`__${candidate}`) || meshName.endsWith(candidate)) ?? '';
        }
        const tile = tiles[key];
        if (!tile) continue;
        const map = atlas.clone();
        map.colorSpace = THREE.SRGBColorSpace;
        map.wrapS = THREE.ClampToEdgeWrapping;
        map.wrapT = THREE.ClampToEdgeWrapping;
        map.repeat.set(0.25 - inset * 2, 0.25 - inset * 2);
        map.offset.set(tile[0] * 0.25 + inset, 1 - (tile[1] + 1) * 0.25 + inset);
        map.needsUpdate = true;
        material.map = map;
        material.color.set(0xffffff);
        if (key === 'glass') {
          material.metalness = 0.35;
          material.roughness = 0.18;
          material.transparent = true;
          material.opacity = 0.82;
        } else if (key === 'metal' || key === 'roof' || key === 'accent_blue') {
          material.metalness = 0.55;
          material.roughness = 0.38;
        } else {
          material.roughness = 0.72;
        }
        material.needsUpdate = true;
        mapped++;
      }
    });
    console.info(`[SJZU] material atlas applied to ${mapped} mesh materials`);
  }

  private setupLighting() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1250, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x7f9ba5, side: THREE.BackSide, fog: false }),
    );
    this.group.add(sky);
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xd8e4e5, transparent: true, opacity: 0.18, depthWrite: false });
    for (let i = 0; i < 16; i++) {
      const cloud = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 1), cloudMat);
      const a = i / 16 * Math.PI * 2;
      cloud.scale.set(16 + (i % 4) * 5, 3, 10 + (i % 3) * 4);
      cloud.position.set(Math.cos(a) * 480, 74 + (i % 3) * 7, Math.sin(a) * 480);
      this.clouds.add(cloud);
    }
  }

  private createPickup(kind: number) {
    const group = new THREE.Group();
    const colors = [0xe4a94a, 0xd94c4c, 0x35c9e8];
    const color = colors[kind] ?? colors[0];
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.36, 0.52), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.65 }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.68, 12, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false }));
    group.add(core, glow);
    return group;
  }

  setPickup(id: number, kind: number, x: number, y: number, z: number) {
    this.removePickup(id);
    const pickup = (this.pickupTemplates[kind] ?? this.pickupTemplates[0]).clone();
    pickup.position.set(x, y + 0.48, z);
    pickup.userData.baseY = pickup.position.y;
    this.pickups.set(id, pickup);
    this.group.add(pickup);
  }

  removePickup(id: number) {
    const pickup = this.pickups.get(id);
    if (!pickup) return;
    this.group.remove(pickup);
    this.pickups.delete(id);
  }

  raycastDistance(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) {
    let best = maxDist;
    const candidates: Box[] = [];
    const seen = new Set<Box>();
    const horizontal = Math.hypot(dir.x, dir.z);
    if (horizontal < 1e-8) {
      for (const box of this.queryBoxes(origin.x, origin.z, 0.5)) { seen.add(box); candidates.push(box); }
    } else {
      let cx = Math.floor(origin.x / this.spatialCell);
      let cz = Math.floor(origin.z / this.spatialCell);
      const stepX = Math.sign(dir.x);
      const stepZ = Math.sign(dir.z);
      const deltaX = Math.abs(dir.x) < 1e-9 ? Infinity : this.spatialCell / Math.abs(dir.x);
      const deltaZ = Math.abs(dir.z) < 1e-9 ? Infinity : this.spatialCell / Math.abs(dir.z);
      const boundaryX = stepX > 0 ? (cx + 1) * this.spatialCell : cx * this.spatialCell;
      const boundaryZ = stepZ > 0 ? (cz + 1) * this.spatialCell : cz * this.spatialCell;
      let nextX = Math.abs(dir.x) < 1e-9 ? Infinity : (boundaryX - origin.x) / dir.x;
      let nextZ = Math.abs(dir.z) < 1e-9 ? Infinity : (boundaryZ - origin.z) / dir.z;
      let travel = 0;
      while (travel <= best) {
        for (const box of this.spatial.get(this.spatialKey(cx, cz)) ?? []) {
          if (seen.has(box)) continue;
          seen.add(box);
          candidates.push(box);
        }
        if (nextX < nextZ) {
          travel = nextX;
          nextX += deltaX;
          cx += stepX;
        } else {
          travel = nextZ;
          nextZ += deltaZ;
          cz += stepZ;
        }
        if (!Number.isFinite(travel) || travel > maxDist) break;
      }
    }
    for (const b of candidates) {
      let tmin = 0; let tmax = best;
      const axis = (o: number, d: number, lo: number, hi: number) => {
        if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
        let t1 = (lo - o) / d; let t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        return tmin <= tmax;
      };
      if (!axis(origin.x, dir.x, b.x0, b.x1) || !axis(origin.y, dir.y, b.y0, b.y1) || !axis(origin.z, dir.z, b.z0, b.z1)) continue;
      if (tmin > 0 && tmin < best) best = tmin;
    }
    return best;
  }

  animate(t: number) {
    if (this.clouds.visible) this.clouds.position.x = (t * 0.0018) % 48;
    for (const [id, pickup] of this.pickups) {
      pickup.rotation.y = t * 0.0018 + id;
      pickup.position.y = pickup.userData.baseY + Math.sin(t * 0.003 + id) * 0.08;
    }
  }
}

const PH = 0.3;
const SU = 0.55;
const EPS = 0.001;

function overlaps(px: number, py: number, pz: number, b: Box, height: number) {
  return px - PH < b.x1 && px + PH > b.x0 && py < b.y1 && py + height > b.y0 && pz - PH < b.z1 && pz + PH > b.z0;
}

export function canOccupy(boxes: Box[], pos: THREE.Vector3, height: number) {
  return !boxes.some((b) => overlaps(pos.x, pos.y, pos.z, b, height));
}

function stepBlocked(boxes: Box[], px: number, newFeet: number, pz: number, height: number) {
  return boxes.some((b) => overlaps(px, newFeet + EPS, pz, b, height));
}

export function moveAABB(pos: THREE.Vector3, vel: THREE.Vector3, dt: number, boxes: Box[], height = 1.8, canStep = true) {
  let grounded = depenetrate(pos, vel, boxes, height);
  const dx = vel.x * dt;
  if (dx !== 0) {
    const start = pos.x; let next = start + dx; let blocked = false;
    for (const b of boxes) {
      if (pos.y >= b.y1 || pos.y + height <= b.y0 || pos.z - PH >= b.z1 || pos.z + PH <= b.z0) continue;
      const crossed = dx > 0 ? start + PH <= b.x0 + EPS && next + PH > b.x0 : start - PH >= b.x1 - EPS && next - PH < b.x1;
      if (!crossed) continue;
      const stepH = b.y1 - pos.y;
      if (canStep && stepH > 0 && stepH <= SU && !stepBlocked(boxes, next, b.y1, pos.z, height)) { pos.y = b.y1 + EPS; grounded = true; continue; }
      next = dx > 0 ? Math.min(next, b.x0 - PH - EPS) : Math.max(next, b.x1 + PH + EPS); blocked = true;
    }
    pos.x = next; if (blocked) vel.x = 0;
  }
  const dz = vel.z * dt;
  if (dz !== 0) {
    const start = pos.z; let next = start + dz; let blocked = false;
    for (const b of boxes) {
      if (pos.y >= b.y1 || pos.y + height <= b.y0 || pos.x - PH >= b.x1 || pos.x + PH <= b.x0) continue;
      const crossed = dz > 0 ? start + PH <= b.z0 + EPS && next + PH > b.z0 : start - PH >= b.z1 - EPS && next - PH < b.z1;
      if (!crossed) continue;
      const stepH = b.y1 - pos.y;
      if (canStep && stepH > 0 && stepH <= SU && !stepBlocked(boxes, pos.x, b.y1, next, height)) { pos.y = b.y1 + EPS; grounded = true; continue; }
      next = dz > 0 ? Math.min(next, b.z0 - PH - EPS) : Math.max(next, b.z1 + PH + EPS); blocked = true;
    }
    pos.z = next; if (blocked) vel.z = 0;
  }
  const dy = vel.y * dt;
  if (dy !== 0) {
    const start = pos.y; let next = start + dy;
    for (const b of boxes) {
      if (pos.x - PH >= b.x1 || pos.x + PH <= b.x0 || pos.z - PH >= b.z1 || pos.z + PH <= b.z0) continue;
      if (dy < 0 && start >= b.y1 - EPS && next < b.y1) { next = Math.max(next, b.y1 + EPS); vel.y = 0; grounded = true; }
      else if (dy > 0 && start + height <= b.y0 + EPS && next + height > b.y0) { next = Math.min(next, b.y0 - height - EPS); vel.y = 0; }
    }
    pos.y = next;
  }
  return depenetrate(pos, vel, boxes, height) || grounded;
}

function depenetrate(pos: THREE.Vector3, vel: THREE.Vector3, boxes: Box[], height: number) {
  let grounded = false;
  for (let pass = 0; pass < 6; pass++) {
    let found = false;
    for (const b of boxes) {
      if (!overlaps(pos.x, pos.y, pos.z, b, height)) continue;
      found = true;
      const candidates = [
        [b.x0 - PH - EPS - pos.x, 0], [b.x1 + PH + EPS - pos.x, 0],
        [b.y0 - height - EPS - pos.y, 1], [b.y1 + EPS - pos.y, 1],
        [b.z0 - PH - EPS - pos.z, 2], [b.z1 + PH + EPS - pos.z, 2],
      ];
      candidates.sort((a, c) => Math.abs(a[0]) - Math.abs(c[0]));
      const [delta, axis] = candidates[0];
      if (axis === 0) { pos.x += delta; vel.x = 0; }
      else if (axis === 1) { pos.y += delta; vel.y = 0; grounded ||= delta > 0; }
      else { pos.z += delta; vel.z = 0; }
      break;
    }
    if (!found) break;
  }
  return grounded;
}

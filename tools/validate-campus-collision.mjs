import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '../map.json');
const validationPath = path.resolve(path.dirname(mapPath), 'MC_CAMPUS_VALIDATION.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const boxes = map.blocks;
const PH = 0.3;
const HEIGHT = 1.8;
const GRID = 2;

function overlapsSpawn([x, y, z], b) {
  return x - PH < b.x + b.w && x + PH > b.x &&
    y < b.y + b.h && y + HEIGHT > b.y &&
    z - PH < b.z + b.d && z + PH > b.z;
}

const ground = boxes.find((b) => b.t === 0 && b.w >= map.size[0] && b.d >= map.size[1]);
if (!ground) throw new Error('missing campus ground collision');

for (const [index, spawn] of map.spawns.entries()) {
  const hit = boxes.find((b) => b.t !== 12 && overlapsSpawn(spawn, b));
  if (hit) throw new Error(`spawn ${index} intersects collision block ${JSON.stringify(hit)}`);
}

// Ground-level navigation flood: every deployment point must connect to the
// same outdoor campus network. This specifically catches sealed courtyards and
// invisible walls stretched across visible openings.
const [originX, originZ] = map.origin ?? [-map.size[0] / 2, -map.size[1] / 2];
const cols = Math.floor(map.size[0] / GRID);
const rows = Math.floor(map.size[1] / GRID);
const cellSize = 16;
const spatial = new Map();
const collisionBoxes = boxes.filter((b) => b.t !== 0 && b.t !== 12 && b.y < 3.001 + HEIGHT && b.y + b.h > 3.001);
const key = (x, z) => `${x},${z}`;
for (const b of collisionBoxes) {
  const x0 = Math.floor(b.x / cellSize), x1 = Math.floor((b.x + b.w - 1e-6) / cellSize);
  const z0 = Math.floor(b.z / cellSize), z1 = Math.floor((b.z + b.d - 1e-6) / cellSize);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const list = spatial.get(key(x, z));
    if (list) list.push(b); else spatial.set(key(x, z), [b]);
  }
}
function blocked(col, row) {
  const x = originX + (col + 0.5) * GRID;
  const z = originZ + (row + 0.5) * GRID;
  for (const b of spatial.get(key(Math.floor(x / cellSize), Math.floor(z / cellSize))) ?? []) {
    if (x - PH < b.x + b.w && x + PH > b.x && z - PH < b.z + b.d && z + PH > b.z) return true;
  }
  return false;
}
const startCol = Math.max(0, Math.min(cols - 1, Math.floor((map.spawns[0][0] - originX) / GRID)));
const startRow = Math.max(0, Math.min(rows - 1, Math.floor((map.spawns[0][2] - originZ) / GRID)));
if (blocked(startCol, startRow)) throw new Error('spawn 0 navigation cell is blocked');
const visited = new Uint8Array(cols * rows);
const queue = new Int32Array(cols * rows);
let head = 0, tail = 0;
const startIndex = startRow * cols + startCol;
visited[startIndex] = 1;
queue[tail++] = startIndex;
while (head < tail) {
  const index = queue[head++];
  const col = index % cols, row = Math.floor(index / cols);
  for (const [nextCol, nextRow] of [[col - 1, row], [col + 1, row], [col, row - 1], [col, row + 1]]) {
    if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) continue;
    const next = nextRow * cols + nextCol;
    if (visited[next] || blocked(nextCol, nextRow)) continue;
    visited[next] = 1;
    queue[tail++] = next;
  }
}
for (const [index, spawn] of map.spawns.entries()) {
  const col = Math.max(0, Math.min(cols - 1, Math.floor((spawn[0] - originX) / GRID)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((spawn[2] - originZ) / GRID)));
  if (!visited[row * cols + col]) throw new Error(`spawn ${index} is sealed from the outdoor navigation network`);
}
if (tail < cols * rows * 0.35) throw new Error(`outdoor navigation network is unexpectedly small: ${tail} cells`);

const stairs = boxes.filter((b) => b.t === 2);
if (fs.existsSync(validationPath)) {
  const validation = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
  if (validation.status !== 'pass') throw new Error('landmark placement validation failed');
  if (validation.landmark_overlap_pairs?.length) throw new Error(`landmark overlap: ${JSON.stringify(validation.landmark_overlap_pairs)}`);
  if (validation.collision_generation?.mode !== 'thin surface shells; no roof-to-ground columns') {
    throw new Error('legacy roof-to-ground collision columns are still enabled');
  }
  for (const building of validation.buildings) {
    if (building.status !== 'pass') throw new Error(`${building.name} exceeds its MC scope line`);
    if (building.transform.rotation_y_degrees !== 0) throw new Error(`${building.name} has unexpected rotation`);
    const clearances = Object.values(building.transform.clearance);
    if (clearances.some((value) => value < 1)) throw new Error(`${building.name} lacks footprint clearance`);
  }
}

if (boxes.length < 1000) throw new Error(`MC collision is unexpectedly sparse: ${boxes.length}`);
if (stairs.length < 20) throw new Error(`rough landmark stairs missing: ${stairs.length}`);

console.log(JSON.stringify({
  ok: true,
  map: mapPath,
  blocks: boxes.length,
  stairBlocks: stairs.length,
  spawns: map.spawns.length,
  reachableOutdoorCells: tail,
  placementValidation: fs.existsSync(validationPath) ? 'pass' : 'not-found',
}));

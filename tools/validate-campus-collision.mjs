import fs from 'node:fs';

const map = JSON.parse(fs.readFileSync(new URL('../map.json', import.meta.url), 'utf8'));
const boxes = map.blocks;
const PH = 0.3;
const HEIGHT = 1.8;

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

const stairs = boxes.filter((b) => b.t === 2);
const regions = {
  library: stairs.filter((b) => b.x < -105 && b.z > -150 && b.z < -121),
  activity: stairs.filter((b) => b.x > 110 && b.x < 158 && b.z > -86 && b.z < 33),
  stadiumCentral: stairs.filter((b) => b.x > -138 && b.x < -128 && ((b.z > 200 && b.z < 212) || (b.z > 169 && b.z < 181))),
  stadiumSides: stairs.filter((b) => b.x > -151 && b.x < -136 && ((b.z > 123 && b.z < 129) || (b.z > 252 && b.z < 257))),
};
for (const [name, region] of Object.entries(regions)) {
  if (region.length < 2) throw new Error(`missing refined stair collision region: ${name}`);
}

// The collision map must not regress to full solid building volumes.
const suspicious = boxes.filter((b) => b.t !== 0 && b.w > 40 && b.d > 40 && b.h > 15);
if (suspicious.length) throw new Error(`solid building AABB regression: ${suspicious.length} blocks`);

console.log(JSON.stringify({ ok: true, blocks: boxes.length, stairBlocks: stairs.length, stairRegions: Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, v.length])) }));

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
)

type Vec3 struct{ X, Y, Z float64 }

type AABB struct {
	Min, Max Vec3
}

// World is the static map: AABB list plus spawn points.
type World struct {
	rawJSON  []byte // original file bytes served by /map.json
	Revision uint32
	Size     [2]float64   `json:"size"`
	Blocks   []MapBlock   `json:"blocks"`
	Spawns   [][3]float64 `json:"spawns"`

	aabbs  []AABB
	spatial map[gridKey][]int
}

type gridKey struct{ X, Z int }

const spatialCell = 16.0

type MapBlock struct {
	X, Y, Z float64
	W, H, D float64
	T       int
}

func LoadWorld(path string) (*World, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	w := &World{}
	if err := json.Unmarshal(data, w); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	w.aabbs = make([]AABB, 0, len(w.Blocks))
	for _, b := range w.Blocks {
		if b.T == 12 { // water is visual, not a wall or bullet shield
			continue
		}
		w.aabbs = append(w.aabbs, AABB{
			Min: Vec3{b.X, b.Y, b.Z},
			Max: Vec3{b.X + b.W, b.Y + b.H, b.Z + b.D},
		})
	}
	w.buildSpatialIndex()
	w.rawJSON = data
	hash := sha256.Sum256(data)
	w.Revision = binary.LittleEndian.Uint32(hash[:4])
	if len(w.Spawns) == 0 {
		return nil, fmt.Errorf("map has no spawns")
	}
	return w, nil
}

func spatialCoord(value float64) int { return int(math.Floor(value / spatialCell)) }

func (w *World) buildSpatialIndex() {
	w.spatial = make(map[gridKey][]int)
	for index, box := range w.aabbs {
		x0, x1 := spatialCoord(box.Min.X), spatialCoord(box.Max.X-Epsilon)
		z0, z1 := spatialCoord(box.Min.Z), spatialCoord(box.Max.Z-Epsilon)
		for x := x0; x <= x1; x++ {
			for z := z0; z <= z1; z++ {
				key := gridKey{x, z}
				w.spatial[key] = append(w.spatial[key], index)
			}
		}
	}
}

func (w *World) nearby(minX, maxX, minZ, maxZ float64) []AABB {
	// Unit tests and small synthetic worlds may be constructed directly instead
	// of through LoadWorld. Keep that path correct while production worlds use
	// the spatial broad phase.
	if w.spatial == nil {
		return w.aabbs
	}
	seen := make(map[int]struct{})
	result := make([]AABB, 0, 64)
	for x := spatialCoord(minX); x <= spatialCoord(maxX); x++ {
		for z := spatialCoord(minZ); z <= spatialCoord(maxZ); z++ {
			for _, index := range w.spatial[gridKey{x, z}] {
				if _, ok := seen[index]; ok {
					continue
				}
				seen[index] = struct{}{}
				result = append(result, w.aabbs[index])
			}
		}
	}
	return result
}

const (
	PlayerHalf = 0.3
	StepUp     = 0.55
	Epsilon    = 0.001
)

// MoveAABB uses swept axis tests so frame stalls and corrections cannot cross walls.
func (w *World) MoveAABB(pos *Vec3, vel *Vec3, dt, height float64, canStep bool) bool {
	grounded := w.depenetrate(pos, vel, height)
	reachX := math.Abs(vel.X*dt) + PlayerHalf + 1
	reachZ := math.Abs(vel.Z*dt) + PlayerHalf + 1
	candidates := w.nearby(pos.X-reachX, pos.X+reachX, pos.Z-reachZ, pos.Z+reachZ)

	dx := vel.X * dt
	if dx != 0 {
		startX, nextX, blocked := pos.X, pos.X+dx, false
		for _, b := range candidates {
			if pos.Y >= b.Max.Y || pos.Y+height <= b.Min.Y || pos.Z-PlayerHalf >= b.Max.Z || pos.Z+PlayerHalf <= b.Min.Z {
				continue
			}
			crossed := dx > 0 && startX+PlayerHalf <= b.Min.X+Epsilon && nextX+PlayerHalf > b.Min.X ||
				dx < 0 && startX-PlayerHalf >= b.Max.X-Epsilon && nextX-PlayerHalf < b.Max.X
			if !crossed {
				continue
			}
			stepH := b.Max.Y - pos.Y
			if canStep && stepH > 0 && stepH <= StepUp && !stepBlocked(w, Vec3{nextX, pos.Y, pos.Z}, b.Max.Y, height) {
				pos.Y = b.Max.Y + Epsilon
				grounded = true
				continue
			}
			if dx > 0 {
				nextX = math.Min(nextX, b.Min.X-PlayerHalf-Epsilon)
			} else {
				nextX = math.Max(nextX, b.Max.X+PlayerHalf+Epsilon)
			}
			blocked = true
		}
		pos.X = nextX
		if blocked {
			vel.X = 0
		}
	}

	dz := vel.Z * dt
	if dz != 0 {
		startZ, nextZ, blocked := pos.Z, pos.Z+dz, false
		for _, b := range candidates {
			if pos.Y >= b.Max.Y || pos.Y+height <= b.Min.Y || pos.X-PlayerHalf >= b.Max.X || pos.X+PlayerHalf <= b.Min.X {
				continue
			}
			crossed := dz > 0 && startZ+PlayerHalf <= b.Min.Z+Epsilon && nextZ+PlayerHalf > b.Min.Z ||
				dz < 0 && startZ-PlayerHalf >= b.Max.Z-Epsilon && nextZ-PlayerHalf < b.Max.Z
			if !crossed {
				continue
			}
			stepH := b.Max.Y - pos.Y
			if canStep && stepH > 0 && stepH <= StepUp && !stepBlocked(w, Vec3{pos.X, pos.Y, nextZ}, b.Max.Y, height) {
				pos.Y = b.Max.Y + Epsilon
				grounded = true
				continue
			}
			if dz > 0 {
				nextZ = math.Min(nextZ, b.Min.Z-PlayerHalf-Epsilon)
			} else {
				nextZ = math.Max(nextZ, b.Max.Z+PlayerHalf+Epsilon)
			}
			blocked = true
		}
		pos.Z = nextZ
		if blocked {
			vel.Z = 0
		}
	}

	dy := vel.Y * dt
	if dy != 0 {
		startY, nextY := pos.Y, pos.Y+dy
		for _, b := range candidates {
			if pos.X-PlayerHalf >= b.Max.X || pos.X+PlayerHalf <= b.Min.X || pos.Z-PlayerHalf >= b.Max.Z || pos.Z+PlayerHalf <= b.Min.Z {
				continue
			}
			if dy < 0 && startY >= b.Max.Y-Epsilon && nextY < b.Max.Y {
				nextY = math.Max(nextY, b.Max.Y+Epsilon)
				vel.Y, grounded = 0, true
			} else if dy > 0 && startY+height <= b.Min.Y+Epsilon && nextY+height > b.Min.Y {
				nextY = math.Min(nextY, b.Min.Y-height-Epsilon)
				vel.Y = 0
			}
		}
		pos.Y = nextY
	}
	grounded = w.depenetrate(pos, vel, height) || grounded
	return grounded
}

func (w *World) CanOccupy(pos Vec3, height float64) bool {
	box := playerBox(pos, height)
	for _, b := range w.nearby(box.Min.X, box.Max.X, box.Min.Z, box.Max.Z) {
		if intersects(box, b) {
			return false
		}
	}
	return true
}

func (w *World) depenetrate(pos *Vec3, vel *Vec3, height float64) bool {
	grounded := false
	for pass := 0; pass < 6; pass++ {
		found := false
		box := playerBox(*pos, height)
		for _, b := range w.nearby(box.Min.X, box.Max.X, box.Min.Z, box.Max.Z) {
			if !intersects(playerBox(*pos, height), b) {
				continue
			}
			found = true
			axis, delta := 0, b.Min.X-Epsilon-(pos.X+PlayerHalf)
			best := math.Abs(delta)
			choose := func(candidate float64, candidateAxis int) {
				if size := math.Abs(candidate); size < best {
					best, delta, axis = size, candidate, candidateAxis
				}
			}
			choose(b.Max.X+Epsilon-(pos.X-PlayerHalf), 0)
			choose(b.Min.Y-Epsilon-(pos.Y+height), 1)
			choose(b.Max.Y+Epsilon-pos.Y, 1)
			choose(b.Min.Z-Epsilon-(pos.Z+PlayerHalf), 2)
			choose(b.Max.Z+Epsilon-(pos.Z-PlayerHalf), 2)
			switch axis {
			case 0:
				pos.X += delta
				vel.X = 0
			case 1:
				pos.Y += delta
				vel.Y = 0
				grounded = grounded || delta > 0
			default:
				pos.Z += delta
				vel.Z = 0
			}
			break
		}
		if !found {
			break
		}
	}
	return grounded
}

func stepBlocked(w *World, p Vec3, newFeet, height float64) bool {
	top := playerBox(Vec3{p.X, newFeet + Epsilon, p.Z}, height)
	for _, b := range w.nearby(top.Min.X, top.Max.X, top.Min.Z, top.Max.Z) {
		if intersects(top, b) {
			return true
		}
	}
	return false
}

func playerBox(p Vec3, height float64) AABB {
	return AABB{
		Min: Vec3{p.X - PlayerHalf, p.Y, p.Z - PlayerHalf},
		Max: Vec3{p.X + PlayerHalf, p.Y + height, p.Z + PlayerHalf},
	}
}

func intersects(a, b AABB) bool {
	return a.Min.X < b.Max.X && a.Max.X > b.Min.X &&
		a.Min.Y < b.Max.Y && a.Max.Y > b.Min.Y &&
		a.Min.Z < b.Max.Z && a.Max.Z > b.Min.Z
}

// Raycast returns distance to the nearest world hit. Production maps traverse
// only the occupied 16 m cells; directly constructed test worlds fall back to
// the complete AABB list.
func (w *World) Raycast(origin, dir Vec3, maxDist float64) (bool, float64) {
	best := maxDist
	hit := false
	if w.spatial == nil {
		for _, box := range w.aabbs {
			if distance, ok := rayAABB(origin, dir, box, best); ok && distance < best {
				best, hit = distance, true
			}
		}
		return hit, best
	}
	seen := make(map[int]struct{})
	testCell := func(key gridKey) {
		for _, index := range w.spatial[key] {
			if _, ok := seen[index]; ok {
				continue
			}
			seen[index] = struct{}{}
			if distance, ok := rayAABB(origin, dir, w.aabbs[index], best); ok && distance < best {
				best, hit = distance, true
			}
		}
	}
	horizontal := math.Hypot(dir.X, dir.Z)
	if horizontal < 1e-9 {
		testCell(gridKey{spatialCoord(origin.X), spatialCoord(origin.Z)})
		return hit, best
	}
	cx, cz := spatialCoord(origin.X), spatialCoord(origin.Z)
	stepX, stepZ := int(math.Copysign(1, dir.X)), int(math.Copysign(1, dir.Z))
	deltaX, deltaZ := math.Inf(1), math.Inf(1)
	nextX, nextZ := math.Inf(1), math.Inf(1)
	if math.Abs(dir.X) > 1e-9 {
		deltaX = spatialCell / math.Abs(dir.X)
		boundary := float64(cx) * spatialCell
		if dir.X > 0 {
			boundary = float64(cx+1) * spatialCell
		}
		nextX = (boundary - origin.X) / dir.X
	}
	if math.Abs(dir.Z) > 1e-9 {
		deltaZ = spatialCell / math.Abs(dir.Z)
		boundary := float64(cz) * spatialCell
		if dir.Z > 0 {
			boundary = float64(cz+1) * spatialCell
		}
		nextZ = (boundary - origin.Z) / dir.Z
	}
	for travel := 0.0; travel <= best; {
		testCell(gridKey{cx, cz})
		if nextX < nextZ {
			travel = nextX
			nextX += deltaX
			cx += stepX
		} else {
			travel = nextZ
			nextZ += deltaZ
			cz += stepZ
		}
		if travel > maxDist {
			break
		}
	}
	return hit, best
}

func rayAABB(o, d Vec3, b AABB, maxDist float64) (float64, bool) {
	tmin, tmax := 0.0, maxDist
	for axis := range 3 {
		var od, omin, omax, dd float64
		switch axis {
		case 0:
			od, omin, omax, dd = o.X, b.Min.X, b.Max.X, d.X
		case 1:
			od, omin, omax, dd = o.Y, b.Min.Y, b.Max.Y, d.Y
		default:
			od, omin, omax, dd = o.Z, b.Min.Z, b.Max.Z, d.Z
		}
		if math.Abs(dd) < 1e-9 {
			if od < omin || od > omax {
				return 0, false
			}
			continue
		}
		t1 := (omin - od) / dd
		t2 := (omax - od) / dd
		if t1 > t2 {
			t1, t2 = t2, t1
		}
		tmin = math.Max(tmin, t1)
		tmax = math.Min(tmax, t2)
		if tmin > tmax {
			return 0, false
		}
	}
	if tmin <= 0 {
		return 0, false
	}
	return tmin, true
}

func RayPlayerAABBHeight(o, d Vec3, p Vec3, height, maxDist float64) (float64, bool) {
	return rayAABB(o, d, playerBox(p, height), maxDist)
}

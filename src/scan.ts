/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { t } from "./i18n";
import {
	pathTilesCountStore, queueTilesCountStore, gardenTilesCountStore, gardenAreaSizesStore,
	rideExitCountStore, tilesCalculatedStore, parkEntranceInfoStore
} from "./store";

// A single visited path/queue tile: its tile coordinates plus the base height of
// the footpath element that was found on it.
export interface PathTileInfo {
	x: number;
	y: number;
	baseHeight: number;
	baseZ: number;
	isQueue: boolean;
	// Keys (see tileKey) of the tiles this tile is actually walkable to.
	// Plain x/y adjacency is NOT enough to decide this: two neighbouring
	// tiles can sit at completely different heights (e.g. a path on a
	// bridge crossing a path below, or two terraces separated by a cliff),
	// in which case staff cannot step from one to the other. Connectivity
	// is therefore computed once, while the tiles are being collected, and
	// carried on the tile itself so that patrol areas built later are
	// guaranteed to be genuinely walkable in one piece.
	neighbourKeys: string[];
}

export function tileKey(x: number, y: number): string {
	return String(x) + "," + String(y);
}

// Cardinal neighbour offsets used to walk the footpath network tile by tile.
export const CARDINAL_NEIGHBOUR_OFFSETS: CoordsXY[] = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 }
];
// OpenRCT2 stores tile-element directions as 0=-X, 1=+Y, 2=+X, 3=-Y. This
// ordering does NOT match CARDINAL_NEIGHBOUR_OFFSETS, so a stored direction
// (e.g. a ride exit's facing direction) must be mapped through this table
// rather than used to index CARDINAL_NEIGHBOUR_OFFSETS directly.
export const DIRECTION_OFFSETS: CoordsXY[] = [
	{ x: -1, y: 0 },
	{ x: 0, y: 1 },
	{ x: 1, y: 0 },
	{ x: 0, y: -1 }
];

// --- Park entrance detection ---------------------------------------------------
// Builds the set of tile keys (in "x,y" tile-coordinate form) that are occupied
// by a real ride entrance or exit, so they can be excluded when looking for the
// park entrance. A park entrance can share a "ride" id with an unrelated ride,
// so ride ids on entrance tile elements cannot be used to tell them apart.
function getRideEntranceExitTileKeys(): Set<string> {
	const tileKeys = new Set<string>();
	const rides = map.rides;
	for (const ride of rides) {
		const stations = ride.stations;
		for (const station of stations) {
			// Floor to tile coordinates so these keys match the integer-tile
			// keys used by findParkEntranceTiles/isValidStationExit. Using raw
			// "x / 32" would produce a fractional key (e.g. "5.5,3") for any
			// non-tile-aligned coordinate, which would never match and could
			// let a ride entrance/exit be misdetected as the park entrance.
			// Despite the API types showing them as always present, entrance/exit can
			// be null in practice (unused station slots), so guard before reading x/y.
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (station.entrance) {
				tileKeys.add(String(Math.floor(station.entrance.x / 32)) + "," + String(Math.floor(station.entrance.y / 32)));
			}
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (station.exit) {
				tileKeys.add(String(Math.floor(station.exit.x / 32)) + "," + String(Math.floor(station.exit.y / 32)));
			}
		}
	}
	return tileKeys;
}

// Scans the whole map for "entrance" tile elements that are not a ride entrance
// or exit; the remaining entrance element(s) are the park entrance(s).
export function findParkEntranceTiles(): CoordsXY[] {
	const rideEntranceExitTileKeys = getRideEntranceExitTileKeys();
	const mapSize = map.size;
	const parkEntranceTiles: CoordsXY[] = [];
	for (let x = 0; x < mapSize.x; x++) {
		for (let y = 0; y < mapSize.y; y++) {
			const tileKey = String(x) + "," + String(y);
			if (rideEntranceExitTileKeys.has(tileKey)) {
				continue;
			}
			const tile = map.getTile(x, y);
			for (let e = 0; e < tile.numElements; e++) {
				const element = tile.getElement(e);
				// Any "entrance" tile element left after excluding ride entrance/exit
				// tiles (built from map.rides[*].stations[*].entrance/exit) must be a
				// park entrance. The element's "ride" id is not a reliable sentinel,
				// since a park entrance can share a ride id with an unrelated ride.
				// A park entrance spans 3 tiles (two side "legs" plus a middle tile);
				// only the middle tile (sequence 0) has the footpath that leads into
				// the park, so only that tile is reported/used as the entrance.
				if (element.type === "entrance" && (element).sequence === 0) {
					parkEntranceTiles.push({ x: x, y: y });
				}
			}
		}
	}
	return parkEntranceTiles;
}

// Finds the park entrance tile(s) and logs the result. Returns the tiles so
// callers (like the footpath scan) can reuse them without scanning twice.
export function findAndReportParkEntrance(): CoordsXY[] {
	const parkEntranceTiles = findParkEntranceTiles();
	if (parkEntranceTiles.length === 0) {
		parkEntranceInfoStore.set(t("parkEntrance.notFound"));
		return parkEntranceTiles;
	}
	return parkEntranceTiles;
}

// --- Footpath network scan -------------------------------------------------
// A footpath element on a tile, reduced to what is needed to reason about
// whether staff can walk from it onto a neighbouring tile.
interface FootpathInfo {
	baseHeight: number;
	baseZ: number;
	isQueue: boolean;
	slopeDirection: number | null;
	isGhost: boolean;
}

// The vertical size (in baseZ units) a sloped footpath spans: a footpath
// slope always climbs exactly one height level, which is two baseHeight
// steps, i.e. 16 baseZ units.
const FOOTPATH_SLOPE_HEIGHT = 16;

// Lightweight, map-independent description of a footpath element used by the pure
// connectivity helpers below (footpathEdgeZ/footpathsConnect). Extracted from the
// full FootpathInfo so it can be unit-tested without any OpenRCT2 map access.
interface FootpathGeometry {
	baseZ: number;
	slopeDirection: number | null;
}

// Collects every footpath element on a tile. A tile can carry more than one
// (e.g. a path on a bridge above another path), and they are at different
// heights, so they must be treated as separate walkable nodes.
function findFootpathElements(x: number, y: number): FootpathInfo[] {
	const result: FootpathInfo[] = [];
	if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
		return result;
	}
	const tile = map.getTile(x, y);
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "footpath") {
			const footpathElement = element;
			result.push({
				baseHeight: footpathElement.baseHeight,
				baseZ: footpathElement.baseZ,
				isQueue: footpathElement.isQueue,
				slopeDirection: footpathElement.slopeDirection,
				isGhost: footpathElement.isGhost
			});
		}
	}
	return result;
}

// The world height of a footpath at the edge facing the given direction
// (using OpenRCT2's 0=-X, 1=+Y, 2=+X, 3=-Y direction convention). A flat
// path is at baseZ all around; a sloped path is at baseZ on three edges and
// one level higher on the edge it slopes up towards.
export function footpathEdgeZ(footpath: FootpathGeometry, direction: number, slopeHeight: number = FOOTPATH_SLOPE_HEIGHT): number {
	return footpath.slopeDirection === direction ? footpath.baseZ + slopeHeight : footpath.baseZ;
}

export function oppositeDirection(direction: number): number {
	return (direction + 2) % 4;
}

// Whether staff can step from the given footpath onto a footpath on the
// neighbouring tile in the given direction: the two paths must meet at the
// same height on their shared edge. This is what makes a patrol area
// genuinely walkable - x/y adjacency alone would happily join a path on a
// bridge to the path passing underneath it.
export function footpathsConnect(from: FootpathGeometry, to: FootpathGeometry, direction: number): boolean {
	return footpathEdgeZ(from, direction) === footpathEdgeZ(to, oppositeDirection(direction));
}

// Finds the surface element on a tile, if any.
function findSurfaceElement(tile: Tile): SurfaceElement | null {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "surface") {
			return element;
		}
	}
	return null;
}

// The maximum difference in surface baseHeight between two neighbouring land
// tiles that staff can still walk across. A sloped tile spans exactly one
// height level, which is 2 baseHeight steps; anything steeper is a cliff.
const MAX_WALKABLE_HEIGHT_DIFFERENCE = 2;

// Whether staff can walk between two neighbouring land tiles, i.e. whether
// their terrain heights are close enough not to form an unclimbable step.
export function surfacesConnect(from: { baseHeight: number; waterHeight: number } | null, to: { baseHeight: number; waterHeight: number } | null, maxDifference: number = MAX_WALKABLE_HEIGHT_DIFFERENCE): boolean {
	if (!from || !to || from.waterHeight !== 0 || to.waterHeight !== 0) {
		return false;
	}
	return Math.abs(from.baseHeight - to.baseHeight) <= maxDifference;
}

// Whether a surface tile is dry land rather than water. In OpenRCT2, water is
// not a separate tile/element type: it's stored as a waterHeight on the
// surface element itself, so a perfectly "grass"-styled surface can still be
// submerged. Handymen (mowing/watering) must never be sent onto such tiles -
// they can't stand on water - so this must be checked in addition to the
// surface style.
function isLandSurface(surface: SurfaceElement | null): surface is SurfaceElement {
	return surface?.waterHeight === 0;
}

// Whether a tile is actually owned by the park. Deliberately excludes tiles
// that only have construction rights (no ownership): those don't belong to
// the park, so staff patrol areas (and gardening tiles) must not include
// them, even though the footpath on them may still be walkable.
function isParkOwnedTile(x: number, y: number): boolean {
	const surface = findSurfaceElement(map.getTile(x, y));
	if (!surface) {
		return false;
	}
	return surface.hasOwnership;
}

// Starting from the park entrance, walks the connected footpath network in all
// directions (depth-first, so consecutive tiles in the resulting list stay
// physically close together) and separately collects plain path tiles and
// queue tiles, together with their coordinates and base height.
//
// The walk is height-aware: it only steps onto a neighbouring footpath whose
// shared edge is at the same height (taking path slopes into account), so
// paths that merely happen to be x/y neighbours at different heights (a
// bridge over a path, two terraces next to a cliff, a slope approached from
// its raised side) are correctly treated as *not* connected. Each collected
// tile records the tiles it is genuinely walkable to, so the patrol areas
// built from these tiles later are contiguous by construction.
function scanFootpathNetworkFromEntrance(entranceTile: CoordsXY): { pathTiles: PathTileInfo[]; queueTiles: PathTileInfo[]; allTiles: PathTileInfo[] } {
	const pathTiles: PathTileInfo[] = [];
	const queueTiles: PathTileInfo[] = [];
	const allTiles: PathTileInfo[] = [];
	// Visited nodes are (tile, path height) pairs, not just tiles: a tile can
	// carry several stacked footpaths that are not connected to each other.
	const visited = new Set<string>();
	const tilesByKey = new Map<string, PathTileInfo>();
	// A step to take: onto tile (x, y), arriving from `fromDirection`, where
	// the path we are stepping off meets this tile at height `z`. A null z
	// means "no height constraint" and is only used for the initial steps out
	// of the park entrance.
	interface PendingStep {
		x: number;
		y: number;
		z: number | null;
		fromDirection: number;
	}
	const stack: PendingStep[] = [];

	// Seed the search with the tiles directly next to the entrance.
	for (let d = 0; d < DIRECTION_OFFSETS.length; d++) {
		const offset = DIRECTION_OFFSETS[d];
		stack.push({ x: entranceTile.x + offset.x, y: entranceTile.y + offset.y, z: null, fromDirection: oppositeDirection(d) });
	}

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}

		if (current.x < 0 || current.y < 0 || current.x >= map.size.x || current.y >= map.size.y) {
			continue;
		}

		// Tiles that are not owned by the park (or under construction rights
		// only), e.g. the public road/path leading up to the entrance from
		// outside the park, are not included in the resulting path/queue
		// tile lists (so patrol areas/mowing never extend onto land the
		// park doesn't own) - but if such a tile still has a footpath on it,
		// the walk passes *through* it to reach further tiles beyond, since
		// otherwise a single unowned path tile (e.g. the entrance's own
		// approach path, which sits right between the map edge and the
		// park's owned network) would incorrectly split the footpath
		// network into separate "disconnected" halves, causing patrol areas
		// built from them to leave a gap in the middle. Unowned non-path
		// tiles (e.g. surrounding land/water) are still dead ends, so the
		// walk doesn't spread across the whole map.
		const isOwned = isParkOwnedTile(current.x, current.y);
		const footpaths = findFootpathElements(current.x, current.y);

		for (const footpath of footpaths) {
			// Only step onto this path if it actually meets the path we came
			// from at the same height.
			if (current.z !== null && footpathEdgeZ(footpath, current.fromDirection) !== current.z) {
				continue;
			}

			const nodeKey = String(current.x) + "," + String(current.y) + "," + String(footpath.baseZ);
			if (visited.has(nodeKey)) {
				continue;
			}
			visited.add(nodeKey);

			const key = tileKey(current.x, current.y);
			let info = tilesByKey.get(key);
			if (isOwned && !info) {
				info = {
					x: current.x,
					y: current.y,
					baseHeight: footpath.baseHeight,
					baseZ: footpath.baseZ,
					isQueue: footpath.isQueue,
					neighbourKeys: []
				};
				tilesByKey.set(key, info);
				if (footpath.isQueue) {
					queueTiles.push(info);
				} else {
					pathTiles.push(info);
				}
				allTiles.push(info);
			}

			for (let d = 0; d < DIRECTION_OFFSETS.length; d++) {
				const offset = DIRECTION_OFFSETS[d];
				const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
				const edgeZ = footpathEdgeZ(footpath, d);
				const neighbourFootpaths = findFootpathElements(neighbour.x, neighbour.y);
				const connects = neighbourFootpaths.some((neighbourFootpath) => footpathsConnect(footpath, neighbourFootpath, d));
				if (!connects) {
					continue;
				}
				// Record the walkable link between the two tiles (both ends,
				// once both tiles are known to be part of the park's network).
				if (info) {
					const neighbourKey = tileKey(neighbour.x, neighbour.y);
					if (!info.neighbourKeys.includes(neighbourKey)) {
						info.neighbourKeys.push(neighbourKey);
					}
					const neighbourInfo = tilesByKey.get(neighbourKey);
					if (neighbourInfo && !neighbourInfo.neighbourKeys.includes(key)) {
						neighbourInfo.neighbourKeys.push(key);
					}
				}
				stack.push({ x: neighbour.x, y: neighbour.y, z: edgeZ, fromDirection: oppositeDirection(d) });
			}
		}
	}

	return { pathTiles: pathTiles, queueTiles: queueTiles, allTiles: allTiles };
}

// --- Gardening tile scan --------------------------------------------------------
// Whether a tile has a footpath element on it. Tiles covered by a footpath are
// not gardening tiles: guests/staff can't walk on grass/scenery hidden
// underneath a path.
function hasFootpathElement(tile: Tile): boolean {
	for (let e = 0; e < tile.numElements; e++) {
		if (tile.getElement(e).type === "footpath") {
			return true;
		}
	}
	return false;
}

// The small scenery object flag bit that marks an item as "can be watered"
// (SMALL_SCENERY_FLAG_CAN_BE_WATERED in the OpenRCT2 source, SmallSceneryEntry.h).
// Only scenery objects with this flag set (e.g. flowers/gardens) need
// watering by handymen; trees, benches, lamps, etc. do not.
const SMALL_SCENERY_FLAG_CAN_BE_WATERED = 1 << 5;

// Small scenery placed directly on the ground (e.g. flowers, gardens) is what
// handymen water. Not every small scenery item needs watering (e.g. trees,
// lamps, benches don't), so the scenery object's flags are checked for the
// "can be watered" bit.
function hasWaterableSceneryElement(tile: Tile): boolean {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "small_scenery") {
			const sceneryElement = element;
			const sceneryObject = objectManager.getObject("small_scenery", sceneryElement.object);
			if ((sceneryObject.flags & SMALL_SCENERY_FLAG_CAN_BE_WATERED) !== 0) {
				return true;
			}
		}
	}
	return false;
}

// Finds all loaded terrain_surface object indices that are grass-family
// surfaces (e.g. "grass", "grass_clumps"), as opposed to sand, dirt, rock,
// ice, martian, chequerboard, etc. Only grass can actually grow, so a
// tile's grassLength is meaningless (and shouldn't count as mowable) unless
// its surface style is one of these.
function findGrassSurfaceStyleIndices(): Set<number> {
	const surfaceObjects = objectManager.getAllObjects("terrain_surface");
	const result = new Set<number>();
	for (const surfaceObject of surfaceObjects) {
		const identifier = surfaceObject.identifier.toLowerCase();
		if (identifier.includes("grass")) {
			result.add(surfaceObject.index);
		}
	}
	return result;
}

// Scans every tile owned by the park (or under construction rights) and counts
// how many are "garden tiles": tiles that either have mowable grass or
// waterable scenery on them (a tile with both still only counts once). Tiles
// under a footpath are skipped entirely, since staff can't mow/water grass or
// scenery hidden under a path. Also groups the garden tiles into connected
// components (4-directionally adjacent tiles), each in BFS visitation order,
// so groups of tiles that are physically next to each other stay together;
// this is used by Assign to build spatially local gardening patrol areas.
function scanGardeningTiles(): { gardenTiles: number; areas: PathTileInfo[][] } {
	const mapSize = map.size;
	let gardenTiles = 0;
	const isGardenTile = new Set<string>();
	const grassSurfaceStyleIndices = findGrassSurfaceStyleIndices();

	for (let x = 0; x < mapSize.x; x++) {
		for (let y = 0; y < mapSize.y; y++) {
			if (!isParkOwnedTile(x, y)) {
				continue;
			}

			const tile = map.getTile(x, y);
			if (hasFootpathElement(tile)) {
				continue;
			}

			const surface = findSurfaceElement(tile);
			// A tile is mowable only if its surface is a grass-family style
			// and isn't submerged under water (waterHeight === 0): a tile
			// can be "grass" styled and still have water on top of it, but
			// staff can't stand on water to mow/water it.
			// grassLength itself is not tested: it is always a valid number
			// for any surface, so the old ">= 0" check filtered nothing, and
			// only grass surfaces actually grow long grass that needs mowing.
			const isMowable = isLandSurface(surface) && grassSurfaceStyleIndices.has(surface.surfaceStyle);
			const isWaterable = isLandSurface(surface) && hasWaterableSceneryElement(tile);
			if (isMowable || isWaterable) {
				gardenTiles++;
				isGardenTile.add(tileKey(x, y));
			}
		}
	}

	const areas: PathTileInfo[][] = [];
	const visited = new Set<string>();
	isGardenTile.forEach(function (key) {
		if (visited.has(key)) {
			return;
		}
		const parts = key.split(",");
		const startX = parseInt(parts[0], 10);
		const startY = parseInt(parts[1], 10);
		const component: PathTileInfo[] = [];
		const componentByKey = new Map<string, PathTileInfo>();
		const stack: CoordsXY[] = [{ x: startX, y: startY }];
		visited.add(key);
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		const currentKey = tileKey(current.x, current.y);
			const surface = findSurfaceElement(map.getTile(current.x, current.y));
			const info: PathTileInfo = {
				x: current.x,
				y: current.y,
				baseHeight: surface ? surface.baseHeight : 0,
				baseZ: surface ? surface.baseZ : 0,
				isQueue: false,
				neighbourKeys: []
			};
			component.push(info);
			componentByKey.set(currentKey, info);
			for (const offset of CARDINAL_NEIGHBOUR_OFFSETS) {
				const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
				const neighbourKey = tileKey(neighbour.x, neighbour.y);
				if (!isGardenTile.has(neighbourKey)) {
					continue;
				}
				// Two neighbouring land tiles only belong to the same area if
				// staff can actually walk between them: a difference of more
				// than one height level (2 baseHeight steps, the most a
				// sloped tile can span) means a cliff/wall of terrain that
				// cannot be climbed, so the tiles must end up in separate
				// areas rather than in one patrol area a handyman gets stuck
				// in.
				if (!surfacesConnect(surface, findSurfaceElement(map.getTile(neighbour.x, neighbour.y)))) {
					continue;
				}
				info.neighbourKeys.push(neighbourKey);
				const neighbourInfo = componentByKey.get(neighbourKey);
				if (neighbourInfo && !neighbourInfo.neighbourKeys.includes(currentKey)) {
					neighbourInfo.neighbourKeys.push(currentKey);
				}
				if (!visited.has(neighbourKey)) {
					visited.add(neighbourKey);
					stack.push(neighbour);
				}
			}
		}
		areas.push(component);
	});

	return { gardenTiles: gardenTiles, areas: areas };
}

// --- Ride exit counting -------------------------------------------------------
// Whether a station's exit coordinate is a real, in-use exit rather than an
// unused station slot's sentinel value. OpenRCT2 always populates
// RideStation.exit/entrance (they're never actually null despite existing
// checks against falsy values), so unused slots must instead be detected by
// their coordinates falling outside the map bounds.
export function isValidStationExit(exit: CoordsXYZD | null | undefined): exit is CoordsXYZD {
	if (!exit) {
		return false;
	}
	const tileX = Math.floor(exit.x / 32);
	const tileY = Math.floor(exit.y / 32);
	return tileX >= 0 && tileY >= 0 && tileX < map.size.x && tileY < map.size.y;
}

// Counts the number of ride exits in the park; one mechanic is needed per
// ride exit. Only actual rides count - shops/stalls and facilities (e.g. a
// T-shirt shop) are excluded via their classification, since mechanics
// service ride vehicles/track, not shops. Unused station slots (a ride's
// "stations" array can be longer than its actual station count) report an
// exit at a sentinel/out-of-bounds coordinate rather than null, so those are
// filtered out by checking the resulting tile is within the map.
export function countRideExits(): number {
	const rides = map.rides;
	let count = 0;
	for (const ride of rides) {
		if (ride.classification !== "ride") {
			continue;
		}
		const stations = ride.stations;
		for (const station of stations) {
			if (isValidStationExit(station.exit)) {
				count++;
			}
		}
	}
	return count;
}

// --- Cached scan results (for Assign) ---------------------------------------------
// The most recent footpath/queue tiles (in BFS visitation order, so slicing
// them into consecutive chunks keeps each chunk spatially local) and garden
// tile connected components, kept around so the Assign button can build
// patrol areas without re-scanning the map.
export let lastAllPathTiles: PathTileInfo[] = [];
export let lastGardenAreas: PathTileInfo[][] = [];

// --- Per-tile classification helpers (for incremental auto mode) ---------------------
// A single tile can carry a footpath (plain or queue) and garden/owned state.
// These helpers inspect just one tile so automatic mode can decide what to do with a
// freshly placed path/queue tile or a newly bought land tile, without a full scan.

// Whether the given tile has at least one footpath element that is not a ghost
// (hover/preview) placement. OpenRCT2 fires `action.execute` for ghost paths
// too (the tile is briefly added then removed as the cursor hovers), so a check
// that only filters on footpath presence would treat the hover preview as a real
// placement and needlessly hire/assign staff before the path is actually built.
export function hasNonGhostFootpathElements(x: number, y: number): boolean {
	return findFootpathElements(x, y).some(function (fp) { return !fp.isGhost; });
}

// Whether the given tile has a plain (non-queue) footpath.
export function isPlainPathTile(x: number, y: number): boolean {
	return findFootpathElements(x, y).some(function (fp) { return !fp.isQueue; });
}

// Whether the given tile has a queue footpath.
export function isQueueTile(x: number, y: number): boolean {
	return findFootpathElements(x, y).some(function (fp) { return fp.isQueue; });
}

// Whether the given tile is a garden tile (mowable grass or waterable scenery on
// dry, owned land with no footpath covering it). Mirrors the logic of
// scanGardeningTiles for a single tile.
export function isGardenTile(x: number, y: number): boolean {
	if (!isParkOwnedTile(x, y)) {
		return false;
	}
	const tile = map.getTile(x, y);
	if (hasFootpathElement(tile)) {
		return false;
	}
	const surface = findSurfaceElement(tile);
	const isMowable = isLandSurface(surface) && grassSurfaceStyleIndices().has(surface.surfaceStyle);
	const isWaterable = isLandSurface(surface) && hasWaterableSceneryElement(tile);
	return isMowable || isWaterable;
}

let cachedGrassSurfaceStyleIndices: Set<number> | null = null;

function grassSurfaceStyleIndices(): Set<number> {
	cachedGrassSurfaceStyleIndices ??= findGrassSurfaceStyleIndices();
	return cachedGrassSurfaceStyleIndices;
}

// The world-to-tile coordinate of the tile containing the given world coordinate.
export function worldToTile(x: number, y: number): CoordsXY {
	return { x: Math.floor(x / 32), y: Math.floor(y / 32) };
}

// Finds the park entrance, then walks the footpath network from it, and scans
// the park's owned tiles for gardening tiles. Logs and stores the resulting
// path/queue/mowable/waterable tile counts.
export function scanFootpathNetwork(): void {
	const parkEntranceTiles = findParkEntranceTiles();
	if (parkEntranceTiles.length === 0) {
		return;
	}

	const result = scanFootpathNetworkFromEntrance(parkEntranceTiles[0]);

	const gardeningResult = scanGardeningTiles();

	const rideExitCount = countRideExits();

	pathTilesCountStore.set(result.pathTiles.length);
	queueTilesCountStore.set(result.queueTiles.length);
	gardenTilesCountStore.set(gardeningResult.gardenTiles);
	gardenAreaSizesStore.set(gardeningResult.areas.map(function (area) { return area.length; }));
	rideExitCountStore.set(rideExitCount);

	lastAllPathTiles = result.allTiles;
	lastGardenAreas = gardeningResult.areas;

	tilesCalculatedStore.set(true);

	parkEntranceInfoStore.set(
		t("parkEntrance.summary", result.pathTiles.length, result.queueTiles.length, gardeningResult.gardenTiles)
	);
}

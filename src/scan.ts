/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { t } from "./i18n";
import { gameMap, gameContext } from "./game";
import {
	pathTilesCountStore, queueTilesCountStore, gardenTilesCountStore, gardenAreaSizesStore,
	rideExitCountStore, ownedTilesCountStore, tilesCalculatedStore, parkEntranceInfoStore
} from "./store";

// A single visited path/queue tile: its tile coordinates plus the base height of
// the footpath element that was found on it.
export interface PathTileInfo {
	x: number;
	y: number;
	baseHeight: number;
	baseZ: number;
	isQueue: boolean;
	// True only for footpath (connector) tiles added to a gardening area so a
	// handyman can walk across them between grass work tiles. Connector tiles are
	// part of the patrol area but are NOT mowed/watered and do NOT count toward
	// gardener staffing. Undefined for cleanup/queue/regular garden work tiles.
	isConnector?: boolean;
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
	const rides = gameMap().rides;
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
	const mapSize = gameMap().size;
	const parkEntranceTiles: CoordsXY[] = [];
	for (let x = 0; x < mapSize.x; x++) {
		for (let y = 0; y < mapSize.y; y++) {
			const tileKey = String(x) + "," + String(y);
			if (rideEntranceExitTileKeys.has(tileKey)) {
				continue;
			}
			const tile = gameMap().getTile(x, y);
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
					// At most one park entrance element with sequence 0 can sit on a
					// tile, so the remaining elements cannot add anything.
					break;
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

// Collects every footpath element on a tile that has already been fetched.
// Split out from findFootpathElements so callers that already hold a Tile
// don't pay for a second map.getTile plus a second pass over its elements.
function findFootpathElementsOnTile(tile: Tile): FootpathInfo[] {
	const result: FootpathInfo[] = [];
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

// Collects every footpath element on a tile. A tile can carry more than one
// (e.g. a path on a bridge above another path), and they are at different
// heights, so they must be treated as separate walkable nodes.
function findFootpathElements(x: number, y: number): FootpathInfo[] {
	if (x < 0 || y < 0 || x >= gameMap().size.x || y >= gameMap().size.y) {
		return [];
	}
	return findFootpathElementsOnTile(gameMap().getTile(x, y));
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

// Whether staff can walk between two neighbouring tiles' *footpath* elements. Unlike
// plain x/y adjacency, this resolves height: a path on a bridge and a path passing
// beneath it at a different height are NOT considered connected, and two inclined ways
// meet only if their shared edge is at the same height. This is the shared
// connectivity primitive used by both the manual scan (to build patrol areas) and
// auto mode (to decide enlarge-vs-hire), so the two never disagree about whether two
// tiles belong in one reachable area.
export function footpathsConnectTiles(tx: number, ty: number, nx: number, ny: number): boolean {
	if (tx === nx && ty === ny) {
		return false;
	}
	const dx = nx - tx;
	const dy = ny - ty;
	let direction = -1;
	for (let d = 0; d < DIRECTION_OFFSETS.length; d++) {
		if (DIRECTION_OFFSETS[d].x === dx && DIRECTION_OFFSETS[d].y === dy) {
			direction = d;
			break;
		}
	}
	if (direction < 0) {
		// Not a cardinal neighbour: never directly walkable between the two tiles.
		return false;
	}
	const froms = findFootpathElements(tx, ty);
	const tos = findFootpathElements(nx, ny);
	for (const from of froms) {
		for (const to of tos) {
			if (footpathsConnect(from, to, direction)) {
				return true;
			}
		}
	}
	return false;
}

// Whether staff can walk between two neighbouring *land* tiles (used for gardening
// areas): their terrain heights must be close enough not to form an unclimbable step,
// and neither may be water. Shared by the manual garden-area scan and auto mode.
export function surfaceTilesConnect(tx: number, ty: number, nx: number, ny: number): boolean {
	return surfacesConnect(
		findSurfaceElement(gameMap().getTile(tx, ty)),
		findSurfaceElement(gameMap().getTile(nx, ny))
	);
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

// Fence bit for each cardinal direction, matching OpenRCT2's parkFences layout
// (bit set means the neighbour in that cardinal direction is in the park, so a fence
// on the shared edge blocks walking). Indexed to CARDINAL_NEIGHBOUR_OFFSETS order:
// [north(0,-1), east(1,0), south(0,1), west(-1,0)] -> [0x4, 0x2, 0x1, 0x8].
const FENCE_BIT_BY_DIRECTION = [0x4, 0x2, 0x1, 0x8];

// Whether a park fence or a footpath railing blocks a person from stepping between two
// neighbouring tiles across their shared edge. A park fence on a surface (parkFences),
// or a path edge/railing (FootpathElement.edges), physically bars walking, so fenced
// tiles must not be merged into the same patrol area.
export function surfaceFenceBlocksWalking(x1: number, y1: number, x2: number, y2: number): boolean {
	const dx = x2 - x1;
	const dy = y2 - y1;
	let direction = -1;
	for (let d = 0; d < CARDINAL_NEIGHBOUR_OFFSETS.length; d++) {
		if (CARDINAL_NEIGHBOUR_OFFSETS[d].x === dx && CARDINAL_NEIGHBOUR_OFFSETS[d].y === dy) {
			direction = d;
			break;
		}
	}
	if (direction < 0) {
		return false;
	}
	const inverse = oppositeDirection(direction);
	const surfaceA = findSurfaceElement(gameMap().getTile(x1, y1));
	const surfaceB = findSurfaceElement(gameMap().getTile(x2, y2));
	if (surfaceA && (surfaceA.parkFences & FENCE_BIT_BY_DIRECTION[direction]) !== 0) {
		return true;
	}
	if (surfaceB && (surfaceB.parkFences & FENCE_BIT_BY_DIRECTION[inverse]) !== 0) {
		return true;
	}
	return false;
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
	const surface = findSurfaceElement(gameMap().getTile(x, y));
	if (!surface) {
		return false;
	}
	return surface.hasOwnership;
}

// How many height levels (~16 Z units each) a footpath must clear the ground surface
// below it to be considered a bridge/overpass rather than a ground-level path.
export const ELEVATED_FOOTPATH_LEVELS = 2;

// The pure version of the elevated-footpath check: a footpath is considered a bridge
// or overpass when its baseZ is at least ELEVATED_FOOTPATH_LEVELS height levels
// (~32 Z units) above the given ground surface baseZ. Extracted from the map-reading
// isElevatedFootpath so it can be unit-tested without OpenRCT2 access.
export function footpathIsElevated(footpathBaseZ: number, surfaceBaseZ: number): boolean {
	return footpathBaseZ >= surfaceBaseZ + ELEVATED_FOOTPATH_LEVELS * 16;
}

// Whether a footpath is elevated well above the surface below it (a bridge or
// overpass). In OpenRCT2 the surface's baseZ is the ground level, and a path a
// couple of height levels or more above it crosses over land beneath — often land the
// park doesn't own. Such an elevated path is still a real park path staff can patrol,
// unlike a ground-level public road on unowned land, which the scan only walks *through*
// without including.
function isElevatedFootpath(x: number, y: number, footpath: { baseZ: number }): boolean {
	const surface = findSurfaceElement(gameMap().getTile(x, y));
	if (!surface) {
		return false;
	}
	return footpathIsElevated(footpath.baseZ, surface.baseZ);
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

		if (current.x < 0 || current.y < 0 || current.x >= gameMap().size.x || current.y >= gameMap().size.y) {
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
			const ownedOrElevated = isParkOwnedTile(current.x, current.y) || isElevatedFootpath(current.x, current.y, footpath);
			let info = tilesByKey.get(key);
			if (ownedOrElevated && !info) {
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
				// Guard by height: a tile can carry stacked footpaths at different
				// heights (e.g. underground and overground crossing), which are separate
				// walkable nodes. Only the node matching this tile's recorded baseZ may
				// contribute links - otherwise a single tile whose two stacked paths belong to
				// different networks would bridge them, merging into one unreachable area.
				if (info != null) {
					if (info.baseZ === footpath.baseZ) {
						const neighbourKey = tileKey(neighbour.x, neighbour.y);
						if (!info.neighbourKeys.includes(neighbourKey)) {
							info.neighbourKeys.push(neighbourKey);
						}
						const neighbourInfo = tilesByKey.get(neighbourKey);
						if (neighbourInfo != null) {
							if (neighbourInfo.baseZ === footpath.baseZ && !neighbourInfo.neighbourKeys.includes(key)) {
								neighbourInfo.neighbourKeys.push(key);
							}
						}
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

// Whether a tile carries an element that physically blocks a walking person at
// the surface's standing height, so staff can't stand on the tile to mow/water
// it. A shop/facility (large scenery), ride entrance/exit (entrance), or
// embedded ride track blocks only when it is actually *on* the ground the
// gardener stands on (its baseZ is at or just above the surface baseZ) - an
// element clearly elevated above the grass (e.g. a track on a bridge/crest or a
// raised shop on columns) leaves the grass underneath reachable and must NOT be
// treated as a blocker. Small scenery (flowers/gardens) and walls/banners are
// never blockers - flowers are the very thing being watered, and walls/banners
// don't prevent standing on the tile.
function hasBlockingElement(tile: Tile, surfaceBaseZ: number): boolean {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		const type = element.type;
		if (type === "large_scenery" || type === "entrance" || type === "track") {
			// Only block when the element occupies the gardener's standing column:
			// its base is no higher than one height level (~16 Z) above the surface.
			if (element.baseZ <= surfaceBaseZ + 16) {
				return true;
			}
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
// Mutable state carried across the chunked gardening sweep (see
// scanGardeningColumn). Kept in one object so the sweep can be paused between
// game ticks and resumed exactly where it left off.
interface GardeningSweepState {
	gardenTiles: number;
	ownedTiles: number;
	isGardenTile: Set<string>;
	connectorKeys: Set<string>;
	grassStyleIndices: Set<number>;
}

function newGardeningSweepState(): GardeningSweepState {
	return {
		gardenTiles: 0,
		ownedTiles: 0,
		isGardenTile: new Set<string>(),
		// Owned footpath tiles that act as walkable connectors between garden work
		// tiles, so a gardener can reach (and join) grass areas split by a path.
		connectorKeys: new Set<string>(),
		grassStyleIndices: grassSurfaceStyleIndices()
	};
}

// Classifies every owned tile in a single map column. Extracted from the old
// nested x/y loop so the sweep can be spread over several game ticks instead of
// scanning the whole map in one blocking pass.
function scanGardeningColumn(x: number, state: GardeningSweepState): void {
	const mapSize = gameMap().size;
	for (let y = 0; y < mapSize.y; y++) {
		if (!isParkOwnedTile(x, y)) {
			continue;
		}
		state.ownedTiles++;

		const tile = gameMap().getTile(x, y);
		const surface = findSurfaceElement(tile);
		const tileKeyStr = tileKey(x, y);
		if (hasBlockingElement(tile, surface ? surface.baseZ : 0)) {
			continue;
		}
		const footpaths = findFootpathElementsOnTile(tile);
		if (footpaths.length > 0) {
			// An owned plain (non-queue) footpath tile is a walkable connector: it
			// is not mowed itself, but it lets a gardener walk across it and join
			// garden areas that a path would otherwise split. Queue tiles are NOT
			// connectors - a queue has railing/fencing the gardener cannot step off
			// onto the adjacent grass, so they are excluded here (and being footpaths
			// they were never counted as garden work anyway).
			const hasPlainPath = footpaths.some(function (fp) { return !fp.isQueue; });
			if (!hasPlainPath) {
				continue;
			}
			state.connectorKeys.add(tileKeyStr);
			continue;
		}

		// A tile is mowable only if its surface is a grass-family style
		// and isn't submerged under water (waterHeight === 0): a tile
		// can be "grass" styled and still have water on top of it, but
		// staff can't stand on water to mow/water it.
		// grassLength itself is not tested: it is always a valid number
		// for any surface, so the old ">= 0" check filtered nothing, and
		// only grass surfaces actually grow long grass that needs mowing.
		const isMowable = isLandSurface(surface) && state.grassStyleIndices.has(surface.surfaceStyle);
		const isWaterable = isLandSurface(surface) && hasWaterableSceneryElement(tile);
		if (isMowable || isWaterable) {
			state.gardenTiles++;
			state.isGardenTile.add(tileKeyStr);
		}
	}
}

// Groups the classified garden tiles into connected components. Runs once, after
// the column sweep above has visited every owned tile.
function groupGardeningTiles(state: GardeningSweepState): { gardenTiles: number; ownedTiles: number; areas: PathTileInfo[][]; workCounts: number[] } {
	const isGardenTile = state.isGardenTile;
	const connectorKeys = state.connectorKeys;
	// workCounts[i] = number of mowable/waterable tiles in areas[i]; path connectors
	// in an area don't count toward gardener staffing.
	const workCounts: number[] = [];
	const areas: PathTileInfo[][] = [];
	const visited = new Set<string>();
	// A walkable node is either a garden work tile or a footpath connector tile.
	// Built once up front: it is identical for every component, so rebuilding it
	// per component made the grouping cost O(components x garden tiles).
	const walkKeys = new Set<string>(connectorKeys);
	isGardenTile.forEach(function (k) { walkKeys.add(k); });
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
		let workTileCount = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		const currentKey = tileKey(current.x, current.y);
			const surface = findSurfaceElement(gameMap().getTile(current.x, current.y));
			const info: PathTileInfo = {
				x: current.x,
				y: current.y,
				baseHeight: surface ? surface.baseHeight : 0,
				baseZ: surface ? surface.baseZ : 0,
				isQueue: false,
				isConnector: connectorKeys.has(currentKey),
				neighbourKeys: []
			};
			component.push(info);
			componentByKey.set(currentKey, info);
			if (!info.isConnector) {
				workTileCount++;
			}
			for (const offset of CARDINAL_NEIGHBOUR_OFFSETS) {
				const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
				const neighbourKey = tileKey(neighbour.x, neighbour.y);
				// Walk on to any walkable node (garden work or connector footpath tile).
				if (!walkKeys.has(neighbourKey)) {
					continue;
				}
				// Two neighbouring land tiles only belong to the same area if
				// staff can actually walk between them: a difference of more
				// than one height level (2 baseHeight steps, the most a
				// sloped tile can span) means a cliff/wall of terrain that
				// cannot be climbed, so the tiles must end up in separate
				// areas rather than in one patrol area a handyman gets stuck
				// in.
				if (!surfacesConnect(surface, findSurfaceElement(gameMap().getTile(neighbour.x, neighbour.y)))) {
					continue;
				}
				// A park fence or path railing on either side of the shared edge blocks
				// walking between the two tiles, so they must remain separate areas.
				if (surfaceFenceBlocksWalking(current.x, current.y, neighbour.x, neighbour.y)) {
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
		workCounts.push(workTileCount);
	});

	return { gardenTiles: state.gardenTiles, ownedTiles: state.ownedTiles, areas: areas, workCounts: workCounts };
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
	return tileX >= 0 && tileY >= 0 && tileX < gameMap().size.x && tileY < gameMap().size.y;
}

// Counts the number of ride exits in the park; one mechanic is needed per
// ride exit. Only actual rides count - shops/stalls and facilities (e.g. a
// T-shirt shop) are excluded via their classification, since mechanics
// service ride vehicles/track, not shops. Unused station slots (a ride's
// "stations" array can be longer than its actual station count) report an
// exit at a sentinel/out-of-bounds coordinate rather than null, so those are
// filtered out by checking the resulting tile is within the map.
export function countRideExits(): number {
	const rides = gameMap().rides;
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
	const tile = gameMap().getTile(x, y);
	const surface = findSurfaceElement(tile);
	if (hasFootpathElement(tile) || hasBlockingElement(tile, surface ? surface.baseZ : 0)) {
		return false;
	}
	const isMowable = isLandSurface(surface) && grassSurfaceStyleIndices().has(surface.surfaceStyle);
	const isWaterable = isLandSurface(surface) && hasWaterableSceneryElement(tile);
	return isMowable || isWaterable;
}

// The baseZ of the surface on a tile (the height a gardener stands on to mow/
// water), or 0 if there is no surface element. Used as a teleport height for
// gardening handymen (unlike footpathBaseZAt, which is 0 on grass-only tiles).
export function surfaceBaseZAt(x: number, y: number): number {
	const surface = findSurfaceElement(gameMap().getTile(x, y));
	return surface ? surface.baseZ : 0;
}

let cachedGrassSurfaceStyleIndices: Set<number> | null = null;

function grassSurfaceStyleIndices(): Set<number> {
	cachedGrassSurfaceStyleIndices ??= findGrassSurfaceStyleIndices();
	return cachedGrassSurfaceStyleIndices;
}

// Drops the memoised grass surface-style lookup so the next scan re-reads it
// from the object manager. The installed surface objects can change between
// scans (e.g. loading a different park), and the cache was previously never
// invalidated, so a stale set could misclassify mowable tiles.
export function invalidateGrassSurfaceStyleCache(): void {
	cachedGrassSurfaceStyleIndices = null;
}

// The world-to-tile coordinate of the tile containing the given world coordinate.
export function worldToTile(x: number, y: number): CoordsXY {
	return { x: Math.floor(x / 32), y: Math.floor(y / 32) };
}

// How many map columns of the gardening sweep to classify per game tick. The
// sweep touches every owned tile, so on a large map doing it in one pass
// visibly froze the game while the window opened. Matches the chunking approach
// automatic mode already uses for bursts of placed tiles.
const COLUMNS_PER_TICK = 16;

// Delay between chunks, in ms. Zero still yields to the game loop (the callback
// runs on a later tick), which is all that's needed to keep the game responsive.
const SCAN_TICK_DELAY = 0;

// Publishes a completed scan's results to the stores.
function publishScanResults(
	result: { pathTiles: PathTileInfo[]; queueTiles: PathTileInfo[]; allTiles: PathTileInfo[] },
	gardeningResult: { gardenTiles: number; ownedTiles: number; areas: PathTileInfo[][]; workCounts: number[] }
): void {
	pathTilesCountStore.set(result.pathTiles.length);
	queueTilesCountStore.set(result.queueTiles.length);
	gardenTilesCountStore.set(gardeningResult.gardenTiles);
	gardenAreaSizesStore.set(gardeningResult.workCounts);
	rideExitCountStore.set(countRideExits());
	ownedTilesCountStore.set(gardeningResult.ownedTiles);

	lastAllPathTiles = result.allTiles;
	lastGardenAreas = gardeningResult.areas;

	tilesCalculatedStore.set(true);

	parkEntranceInfoStore.set("");
}

// Finds the park entrance, then walks the footpath network from it, and scans
// the park's owned tiles for gardening tiles. Stores the resulting
// path/queue/mowable/waterable tile counts.
//
// The gardening sweep is spread across game ticks so a large map doesn't block
// the game loop; `onComplete` (if given) fires once the results are published.
export function scanFootpathNetwork(onComplete?: () => void): void {
	// A full rescan is the point at which the park's installed surface objects
	// may have changed, so drop the memoised grass-style set first.
	invalidateGrassSurfaceStyleCache();
	const parkEntranceTiles = findParkEntranceTiles();
	if (parkEntranceTiles.length === 0) {
		if (onComplete) {
			onComplete();
		}
		return;
	}

	const result = scanFootpathNetworkFromEntrance(parkEntranceTiles[0]);

	const state = newGardeningSweepState();
	const mapSize = gameMap().size;
	let x = 0;

	function step(): void {
		const end = Math.min(mapSize.x, x + COLUMNS_PER_TICK);
		for (; x < end; x++) {
			scanGardeningColumn(x, state);
		}
		if (x < mapSize.x) {
			gameContext().setTimeout(step, SCAN_TICK_DELAY);
			return;
		}
		publishScanResults(result, groupGardeningTiles(state));
		if (onComplete) {
			onComplete();
		}
	}

	step();
}

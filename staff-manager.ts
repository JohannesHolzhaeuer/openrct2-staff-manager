/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, checkbox,
	store as flexStore, compute, isStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, WritableStore, Bindable,
	Scale
} from "openrct2-flexui";
import { t } from "./src/i18n";
/*****************************************************************************
 * Staff Manager
 * ---------------------------------------------------------------------------
 * This is a from-scratch rebuild of the plugin's UI, based on the mockup in
 * ui-mockup.drawio. This version only lays out the window and widgets; it
 * does not implement any staff-management functionality yet.
 *
 * Author: Johannes Holzhäuer
 * Licence: MIT
 *****************************************************************************/

// --- Staff calculation stores -------------------------------------------------
// Raw tile/entity counts produced by the scan functions. Needed staff counts
// are derived from these via `compute`, so they automatically recompute
// whenever a scan re-runs or a "tiles per staff"-style spinner changes.
const pathTilesCountStore = flexStore<number>(0);
const queueTilesCountStore = flexStore<number>(0);
const gardenTilesCountStore = flexStore<number>(0);
// Tile counts of each disconnected gardening area (connected component), so
// the needed-gardener count can guarantee at least one gardener per
// component instead of just dividing the grand total by tiles-per-staff
// (which could round down to fewer gardeners than there are components,
// leaving some areas with none).
const gardenAreaSizesStore = flexStore<number[]>([]);
const rideExitCountStore = flexStore<number>(0);

const handymenTilesPerStaffStore = flexStore<number>(8);
const handymenMowerTilesPerStaffStore = flexStore<number>(256);
const guardsTilesPerStaffStore = flexStore<number>(16);
const entertainersTilesPerStaffStore = flexStore<number>(16);
const entertainersPerAreaStore = flexStore<number>(2);
const entertainersIncludeQueueStore = flexStore<boolean>(true);

// Whether each staff type is enabled. When a staff type is disabled, it is
// treated as needing 0 staff (so "Adjust staff count" fires everyone of that
// type) and "Assign" skips it entirely. Its spinners/toggles/labels are also
// disabled in the UI.
const handymenEnabledStore = flexStore<boolean>(true);
const guardsEnabledStore = flexStore<boolean>(true);
const entertainersEnabledStore = flexStore<boolean>(true);
const mechanicsEnabledStore = flexStore<boolean>(true);

// Handymen are needed both to clean up the path/queue network (Cleanup) and
// to mow/water the park's garden tiles (Gardening). These are tracked as
// separate needed counts (used when hiring/firing specialised handymen) and
// summed for the single "Needed" row shown in the UI.
const handymenCleanupNeededStore = compute(pathTilesCountStore, queueTilesCountStore, handymenTilesPerStaffStore, handymenEnabledStore,
	function (path: number, queue: number, tilesPerStaff: number, enabled: boolean) {
		return enabled ? computeNeeded(path + queue, tilesPerStaff) : 0;
	});
const handymenGardeningNeededStore = compute(gardenAreaSizesStore, handymenMowerTilesPerStaffStore, handymenEnabledStore,
	function (areaSizes: number[], mowerTilesPerStaff: number, enabled: boolean) {
		if (!enabled) {
			return 0;
		}
		// Sum of each area's own needed count, so every disconnected area
		// gets at least one gardener (as long as it has any tiles), rather
		// than allocating gardeners against the grand total tile count.
		return areaSizes.reduce(function (sum, size) { return sum + computeNeeded(size, mowerTilesPerStaff); }, 0);
	});
const handymenNeededStore = compute(handymenCleanupNeededStore, handymenGardeningNeededStore,
	function (cleanup: number, gardening: number) { return cleanup + gardening; });

// Guards only patrol plain pathway tiles, not queue tiles.
const guardsNeededStore = compute(pathTilesCountStore, guardsTilesPerStaffStore, guardsEnabledStore,
	function (path: number, tilesPerStaff: number, enabled: boolean) {
		return enabled ? computeNeeded(path, tilesPerStaff) : 0;
	});

// Entertainers patrol path tiles (and queue tiles, if the "Queue" toggle is
// on), but multiple entertainers can be assigned to each patrol area.
const entertainersNeededBaseStore = compute(
	pathTilesCountStore, queueTilesCountStore, entertainersIncludeQueueStore, entertainersTilesPerStaffStore, entertainersPerAreaStore,
	function (path: number, queue: number, includeQueue: boolean, tilesPerStaff: number, perArea: number) {
		const tiles = path + (includeQueue ? queue : 0);
		return computeNeeded(tiles, tilesPerStaff) * Math.max(perArea, 0);
	});
const entertainersNeededStore = compute(entertainersNeededBaseStore, entertainersEnabledStore,
	function (needed: number, enabled: boolean) { return enabled ? needed : 0; });

// One mechanic is needed per ride exit in the park.
const mechanicsNeededStore = compute(rideExitCountStore, mechanicsEnabledStore,
	function (rideExits: number, enabled: boolean) { return enabled ? rideExits : 0; });

const handymenHiredStore = flexStore<number>(0);
const handymenAssignedStore = flexStore<number>(0);
const guardsHiredStore = flexStore<number>(0);
const guardsAssignedStore = flexStore<number>(0);
const entertainersHiredStore = flexStore<number>(0);
const entertainersAssignedStore = flexStore<number>(0);
const mechanicsHiredStore = flexStore<number>(0);
const mechanicsAssignedStore = flexStore<number>(0);

// Whether the tile counts have been calculated yet. Until this is true, all
// spinners and stat text within the staff group boxes are disabled.
const tilesCalculatedStore = flexStore<boolean>(false);
const staffControlsDisabledStore = compute(tilesCalculatedStore, function (calculated) { return !calculated; });

// Per-staff-type "disabled" stores for the spinners/toggles/labels within
// each staff group box: disabled whenever the general controls are disabled
// (tiles not yet calculated) OR the staff type's own "Enabled" toggle is off.
function controlsDisabledFor(enabled: Store<boolean>): Store<boolean> {
	return compute(staffControlsDisabledStore, enabled, function (controlsDisabled: boolean, isEnabled: boolean) {
		return controlsDisabled || !isEnabled;
	});
}
const handymenControlsDisabledStore = controlsDisabledFor(handymenEnabledStore);
const guardsControlsDisabledStore = controlsDisabledFor(guardsEnabledStore);
const entertainersControlsDisabledStore = controlsDisabledFor(entertainersEnabledStore);
const mechanicsControlsDisabledStore = controlsDisabledFor(mechanicsEnabledStore);

// Whether every staff type's Needed count matches its Hired count, i.e.
// there is nothing left to adjust. `compute` only supports up to 5 stores at
// once, so the staff types are combined in two steps.
const noHandymenOrGuardsDifferenceStore = compute(
	handymenNeededStore, handymenHiredStore, guardsNeededStore, guardsHiredStore,
	function (handymenNeeded: number, handymenHired: number, guardsNeeded: number, guardsHired: number) {
		return handymenNeeded === handymenHired && guardsNeeded === guardsHired;
	});
const noStaffDifferenceStore = compute(
	noHandymenOrGuardsDifferenceStore, entertainersNeededStore, entertainersHiredStore, mechanicsNeededStore, mechanicsHiredStore,
	function (noHandymenOrGuardsDifference: boolean, entertainersNeeded: number, entertainersHired: number,
		mechanicsNeeded: number, mechanicsHired: number) {
		return noHandymenOrGuardsDifference && entertainersNeeded === entertainersHired && mechanicsNeeded === mechanicsHired;
	});
const adjustButtonDisabledStore = compute(
	staffControlsDisabledStore, noStaffDifferenceStore,
	function (controlsDisabled: boolean, noStaffDifference: boolean) {
		return controlsDisabled || noStaffDifference;
	});

// --- Park entrance detection ---------------------------------------------------
// Text shown at the top of the window describing where the park entrance was found.
// Not translated via t() here: this initial value only exists for the brief
// moment before openWindow() triggers a scan and overwrites it (t() must not
// be called at module-load time - see src/i18n/index.ts for why).
const parkEntranceInfoStore = flexStore<string>("Path tiles: 0, Queue tiles: 0, Garden tiles: 0");

// Builds the set of tile keys (in "x,y" tile-coordinate form) that are occupied
// by a real ride entrance or exit, so they can be excluded when looking for the
// park entrance. A park entrance can share a "ride" id with an unrelated ride,
// so ride ids on entrance tile elements cannot be used to tell them apart.
function getRideEntranceExitTileKeys(): Set<string> {
	const tileKeys = new Set<string>();
	const rides = map.rides;
	for (let i = 0; i < rides.length; i++) {
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length; s++) {
			const station = stations[s];
			// Floor to tile coordinates so these keys match the integer-tile
			// keys used by findParkEntranceTiles/isValidStationExit. Using raw
			// "x / 32" would produce a fractional key (e.g. "5.5,3") for any
			// non-tile-aligned coordinate, which would never match and could
			// let a ride entrance/exit be misdetected as the park entrance.
			if (station.entrance) {
				tileKeys.add(Math.floor(station.entrance.x / 32) + "," + Math.floor(station.entrance.y / 32));
			}
			if (station.exit) {
				tileKeys.add(Math.floor(station.exit.x / 32) + "," + Math.floor(station.exit.y / 32));
			}
		}
	}
	return tileKeys;
}

// Scans the whole map for "entrance" tile elements that are not a ride entrance
// or exit; the remaining entrance element(s) are the park entrance(s).
function findParkEntranceTiles(): CoordsXY[] {
	const rideEntranceExitTileKeys = getRideEntranceExitTileKeys();
	const mapSize = map.size;
	const parkEntranceTiles: CoordsXY[] = [];
	for (let x = 0; x < mapSize.x; x++) {
		for (let y = 0; y < mapSize.y; y++) {
			const tileKey = x + "," + y;
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
				if (element.type === "entrance" && (element as EntranceElement).sequence === 0) {
					parkEntranceTiles.push({ x: x, y: y });
				}
			}
		}
	}
	return parkEntranceTiles;
}

// Finds the park entrance tile(s) and logs the result. Returns the tiles so
// callers (like the footpath scan) can reuse them without scanning twice.
function findAndReportParkEntrance(): CoordsXY[] {
	const parkEntranceTiles = findParkEntranceTiles();
	if (parkEntranceTiles.length === 0) {
		parkEntranceInfoStore.set(t("parkEntrance.notFound"));
		return parkEntranceTiles;
	}
	return parkEntranceTiles;
}

// --- Footpath network scan ------------------------------------------------------
// A single visited path/queue tile: its tile coordinates plus the base height of
// the footpath element that was found on it.
interface PathTileInfo {
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

// Cardinal neighbour offsets used to walk the footpath network tile by tile.
const CARDINAL_NEIGHBOUR_OFFSETS: CoordsXY[] = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 }
];
// OpenRCT2 stores tile-element directions as 0=-X, 1=+Y, 2=+X, 3=-Y. This
// ordering does NOT match CARDINAL_NEIGHBOUR_OFFSETS, so a stored direction
// (e.g. a ride exit's facing direction) must be mapped through this table
// rather than used to index CARDINAL_NEIGHBOUR_OFFSETS directly.
const DIRECTION_OFFSETS: CoordsXY[] = [
	{ x: -1, y: 0 },
	{ x: 0, y: 1 },
	{ x: 1, y: 0 },
	{ x: 0, y: -1 }
];

function tileKey(x: number, y: number): string {
	return x + "," + y;
}

// A footpath element on a tile, reduced to what is needed to reason about
// whether staff can walk from it onto a neighbouring tile.
interface FootpathInfo {
	baseHeight: number;
	baseZ: number;
	isQueue: boolean;
	slopeDirection: number | null;
}

// The vertical size (in baseZ units) a sloped footpath spans: a footpath
// slope always climbs exactly one height level, which is two baseHeight
// steps, i.e. 16 baseZ units.
const FOOTPATH_SLOPE_HEIGHT = 16;

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
			const footpathElement = element as FootpathElement;
			result.push({
				baseHeight: footpathElement.baseHeight,
				baseZ: footpathElement.baseZ,
				isQueue: footpathElement.isQueue,
				slopeDirection: footpathElement.slopeDirection
			});
		}
	}
	return result;
}

// The world height of a footpath at the edge facing the given direction
// (using OpenRCT2's 0=-X, 1=+Y, 2=+X, 3=-Y direction convention). A flat
// path is at baseZ all around; a sloped path is at baseZ on three edges and
// one level higher on the edge it slopes up towards.
function footpathEdgeZ(footpath: FootpathInfo, direction: number): number {
	return footpath.slopeDirection === direction ? footpath.baseZ + FOOTPATH_SLOPE_HEIGHT : footpath.baseZ;
}

function oppositeDirection(direction: number): number {
	return (direction + 2) % 4;
}

// Whether staff can step from the given footpath onto a footpath on the
// neighbouring tile in the given direction: the two paths must meet at the
// same height on their shared edge. This is what makes a patrol area
// genuinely walkable - x/y adjacency alone would happily join a path on a
// bridge to the path passing underneath it.
function footpathsConnect(from: FootpathInfo, to: FootpathInfo, direction: number): boolean {
	return footpathEdgeZ(from, direction) === footpathEdgeZ(to, oppositeDirection(direction));
}

// Finds the surface element on a tile, if any.
function findSurfaceElement(tile: Tile): SurfaceElement | null {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "surface") {
			return element as SurfaceElement;
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
function surfacesConnect(from: SurfaceElement | null, to: SurfaceElement | null): boolean {
	if (!isLandSurface(from) || !isLandSurface(to)) {
		return false;
	}
	return Math.abs((from as SurfaceElement).baseHeight - (to as SurfaceElement).baseHeight) <= MAX_WALKABLE_HEIGHT_DIFFERENCE;
}

// Whether a surface tile is dry land rather than water. In OpenRCT2, water is
// not a separate tile/element type: it's stored as a waterHeight on the
// surface element itself, so a perfectly "grass"-styled surface can still be
// submerged. Handymen (mowing/watering) must never be sent onto such tiles -
// they can't stand on water - so this must be checked in addition to the
// surface style.
function isLandSurface(surface: SurfaceElement | null): boolean {
	return !!surface && surface.waterHeight === 0;
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
		const current = stack.pop() as PendingStep;

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

		for (let f = 0; f < footpaths.length; f++) {
			const footpath = footpaths[f];
			// Only step onto this path if it actually meets the path we came
			// from at the same height.
			if (current.z !== null && footpathEdgeZ(footpath, current.fromDirection) !== current.z) {
				continue;
			}

			const nodeKey = current.x + "," + current.y + "," + footpath.baseZ;
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
				let connects = false;
				for (let n = 0; n < neighbourFootpaths.length; n++) {
					if (footpathsConnect(footpath, neighbourFootpaths[n], d)) {
						connects = true;
						break;
					}
				}
				if (!connects) {
					continue;
				}
				// Record the walkable link between the two tiles (both ends,
				// once both tiles are known to be part of the park's network).
				if (info) {
					const neighbourKey = tileKey(neighbour.x, neighbour.y);
					if (info.neighbourKeys.indexOf(neighbourKey) === -1) {
						info.neighbourKeys.push(neighbourKey);
					}
					const neighbourInfo = tilesByKey.get(neighbourKey);
					if (neighbourInfo && neighbourInfo.neighbourKeys.indexOf(key) === -1) {
						neighbourInfo.neighbourKeys.push(key);
					}
				}
				stack.push({ x: neighbour.x, y: neighbour.y, z: edgeZ, fromDirection: oppositeDirection(d) });
			}
		}
	}

	return { pathTiles: pathTiles, queueTiles: queueTiles, allTiles: allTiles };
}

// --- Cached scan results (for Assign) ---------------------------------------------
// The most recent footpath/queue tiles (in BFS visitation order, so slicing
// them into consecutive chunks keeps each chunk spatially local) and garden
// tile connected components, kept around so the Assign button can build
// patrol areas without re-scanning the map.
let lastAllPathTiles: PathTileInfo[] = [];
let lastGardenAreas: PathTileInfo[][] = [];

// Finds the park entrance, then walks the footpath network from it, and scans
// the park's owned tiles for gardening tiles. Logs and stores the resulting
// path/queue/mowable/waterable tile counts.
function scanFootpathNetwork(): void {
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

// Counts the number of ride exits in the park; one mechanic is needed per
// ride exit. Only actual rides count - shops/stalls and facilities (e.g. a
// T-shirt shop) are excluded via their classification, since mechanics
// service ride vehicles/track, not shops. Unused station slots (a ride's
// "stations" array can be longer than its actual station count) report an
// exit at a sentinel/out-of-bounds coordinate rather than null, so those are
// filtered out by checking the resulting tile is within the map.
function countRideExits(): number {
	const rides = map.rides;
	let count = 0;
	for (let i = 0; i < rides.length; i++) {
		if (rides[i].classification !== "ride") {
			continue;
		}
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length; s++) {
			if (isValidStationExit(stations[s].exit)) {
				count++;
			}
		}
	}
	return count;
}

// Whether a station's exit coordinate is a real, in-use exit rather than an
// unused station slot's sentinel value. OpenRCT2 always populates
// RideStation.exit/entrance (they're never actually null despite existing
// checks against falsy values), so unused slots must instead be detected by
// their coordinates falling outside the map bounds.
function isValidStationExit(exit: CoordsXYZD | null | undefined): exit is CoordsXYZD {
	if (!exit) {
		return false;
	}
	const tileX = Math.floor(exit.x / 32);
	const tileY = Math.floor(exit.y / 32);
	return tileX >= 0 && tileY >= 0 && tileX < map.size.x && tileY < map.size.y;
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
			const sceneryElement = element as SmallSceneryElement;
			const sceneryObject = objectManager.getObject("small_scenery", sceneryElement.object);
			if (sceneryObject && (sceneryObject.flags & SMALL_SCENERY_FLAG_CAN_BE_WATERED) !== 0) {
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
	for (let i = 0; i < surfaceObjects.length; i++) {
		const identifier = surfaceObjects[i].identifier.toLowerCase();
		if (identifier.indexOf("grass") !== -1) {
			result.add(surfaceObjects[i].index);
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
			const isMowable = isLandSurface(surface) && grassSurfaceStyleIndices.has((surface as SurfaceElement).surfaceStyle);
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
			const current = stack.pop() as CoordsXY;
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
			for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
				const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
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
				if (neighbourInfo && neighbourInfo.neighbourKeys.indexOf(currentKey) === -1) {
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

function computeNeeded(totalTiles: number, tilesPerStaff: number): number {
	if (tilesPerStaff <= 0 || totalTiles <= 0) {
		return 0;
	}
	return Math.ceil(totalTiles / tilesPerStaff);
}

// Refreshes the Hired/Assigned stores for Handymen, Guards and Mechanics from
// the current, real-time staff roster. Unlike Needed (which depends on the
// potentially slow tile scan), this is cheap and can be refreshed whenever
// Calculate is pressed.
function refreshHiredAndAssignedStaffCounts(): void {
	handymenHiredStore.set(countHiredStaff("handyman"));
	handymenAssignedStore.set(countAssignedStaff("handyman"));
	guardsHiredStore.set(countHiredStaff("security"));
	guardsAssignedStore.set(countAssignedStaff("security"));
	entertainersHiredStore.set(countHiredStaff("entertainer"));
	entertainersAssignedStore.set(countAssignedStaff("entertainer"));
	mechanicsHiredStore.set(countHiredStaff("mechanic"));
	mechanicsAssignedStore.set(countAssignedStaff("mechanic"));
}

// Counts the number of currently hired staff of a given type (e.g. handyman,
// security), and how many of those already have a non-empty patrol area
// (i.e. are already "assigned" to patrol a section of the park).
function countHiredStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (let i = 0; i < staff.length; i++) {
		if (staff[i].staffType === staffType) {
			count++;
		}
	}
	return count;
}

function countAssignedStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (let i = 0; i < staff.length; i++) {
		const member = staff[i];
		if (member.staffType === staffType && member.patrolArea.tiles.length > 0) {
			count++;
		}
	}
	return count;
}

// --- Hire / fire ----------------------------------------------------------------
// Handyman "orders" bitmask values (see StaffHireArgs/StaffSetOrdersArgs):
// Sweeping = 1, Watering flowers = 2, Empty bins = 4, Mowing = 8.
const HANDYMAN_ORDER_SWEEPING = 1;
const HANDYMAN_ORDER_WATERING = 2;
const HANDYMAN_ORDER_EMPTY_BINS = 4;
const HANDYMAN_ORDER_MOWING = 8;
// Cleanup handymen empty bins and sweep litter.
const HANDYMAN_ORDERS_CLEANUP = HANDYMAN_ORDER_SWEEPING | HANDYMAN_ORDER_EMPTY_BINS;
// Gardening handymen water flowers and mow lawns.
const HANDYMAN_ORDERS_GARDENING = HANDYMAN_ORDER_WATERING | HANDYMAN_ORDER_MOWING;

// Mechanic "orders" bitmask values: Inspect rides = 1, Fix rides = 2.
const MECHANIC_ORDERS_DEFAULT = 1 | 2;

// Staff type ids used by the "staffhire" game action.
const STAFF_TYPE_ID_HANDYMAN = 0;
const STAFF_TYPE_ID_MECHANIC = 1;
const STAFF_TYPE_ID_SECURITY = 2;
const STAFF_TYPE_ID_ENTERTAINER = 3;

type HandymanPurpose = "cleanup" | "gardening";

// A handyman is considered a "gardening" handyman if any of their orders are
// watering/mowing, and a "cleanup" handyman otherwise (this also covers
// freshly hired handymen with no orders set yet).
function classifyHandyman(member: Handyman): HandymanPurpose {
	return (member.orders & HANDYMAN_ORDERS_GARDENING) !== 0 ? "gardening" : "cleanup";
}

function getHandymenByPurpose(purpose: HandymanPurpose): Handyman[] {
	const staff = map.getAllEntities("staff");
	const result: Handyman[] = [];
	for (let i = 0; i < staff.length; i++) {
		const member = staff[i];
		if (member.staffType === "handyman" && classifyHandyman(member as Handyman) === purpose) {
			result.push(member as Handyman);
		}
	}
	return result;
}

function getStaffByType(staffType: StaffType): Staff[] {
	const staff = map.getAllEntities("staff");
	const result: Staff[] = [];
	for (let i = 0; i < staff.length; i++) {
		if (staff[i].staffType === staffType) {
			result.push(staff[i] as Staff);
		}
	}
	return result;
}

// Fires the given number of staff members, oldest first (lowest entity id
// first, since entity ids are assigned in creation order and are not reused
// while the entity is alive). Invokes onActionComplete once per action after
// its callback has fired (regardless of success/failure).
function fireOldestStaff(members: Staff[], countToFire: number, onActionComplete: () => void): void {
	const sorted = members.slice().sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
	for (let i = 0; i < countToFire && i < sorted.length; i++) {
		const id = sorted[i].id;
		if (id !== null) {
			context.executeAction("stafffire", { id: id }, function () { onActionComplete(); });
		} else {
			onActionComplete();
		}
	}
}

// Identifiers (or parts thereof) of peep_animations objects that represent
// entertainer costumes, as opposed to handyman/mechanic/security costumes.
// Mirrors the non-staff entries of the StaffCostume type.
const ENTERTAINER_COSTUME_IDENTIFIER_PARTS = [
	"panda", "tiger", "elephant", "roman", "gorilla", "snowman", "knight", "astronaut", "bandit", "sheriff", "pirate"
];

// Finds all loaded peep_animations object indices that are valid entertainer
// costumes (mirrors the non-staff entries of the StaffCostume type).
function findEntertainerCostumeIndices(): number[] {
	const peepAnimationObjects = objectManager.getAllObjects("peep_animations");
	const result: number[] = [];
	for (let i = 0; i < peepAnimationObjects.length; i++) {
		const identifier = peepAnimationObjects[i].identifier.toLowerCase();
		for (let p = 0; p < ENTERTAINER_COSTUME_IDENTIFIER_PARTS.length; p++) {
			if (identifier.indexOf(ENTERTAINER_COSTUME_IDENTIFIER_PARTS[p]) !== -1) {
				result.push(peepAnimationObjects[i].index);
				break;
			}
		}
	}
	return result;
}

// Finds a loaded peep_animations object index that is a valid costume for the
// given staff type. Handymen/mechanics/security use costume index 0 (their
// default costume); entertainers must use one of the loaded entertainer
// costume objects (picked at random), since costume 0 is the handyman
// costume and is rejected by the game for entertainers. Returns -1 if no
// valid costume exists (only possible for entertainers when no entertainer
// costume objects are loaded), so the caller can skip the hire instead of
// issuing one with costume 0 that the game would silently reject.
function findCostumeIndexForStaffType(staffTypeId: number): number {
	if (staffTypeId !== STAFF_TYPE_ID_ENTERTAINER) {
		return 0;
	}

	const entertainerCostumeIndices = findEntertainerCostumeIndices();
	if (entertainerCostumeIndices.length === 0) {
		return -1;
	}

	return entertainerCostumeIndices[Math.floor(Math.random() * entertainerCostumeIndices.length)];
}

// Hires the given number of new staff of the given type, applying the given
// orders bitmask (only relevant for handymen/mechanics). Each hired staff
// member gets its own randomly picked costume (relevant for entertainers).
// Invokes onActionComplete once per action after its callback has fired.
function hireStaff(staffTypeId: number, orders: number, countToHire: number, onActionComplete: () => void): void {
	for (let i = 0; i < countToHire; i++) {
		const costumeIndex = findCostumeIndexForStaffType(staffTypeId);
		if (costumeIndex < 0) {
			// No valid costume for this staff type (e.g. entertainer with no
			// entertainer costume objects loaded). Skip the hire, but still
			// invoke the completion callback so the pending-action counter in
			// adjustStaffCounts stays balanced and the UI still refreshes.
			onActionComplete();
			continue;
		}
		context.executeAction("staffhire", {
			autoPosition: true,
			staffType: staffTypeId,
			costumeIndex: costumeIndex,
			staffOrders: orders
		}, function () { onActionComplete(); });
	}
}

// Hires or fires handymen of a specific purpose (cleanup/gardening) to match
// the needed count, firing the oldest first when there is a surplus. Invokes
// onActionComplete once per hire/fire action after it completes.
function adjustHandymen(purpose: HandymanPurpose, needed: number, onActionComplete: () => void): void {
	const current = getHandymenByPurpose(purpose);
	const difference = needed - current.length;
	if (difference > 0) {
		const orders = purpose === "cleanup" ? HANDYMAN_ORDERS_CLEANUP : HANDYMAN_ORDERS_GARDENING;
		hireStaff(STAFF_TYPE_ID_HANDYMAN, orders, difference, onActionComplete);
	} else if (difference < 0) {
		fireOldestStaff(current, -difference, onActionComplete);
	}
}

// Hires or fires staff of a given type to match the needed count, firing the
// oldest first when there is a surplus. Invokes onActionComplete once per
// hire/fire action after it completes.
function adjustStaffOfType(staffType: StaffType, staffTypeId: number, orders: number, needed: number, onActionComplete: () => void): void {
	const current = getStaffByType(staffType);
	const difference = needed - current.length;
	if (difference > 0) {
		hireStaff(staffTypeId, orders, difference, onActionComplete);
	} else if (difference < 0) {
		fireOldestStaff(current, -difference, onActionComplete);
	}
}

// Adjusts the number of hired staff of every type to match the currently
// calculated Needed counts: hires more if understaffed, fires the oldest
// staff first if overstaffed. The Hired/Assigned/Difference stats are
// refreshed once all the queued hire/fire game actions have completed, so
// the UI updates instantly and accurately (executeAction is asynchronous).
function adjustStaffCounts(): void {
	let pendingCount = 0;
	const onActionComplete: () => void = function () {
		pendingCount--;
		if (pendingCount <= 0) {
			refreshHiredAndAssignedStaffCounts();
		}
	};

	// Snapshot the needed counts and current staff before issuing any actions,
	// then count how many actions will be queued so we know when they're all done.
	const handymenCleanupNeeded = handymenCleanupNeededStore.get();
	const handymenGardeningNeeded = handymenGardeningNeededStore.get();
	const guardsNeeded = guardsNeededStore.get();
	const entertainersNeeded = entertainersNeededStore.get();
	const mechanicsNeeded = mechanicsNeededStore.get();

	const handymenCleanupCurrent = getHandymenByPurpose("cleanup").length;
	const handymenGardeningCurrent = getHandymenByPurpose("gardening").length;
	const guardsCurrent = getStaffByType("security").length;
	const entertainersCurrent = getStaffByType("entertainer").length;
	const mechanicsCurrent = getStaffByType("mechanic").length;

	pendingCount += Math.abs(handymenCleanupNeeded - handymenCleanupCurrent);
	pendingCount += Math.abs(handymenGardeningNeeded - handymenGardeningCurrent);
	pendingCount += Math.abs(guardsNeeded - guardsCurrent);
	pendingCount += Math.abs(entertainersNeeded - entertainersCurrent);
	pendingCount += Math.abs(mechanicsNeeded - mechanicsCurrent);

	if (pendingCount === 0) {
		refreshHiredAndAssignedStaffCounts();
		return;
	}

	adjustHandymen("cleanup", handymenCleanupNeeded, onActionComplete);
	adjustHandymen("gardening", handymenGardeningNeeded, onActionComplete);
	adjustStaffOfType("security", STAFF_TYPE_ID_SECURITY, 0, guardsNeeded, onActionComplete);
	adjustStaffOfType("entertainer", STAFF_TYPE_ID_ENTERTAINER, 0, entertainersNeeded, onActionComplete);
	adjustStaffOfType("mechanic", STAFF_TYPE_ID_MECHANIC, MECHANIC_ORDERS_DEFAULT, mechanicsNeeded, onActionComplete);
}

// --- Assign patrol areas --------------------------------------------------------
// Converts a tile coordinate to the world (32-per-tile) coordinate used by
// patrol areas.
function tileToWorldXY(x: number, y: number): CoordsXY {
	return { x: x * 32, y: y * 32 };
}

// Teleports a staff member to the centre of the given tile, at the given
// world z height, via the "peeppickup" game action (pick the staff member
// up, then place them down at the target position).
//
// The game only supports one peep being "picked up" at a time (it's the same
// mechanic as the player dragging a peep with the cursor), so pickup/place
// requests for different staff members must never overlap - otherwise a
// later pickup can clobber an earlier one before its "place" has fired,
// causing staff to be placed at each other's target tiles. All teleports are
// therefore funnelled through a single queue that only runs one pickup+place
// pair at a time (see queueTeleport/processTeleportQueue below).
interface PendingTeleport {
	id: number;
	x: number;
	y: number;
	z: number;
}
const teleportQueue: PendingTeleport[] = [];
let teleportInProgress = false;

function processTeleportQueue(): void {
	if (teleportInProgress) {
		return;
	}
	const next = teleportQueue.shift();
	if (!next) {
		return;
	}
	teleportInProgress = true;
	context.executeAction("peeppickup", { type: 0, id: next.id, x: 0, y: 0, z: 0, playerId: 0 }, function (pickupResult) {
		if (pickupResult.error) {
			teleportInProgress = false;
			processTeleportQueue();
			return;
		}
		context.executeAction("peeppickup", { type: 2, id: next.id, x: next.x, y: next.y, z: next.z, playerId: 0 }, function () {
			teleportInProgress = false;
			processTeleportQueue();
		});
	});
}

function teleportStaffToTile(member: Staff, x: number, y: number, z: number): void {
	const id = member.id;
	if (id === null) {
		return;
	}
	teleportQueue.push({ id: id, x: x * 32 + 16, y: y * 32 + 16, z: z });
	processTeleportQueue();
}

// Splits the given tile list into contiguous (spatially connected) chunks,
// each roughly totalTiles/staffCount tiles large. Unlike a naive index-based
// slice of the (DFS/BFS) visitation order - which can silently jump between
// unrelated branches or unrelated connected components and produce a "chunk"
// made of disjoint patches - this grows each chunk outward tile-by-tile via
// cardinal adjacency, so every chunk it returns is guaranteed to be one
// connected group of tiles. If the tile network is itself split into several
// disconnected pockets (e.g. separate garden areas), a chunk's growth simply
// stops once its local pocket is exhausted, which can result in more chunks
// than staffCount; callers should merge/ignore any surplus as appropriate.
function chunkTilesForStaffCount(tiles: PathTileInfo[], staffCount: number): PathTileInfo[][] {
	if (staffCount <= 0 || tiles.length === 0) {
		return [];
	}
	const targetSize = Math.ceil(tiles.length / staffCount);

	const tileByKey = new Map<string, PathTileInfo>();
	const order: string[] = [];
	for (let i = 0; i < tiles.length; i++) {
		const key = tileKey(tiles[i].x, tiles[i].y);
		if (!tileByKey.has(key)) {
			tileByKey.set(key, tiles[i]);
			order.push(key);
		}
	}

	const remaining = new Set<string>(order);
	const chunks: PathTileInfo[][] = [];

	while (remaining.size > 0) {
		let startKey: string | null = null;
		for (let i = 0; i < order.length; i++) {
			if (remaining.has(order[i])) {
				startKey = order[i];
				break;
			}
		}
		if (startKey === null) {
			break;
		}

		const region: PathTileInfo[] = [];
		const queue: string[] = [startKey];
		remaining.delete(startKey);
		let queueIndex = 0;

		while (queueIndex < queue.length && region.length < targetSize) {
			const key = queue[queueIndex];
			queueIndex++;
			const current = tileByKey.get(key) as PathTileInfo;
			region.push(current);
			if (region.length >= targetSize) {
				break;
			}
			for (let i = 0; i < current.neighbourKeys.length; i++) {
				const neighbourKey = current.neighbourKeys[i];
				if (remaining.has(neighbourKey)) {
					remaining.delete(neighbourKey);
					queue.push(neighbourKey);
				}
			}
		}

			// Any tiles enqueued but not yet processed (because the region hit
				// targetSize first) haven't actually been consumed - put them back
				// so later chunks can still use them.
				for (; queueIndex < queue.length; queueIndex++) {
					remaining.add(queue[queueIndex]);
				}

				chunks.push(region);
			}

			// The tile set may consist of several disconnected pockets (e.g.
			// separate lawn patches split apart by paths or rides, or paths at
			// heights that cannot be reached from one another), each of which
			// produces its own chunk above. If that leaves more chunks than
			// there are staff to assign them to, the surplus chunks would
			// otherwise be silently dropped by callers that only iterate up to
			// staffCount, leaving some areas with no assigned staff at all. To
			// avoid that, repeatedly merge the smallest chunk into a chunk it
			// is actually *connected* to, so every resulting patrol area stays
			// one contiguous, fully walkable piece. Chunks that share no
			// walkable link are never merged (that is exactly what used to
			// produce patrol areas a handyman got stuck in); if nothing can be
			// merged any more, the surplus chunks are kept and the largest
			// areas are assigned first.
			while (chunks.length > staffCount) {
				const keySets = chunks.map(function (chunk) {
					const keys = new Set<string>();
					for (let i = 0; i < chunk.length; i++) {
						keys.add(tileKey(chunk[i].x, chunk[i].y));
					}
					return keys;
				});

				let bestA = -1;
				let bestB = -1;
				let bestSize = Number.POSITIVE_INFINITY;
				for (let a = 0; a < chunks.length; a++) {
					for (let b = a + 1; b < chunks.length; b++) {
						if (!chunksConnect(chunks[a], keySets[b])) {
							continue;
						}
						const size = chunks[a].length + chunks[b].length;
						if (size < bestSize) {
							bestSize = size;
							bestA = a;
							bestB = b;
						}
					}
				}

				if (bestA === -1) {
					break;
				}

				chunks[bestA] = chunks[bestA].concat(chunks[bestB]);
				chunks.splice(bestB, 1);
			}

			// With fewer staff than (unmergeable) areas, cover the biggest
			// areas first instead of whichever happened to be found first.
			if (chunks.length > staffCount) {
				chunks.sort(function (a, b) { return b.length - a.length; });
			}

			return chunks;
		}

// Whether any tile of the given chunk has a walkable link into the given set
// of tile keys, i.e. whether the two chunks form one contiguous area.
function chunksConnect(chunk: PathTileInfo[], otherKeys: Set<string>): boolean {
	for (let i = 0; i < chunk.length; i++) {
		const neighbourKeys = chunk[i].neighbourKeys;
		for (let n = 0; n < neighbourKeys.length; n++) {
			if (otherKeys.has(neighbourKeys[n])) {
				return true;
			}
		}
	}
	return false;
}

// Clears every given staff member's patrol area. Used at the start of each
// staff type's (re-)assignment so stale patrol areas don't linger.
function clearPatrolAreas(members: Staff[]): void {
	for (let i = 0; i < members.length; i++) {
		members[i].patrolArea.clear();
	}
}

// Finds the walkable footpath tile (from lastAllPathTiles) closest to the
// given tile, by Manhattan distance, that is actually clear enough for a
// staff member to be placed on (see isPeepPlaceableTile). Used to find a
// safe spot to teleport a staff member to when the tile they'd otherwise be
// placed on (e.g. a gardening tile covered in scenery, or a path tile with
// an obstruction) isn't safe/placeable, since "peeppickup" place fails (e.g.
// "Can't place person here... Swamp Plant in the way") when targeting
// obstructed tiles.
function findNearestPathTile(x: number, y: number): PathTileInfo | null {
	let best: PathTileInfo | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < lastAllPathTiles.length; i++) {
		const tile = lastAllPathTiles[i];
		if (!isPeepPlaceableTile(tile.x, tile.y)) {
			continue;
		}
		const distance = Math.abs(tile.x - x) + Math.abs(tile.y - y);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = tile;
		}
	}
	return best;
}

// Whether a staff member can actually be placed on the given tile via
// "peeppickup". A tile can have a walkable footpath element on it and still
// reject placement because of something else stacked on the same (x, y)
// column: a ride entrance/exit element (even from an unrelated ride placed
// on a bridge/tunnel above or below), an embedded ride track element (e.g.
// mini golf holes, which are technically "footpath" but belong to the
// ride), a large scenery item, or a footpath "addition" (bench, lamp, bin,
// queue TV, or decorative items like a swamp plant). All of these produce a
// "Can't place person here..." error from the game, so they're all treated
// as unsafe teleport targets, even though they may be perfectly fine as
// patrol area tiles.
function isPeepPlaceableTile(x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
		return false;
	}
	const tile = map.getTile(x, y);
	let footpath: FootpathElement | null = null;
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "footpath") {
			footpath = element as FootpathElement;
		} else if (element.type === "entrance" || element.type === "track" || element.type === "large_scenery") {
			return false;
		}
	}
	if (!footpath) {
		return false;
	}
	if (footpath.addition !== null) {
		return false;
	}
	return true;
}

// Assigns one consecutive chunk of the given ordered tile list to each hired
// staff member (only dealing with already-hired staff, per Assign's remit),
// and teleports each staff member to the first placeable tile of their new
// area. The chunk's own first tile isn't necessarily placeable (e.g.
// gardening tiles covered by scenery, or path tiles with an obstruction such
// as a ride entrance/exit or a bench), so the nearest actually-placeable
// tile is used as the teleport target instead; the patrol area itself still
// covers the full chunk regardless.
function assignConsecutiveAreas(members: Staff[], orderedTiles: PathTileInfo[]): void {
	clearPatrolAreas(members);
	if (members.length === 0) {
		return;
	}
	const chunks = chunkTilesForStaffCount(orderedTiles, members.length);
	for (let i = 0; i < chunks.length && i < members.length; i++) {
		const chunk = chunks[i];
		const member = members[i];
		member.patrolArea.add(chunk.map(function (t) { return tileToWorldXY(t.x, t.y); }));
		let teleportTarget: PathTileInfo = chunk[0];
		if (!isPeepPlaceableTile(chunk[0].x, chunk[0].y)) {
			const nearestPathTile = findNearestPathTile(chunk[0].x, chunk[0].y);
			if (nearestPathTile) {
				teleportTarget = nearestPathTile;
			}
		}
		teleportStaffToTile(member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
	}
}

// Assigns gardening areas built from the garden tiles' connected components.
// Unlike a flat/naive approach (concatenating every component into one tile
// list before chunking), each connected component is allocated its own
// dedicated gardener(s) and chunked entirely on its own. This guarantees a
// component that isn't reachable from the rest of the park's lawn (e.g. a
// patch of grass cut off by a path/building) always gets its own patrol
// area and gardener, rather than being merged with a spatially "nearby" but
// actually disconnected component - which would otherwise produce a patrol
// area whose tiles aren't all reachable from one another. Staff are
// allocated across components proportionally to each component's tile
// count (largest-remainder rounding), with at least one gardener per
// component when there are enough gardeners to go around; if there are
// fewer gardeners than components, the smallest components are left
// unassigned (logged) rather than silently merged into an unrelated area.
function assignGardeningAreas(members: Staff[]): void {
	clearPatrolAreas(members);
	if (members.length === 0) {
		return;
	}

	const components = lastGardenAreas.filter(function (area) { return area.length > 0; });
	if (components.length === 0) {
		return;
	}

	const totalTiles = components.reduce(function (sum, area) { return sum + area.length; }, 0);

	// Each component's own needed count (same "max tiles per staff" rule
	// used for the needed-gardener total), guaranteeing every disconnected
	// area gets at least one gardener regardless of its size relative to
	// the others.
	const tilesPerStaff = handymenMowerTilesPerStaffStore.get();
	const desiredCounts = components.map(function (area) { return computeNeeded(area.length, tilesPerStaff); });
	const desiredTotal = desiredCounts.reduce(function (sum, c) { return sum + c; }, 0);

	let counts: number[];
	if (desiredTotal === members.length) {
		// Exactly enough gardeners hired to cover every area's own need;
		// use the per-area counts directly.
		counts = desiredCounts;
	} else {
		// Hired count doesn't match total need (e.g. hiring/firing hasn't
		// caught up yet); fall back to a largest-remainder allocation of
		// the actually-available gardeners, proportional to tile count.
		const allocations = components.map(function (area) {
			return (area.length / totalTiles) * members.length;
		});
		counts = allocations.map(Math.floor);
		const assignedTotal = counts.reduce(function (sum, c) { return sum + c; }, 0);
		let remainder = members.length - assignedTotal;

		// Distribute leftover gardeners (from flooring) to the components with
		// the largest fractional remainder first.
		const order = components.map(function (_, i) { return i; })
			.sort(function (a, b) { return (allocations[b] - counts[b]) - (allocations[a] - counts[a]); });
		for (let i = 0; i < order.length && remainder > 0; i++) {
			counts[order[i]]++;
			remainder--;
		}

		// If there are more components than gardeners, some components will
		// have received zero gardeners above; ensure the largest components are
		// prioritized to receive at least one by taking from any
		// multiply-allocated component, largest first.
		if (members.length < components.length) {
			const bySizeDesc = components.map(function (area, i) { return i; })
				.sort(function (a, b) { return components[b].length - components[a].length; });
			const newCounts = components.map(function () { return 0; });
			for (let i = 0; i < members.length; i++) {
				newCounts[bySizeDesc[i]] = 1;
			}
			counts = newCounts;
		}
	}

	let memberIndex = 0;
	for (let c = 0; c < components.length; c++) {
		const count = counts[c];
		if (count <= 0) {
			continue;
		}
		const componentMembers = members.slice(memberIndex, memberIndex + count);
		memberIndex += count;

		const chunks = chunkTilesForStaffCount(components[c], componentMembers.length);
		for (let i = 0; i < chunks.length && i < componentMembers.length; i++) {
			const chunk = chunks[i];
			const member = componentMembers[i];
			member.patrolArea.add(chunk.map(function (t) { return tileToWorldXY(t.x, t.y); }));
			let teleportTarget: PathTileInfo = chunk[0];
			if (!isPeepPlaceableTile(chunk[0].x, chunk[0].y)) {
				const nearestPathTile = findNearestPathTile(chunk[0].x, chunk[0].y);
				if (nearestPathTile) {
					teleportTarget = nearestPathTile;
				}
			}
			teleportStaffToTile(member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
		}
	}
}

// Assigns consecutive entertainer areas, putting "perArea" entertainers into
// each patrol area (all sharing the same tiles), rather than one staff
// member per area like the other staff types.
function assignEntertainerAreas(members: Staff[], orderedTiles: PathTileInfo[], perArea: number): void {
	clearPatrolAreas(members);
	if (members.length === 0 || orderedTiles.length === 0 || perArea <= 0) {
		return;
	}
	const areaCount = Math.max(1, Math.ceil(members.length / perArea));
	const chunks = chunkTilesForStaffCount(orderedTiles, areaCount);
	let memberIndex = 0;
	for (let a = 0; a < chunks.length && memberIndex < members.length; a++) {
		const chunk = chunks[a];
		const coords = chunk.map(function (t) { return tileToWorldXY(t.x, t.y); });
		let teleportTarget: PathTileInfo = chunk[0];
		if (!isPeepPlaceableTile(chunk[0].x, chunk[0].y)) {
			const nearestPathTile = findNearestPathTile(chunk[0].x, chunk[0].y);
			if (nearestPathTile) {
				teleportTarget = nearestPathTile;
			}
		}
		for (let p = 0; p < perArea && memberIndex < members.length; p++) {
			const member = members[memberIndex];
			member.patrolArea.add(coords);
			teleportStaffToTile(member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
			memberIndex++;
		}
	}
}

// Finds the footpath element on a tile, if any (mirrors findSurfaceElement).
function findFootpathElement(tile: Tile): FootpathElement | null {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "footpath") {
			return element as FootpathElement;
		}
	}
	return null;
}

// Whether a mechanic can safely be teleported: the API doesn't expose
// whether a mechanic is currently servicing a ride, so this uses the best
// available proxy - a mechanic standing on a footpath tile is walking/idle,
// while one that isn't (e.g. inside a ride's building) is assumed to be
// busy fixing/inspecting it and is left alone.
function canTeleportMechanic(member: Staff): boolean {
	if (member.x === null || member.y === null) {
		return false;
	}
	const tileX = Math.floor(member.x / 32);
	const tileY = Math.floor(member.y / 32);
	return findFootpathElement(map.getTile(tileX, tileY)) !== null;
}

// Assigns mechanics to ride exits: each patrol area consists of just the
// ride exit tile and the path tile directly in front of it. Rather than
// trusting the exit's stored facing direction (which turned out to
// sometimes point to a side of the exit building with no path connected -
// e.g. when the exit is offset from the queue/track - and produced patrol
// areas that weren't reachable from the exit at all), every cardinal
// neighbour of the exit tile is checked and the one that actually has a
// footpath element on it is used. Only runs when exactly enough mechanics
// are hired to cover every ride exit (difference === 0); otherwise does
// nothing, since there's no sensible way to split a single-tile-pair area
// further.
function assignMechanics(): void {
	const mechanics = getStaffByType("mechanic");
	const mechanicsNeeded = mechanicsNeededStore.get();
	if (mechanics.length !== mechanicsNeeded) {
		return;
	}

	// Every mechanic's patrol area is cleared and rebuilt to exactly the exit
	// tile plus the path tile in front of it. Clearing/re-adding a patrol area
	// does NOT physically move a mechanic or interrupt a repair in progress -
	// only teleporting does - so it is safe to reset areas for busy mechanics
	// too. This is important: skipping busy mechanics here would leave any
	// stale, larger patrol area (e.g. a 4x4 block from an earlier version of
	// this plugin) permanently in place, since a busy mechanic would never get
	// its area rebuilt. The teleport below is the only step gated on whether a
	// mechanic is busy.
	clearPatrolAreas(mechanics);

	const rides = map.rides;
	let mechanicIndex = 0;
	for (let i = 0; i < rides.length && mechanicIndex < mechanics.length; i++) {
		if (rides[i].classification !== "ride") {
			continue;
		}
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length && mechanicIndex < mechanics.length; s++) {
			const exit = stations[s].exit;
			if (!isValidStationExit(exit)) {
				continue;
			}

			const exitTileX = Math.floor(exit.x / 32);
			const exitTileY = Math.floor(exit.y / 32);

			let frontTileX: number | null = null;
			let frontTileY: number | null = null;
			let frontFootpath: FootpathElement | null = null;

			// The "front" tile is the footpath the exit actually leads onto.
			// Prefer the exit's stored facing direction (mapped through
			// DIRECTION_OFFSETS, since the game's direction ordering does not
			// match CARDINAL_NEIGHBOUR_OFFSETS), then fall back to whichever
			// cardinal neighbour has a footpath, in case the stored direction
			// doesn't line up with where the path really is (e.g. an exit
			// offset from the queue/track). Selection is based purely on a
			// footpath being present - NOT on peep-placeability - so a path
			// tile carrying an addition (bench, lamp, bin, queue TV) or sharing
			// its column with an unrelated element, which blocks teleporting
			// but is still the correct tile to patrol, is never skipped in
			// favour of an unrelated neighbour.
			const preferredOffset = DIRECTION_OFFSETS[exit.direction] || CARDINAL_NEIGHBOUR_OFFSETS[0];
			const candidateOffsets = [preferredOffset].concat(
				CARDINAL_NEIGHBOUR_OFFSETS.filter(function (o) { return o.x !== preferredOffset.x || o.y !== preferredOffset.y; })
			);
			for (let c = 0; c < candidateOffsets.length; c++) {
				const offset = candidateOffsets[c];
				const candidateX = exitTileX + offset.x;
				const candidateY = exitTileY + offset.y;
				const footpath = findFootpathElement(map.getTile(candidateX, candidateY));
				if (footpath !== null) {
					frontTileX = candidateX;
					frontTileY = candidateY;
					frontFootpath = footpath;
					break;
				}
			}

			// The patrol area must always stay just the exit tile plus the
			// path tile directly in front of it - if no cardinal neighbour has
			// a footpath, there is no valid "front of the ride" tile to patrol,
			// so the area is just the exit tile on its own. A distant fallback
			// tile is only ever used as a teleport destination (below), never
			// added to the patrol area, since that produced patrol areas far
			// away from the ride.
			const member = mechanics[mechanicIndex];
			const patrolTiles: CoordsXY[] = [tileToWorldXY(exitTileX, exitTileY)];
			if (frontTileX !== null && frontTileY !== null) {
				patrolTiles.push(tileToWorldXY(frontTileX, frontTileY));
			}
			member.patrolArea.add(patrolTiles);

			// Only teleport idle mechanics. A busy mechanic (one not standing
			// on a footpath - see canTeleportMechanic, the best available proxy
			// for "currently servicing a ride") keeps its correct new patrol
			// area from above but is not physically dragged off mid-repair; it
			// will walk to its assigned area once it finishes its current job.
			if (canTeleportMechanic(member)) {
				// Prefer standing on the front tile, but only if a peep can
				// actually be placed there (it may carry a bench/lamp/bin);
				// otherwise drop the mechanic on the nearest placeable footpath.
				// The patrol area still stays on the real front tile regardless
				// of where the mechanic is physically placed.
				let teleportTileX: number | null = null;
				let teleportTileY: number | null = null;
				let teleportFootpath: FootpathElement | null = null;
				if (frontTileX !== null && frontTileY !== null && isPeepPlaceableTile(frontTileX, frontTileY)) {
					teleportTileX = frontTileX;
					teleportTileY = frontTileY;
					teleportFootpath = frontFootpath;
				} else {
					const nearestPathTile = findNearestPathTile(exitTileX, exitTileY);
					if (nearestPathTile) {
						teleportTileX = nearestPathTile.x;
						teleportTileY = nearestPathTile.y;
						teleportFootpath = findFootpathElement(map.getTile(nearestPathTile.x, nearestPathTile.y));
					}
				}
				if (teleportTileX !== null && teleportTileY !== null) {
					const z = teleportFootpath ? teleportFootpath.baseZ : exit.z;
					teleportStaffToTile(member, teleportTileX, teleportTileY, z);
				}
			}

			mechanicIndex++;
		}
	}
}

// Builds the ordered tile list entertainers patrol: path tiles, plus queue
// tiles too if the "Queue" toggle is on, preserving the original BFS
// visitation order across both.
function getEntertainerTiles(includeQueue: boolean): PathTileInfo[] {
	if (includeQueue) {
		return lastAllPathTiles;
	}
	return lastAllPathTiles.filter(function (t) { return !t.isQueue; });
}

// Recomputes which currently-hired handymen should be cleanup vs gardening
// handymen and (re-)applies their orders accordingly. A handyman's
// cleanup/gardening purpose is only set once, at hire time (via
// staffOrders), so without this, handymen hired before the needed
// cleanup/gardening tile split changed would keep their original purpose
// forever, and Assign would build patrol areas for the wrong number of
// cleanup/gardening handymen. This reassigns capabilities for every hired
// handyman - not just newly hired ones - every time Assign runs, splitting
// the currently hired handymen (oldest first, for a stable/consistent
// result) between cleanup and gardening in proportion to the needed counts.
function reassignHandymenOrders(): void {
	const handymen = getStaffByType("handyman").slice().sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
	if (handymen.length === 0) {
		return;
	}

	const cleanupNeeded = handymenCleanupNeededStore.get();
	const gardeningNeeded = handymenGardeningNeededStore.get();
	const totalNeeded = cleanupNeeded + gardeningNeeded;

	let cleanupCount: number;
	if (totalNeeded <= 0) {
		cleanupCount = handymen.length;
	} else {
		cleanupCount = Math.round(handymen.length * (cleanupNeeded / totalNeeded));
	}
	cleanupCount = Math.max(0, Math.min(handymen.length, cleanupCount));

	for (let i = 0; i < handymen.length; i++) {
		const member = handymen[i] as Handyman;
		const desiredOrders = i < cleanupCount ? HANDYMAN_ORDERS_CLEANUP : HANDYMAN_ORDERS_GARDENING;
		if (member.orders !== desiredOrders) {
			member.orders = desiredOrders;
		}
	}
}

// Handles the "Assign" button: (re-)builds every staff type's patrol areas
// from the most recently scanned tiles, and teleports one staff member to
// the start of each new area. Only deals with already-hired staff; use
// "Adjust staff count" first to hire/fire staff to match the Needed counts.
function assignStaff(): void {
	if (handymenEnabledStore.get()) {
		reassignHandymenOrders();
		assignConsecutiveAreas(getHandymenByPurpose("cleanup"), lastAllPathTiles);
		assignGardeningAreas(getHandymenByPurpose("gardening"));
	}
	if (guardsEnabledStore.get()) {
		assignConsecutiveAreas(getStaffByType("security"), lastAllPathTiles.filter(function (t) { return !t.isQueue; }));
	}
	if (entertainersEnabledStore.get()) {
		assignEntertainerAreas(getStaffByType("entertainer"), getEntertainerTiles(entertainersIncludeQueueStore.get()), entertainersPerAreaStore.get());
	}
	if (mechanicsEnabledStore.get()) {
		assignMechanics();
	}
}

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

function statRow(name: string, value: Bindable<number>, tooltip: string, disabled: Bindable<boolean>, colorToken?: Bindable<string>): WidgetCreator<FlexiblePosition> {
	const text = isStore(value) ? compute(value, String) : String(value);
	const nameText = colorToken
		? (isStore(colorToken) ? compute(colorToken, function (token: string) { return token + name; }) : colorToken + name)
		: name;
	const valueText = colorToken
		? (isStore(colorToken) && isStore(text)
			? compute(colorToken, text, function (token: string, t: string) { return token + t; })
			: (isStore(text) ? compute(text, function (t: string) { return (colorToken as string) + t; }) : (colorToken as string) + text))
		: text;
	return horizontal({
		spacing: 4,
		height: STAT_ROW_HEIGHT,
		content: [
			label({ text: nameText, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip, disabled: disabled }),
			label({ text: valueText, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip, disabled: disabled })
		]
	});
}

function statTable(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, disabled: Bindable<boolean>): Array<WidgetCreator<FlexiblePosition>> {
	const difference = (isStore(needed) || isStore(hired))
		? compute(
			isStore(needed) ? needed : flexStore(needed),
			isStore(hired) ? hired : flexStore(hired),
			function (n: number, h: number) { return n - h; })
		: (needed as number) - (hired as number);
	// The colour token forces a text colour that would otherwise override the
	// greyed-out appearance a label gets from being disabled, so use no colour
	// override at all (empty prefix) whenever the row is disabled.
	const differenceColorToken: Bindable<string> = (isStore(difference) || isStore(disabled))
		? compute(
			isStore(difference) ? difference : flexStore(difference),
			isStore(disabled) ? disabled : flexStore(disabled),
			function (d: number, isDisabled: boolean) {
				return isDisabled ? "" : (d > 0 ? "{GREEN}" : d < 0 ? "{RED}" : "{BLACK}");
			})
		: (difference > 0 ? "{GREEN}" : difference < 0 ? "{RED}" : "{BLACK}");
	return [
		statRow(t("statRow.hired"), hired, t("statRow.hired.tooltip"), disabled),
		statRow(t("statRow.needed"), needed, t("statRow.needed.tooltip"), disabled),
		statRow(t("statRow.difference"), difference, t("statRow.difference.tooltip"), disabled, differenceColorToken)
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: WritableStore<number> | null, needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, enabled: WritableStore<boolean>, controlsDisabled: Store<boolean>, spinnerLabel?: string, mowerTilesPerStaff?: WritableStore<number>, mowerSpinnerLabel?: string, spinnerTooltip?: string, onSettingsChanged?: () => void): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({ text: t("staffGroup.enabled"), width: "100%", height: 14, isChecked: enabled, disabled: staffControlsDisabledStore, tooltip: t("staffGroup.enabledTooltip"), onChange: function (isChecked) { enabled.set(isChecked); } }),
				...(tilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: spinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, tooltip: spinnerTooltip || t("tooltip.handymenCleanupSpinner"), disabled: controlsDisabled }),
						spinner({
							value: tilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: spinnerTooltip || t("tooltip.handymenCleanupSpinner"),
							disabled: controlsDisabled,
							onChange: function (value) { tilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...(mowerTilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: mowerSpinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.handymenGardeningSpinner"), disabled: controlsDisabled }),
						spinner({
							value: mowerTilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: t("tooltip.handymenGardeningSpinner"),
							disabled: controlsDisabled,
							onChange: function (value) { mowerTilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
						})] : []),
						...statTable(needed, hired, assigned, controlsDisabled)
					]
				})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, enabled: WritableStore<boolean>, controlsDisabled: Store<boolean>): WidgetCreator<FlexiblePosition> {
	return box({
		text: t("staffGroup.entertainers.title"),
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({ text: t("staffGroup.enabled"), width: "100%", height: 14, isChecked: enabled, disabled: staffControlsDisabledStore, tooltip: t("staffGroup.entertainers.enabledTooltip"), onChange: function (isChecked) { enabled.set(isChecked); } }),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: t("spinnerLabel.tilesPerStaff"), width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.entertainersTilesSpinner"), disabled: controlsDisabled }),
							spinner({
								value: entertainersTilesPerStaffStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: t("tooltip.entertainersTilesSpinner"),
								disabled: controlsDisabled,
								onChange: function (value) { entertainersTilesPerStaffStore.set(value); }
							})
						]
					}),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: t("spinnerLabel.staffPerArea"), width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.entertainersPerAreaSpinner"), disabled: controlsDisabled }),
							spinner({
								value: entertainersPerAreaStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: t("tooltip.entertainersPerAreaSpinner"),
								disabled: controlsDisabled,
								onChange: function (value) { entertainersPerAreaStore.set(value); }
							})
						]
					}),
					checkbox({ text: t("checkbox.queue"), width: "100%", height: 14, isChecked: entertainersIncludeQueueStore, disabled: controlsDisabled, tooltip: t("tooltip.entertainersQueueCheckbox"), onChange: function (isChecked) { entertainersIncludeQueueStore.set(isChecked); } }),
						...statTable(needed, hired, assigned, controlsDisabled)
					]
				})
	});
}

// --- Window ------------------------------------------------------------------
// Not cached: the template embeds plain (non-reactive) translated strings
// for titles/labels/tooltips, so it must be rebuilt on every call in order
// to pick up an in-game UI language change the next time the window opens.

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const BOX_TITLE_HEIGHT = 11; // height reserved for the box's own title label
const BOX_PADDING = 12; // 6px top + 6px bottom default box content padding
const GROUP_CONTENT_HEIGHT = 14 + 3 + 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // enabled toggle row + spacing + spinner row + spacing + 3 stat rows + spacing between them
const GROUP_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + GROUP_CONTENT_HEIGHT;
const MECHANICS_CONTENT_HEIGHT = 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // enabled toggle row + spacing + 3 stat rows + spacing between them
const MECHANICS_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + MECHANICS_CONTENT_HEIGHT;
const HANDYMEN_EXTRA_HEIGHT = 14 + 3; // extra "Mower" spinner row + spacing
const HANDYMEN_HEIGHT = GROUP_HEIGHT + HANDYMEN_EXTRA_HEIGHT;
const ENTERTAINERS_EXTRA_HEIGHT = 14 + 3 + 14 + 3; // extra "Entertainers per area" spinner row + "Queue" toggle row + spacing
const ENTERTAINERS_HEIGHT = GROUP_HEIGHT + ENTERTAINERS_EXTRA_HEIGHT;
const STACK_HEIGHT = HANDYMEN_HEIGHT + GROUP_HEIGHT + 4; // Handymen + Guards groups + spacing
const MECHANICS_ENTERTAINERS_STACK_HEIGHT = MECHANICS_HEIGHT + ENTERTAINERS_HEIGHT + 4;
const COLUMN_ROW_HEIGHT = Math.max(STACK_HEIGHT, MECHANICS_ENTERTAINERS_STACK_HEIGHT);

const TOP_ROW_HEIGHT = 14;
const APPLY_MESSAGE_ROW_HEIGHT = 14;
const APPLY_ROW_HEIGHT = 20;
const CONTENT_SPACING = 4; // spacing between the window's top-level content rows
const WINDOW_CHROME_HEIGHT = 29; // title bar + top/bottom window padding
const WINDOW_HEIGHT = TOP_ROW_HEIGHT + CONTENT_SPACING + COLUMN_ROW_HEIGHT + CONTENT_SPACING + APPLY_MESSAGE_ROW_HEIGHT + CONTENT_SPACING + APPLY_ROW_HEIGHT + WINDOW_CHROME_HEIGHT;

function staffManagerWindowTemplate(): WindowTemplate {
	const windowWidth = 400;
	return flexWindow({
			title: t("window.title"),
			width: windowWidth,
			height: WINDOW_HEIGHT,
			position: { x: Math.round((ui.width - windowWidth) / 2), y: Math.round((ui.height - WINDOW_HEIGHT) / 2) },
			spacing: 4,
			content: [
				label({ text: parkEntranceInfoStore, width: "100%", height: 14, tooltip: t("parkEntrance.tooltip") }),
				horizontal({
					spacing: 6,
					height: COLUMN_ROW_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
									staffGroup(t("staffGroup.handymen.title"), handymenTilesPerStaffStore, handymenNeededStore, handymenHiredStore, handymenAssignedStore, "100%", HANDYMEN_HEIGHT, handymenEnabledStore, handymenControlsDisabledStore, t("spinnerLabel.cleanup"), handymenMowerTilesPerStaffStore, t("spinnerLabel.gardening"), t("tooltip.handymenCleanupSpinner")),
											staffGroup(t("staffGroup.guards.title"), guardsTilesPerStaffStore, guardsNeededStore, guardsHiredStore, guardsAssignedStore, "100%", GROUP_HEIGHT, guardsEnabledStore, guardsControlsDisabledStore, t("spinnerLabel.tilesPerStaff"), undefined, undefined, t("tooltip.guardsSpinner"))
										]
									}),
								vertical({
									spacing: 4,
									width: GROUP_WIDTH,
									height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
									content: [
											staffGroup(t("staffGroup.mechanics.title"), null, mechanicsNeededStore, mechanicsHiredStore, mechanicsAssignedStore, "100%", MECHANICS_HEIGHT, mechanicsEnabledStore, mechanicsControlsDisabledStore),
											entertainersGroup(entertainersNeededStore, entertainersHiredStore, entertainersAssignedStore, "100%", ENTERTAINERS_HEIGHT, entertainersEnabledStore, entertainersControlsDisabledStore)
								]
						})
					]
				}),
				label({ text: "", width: "100%", height: APPLY_MESSAGE_ROW_HEIGHT, alignment: "centred", tooltip: t("applyMessage.tooltip") }),
				horizontal({
					spacing: 4,
					width: "100%",
					height: APPLY_ROW_HEIGHT,
					content: [
						button({
							text: t("button.adjustStaffCount"), width: "50%", height: APPLY_ROW_HEIGHT, tooltip: t("button.adjustStaffCount.tooltip"), disabled: adjustButtonDisabledStore, onClick: function () { adjustStaffCounts(); }
						}),
						button({
							text: t("button.assign"), width: "50%", height: APPLY_ROW_HEIGHT, tooltip: t("button.assign.tooltip"), disabled: staffControlsDisabledStore, onClick: function () { assignStaff(); }
						})
					]
				})
			]
	});
}

function openWindow(): void {
	staffManagerWindowTemplate().open();
	refreshHiredAndAssignedStaffCounts();
	findAndReportParkEntrance();
	scanFootpathNetwork();
}

// --- Main --------------------------------------------------------------------
function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Manager", function () { openWindow(); });
	}
}

registerPlugin({
	name: "Staff Manager",
	version: "0.9.2",
	authors: ["Johannes Holzhäuer"],
	type: "local",
	licence: "MIT",
	minApiVersion: 34,
	targetApiVersion: 77,
	main: main
});

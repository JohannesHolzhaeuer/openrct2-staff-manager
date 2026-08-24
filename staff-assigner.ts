/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle,
	store as flexStore, compute, isStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, Bindable,
	Scale
} from "openrct2-flexui";
/*****************************************************************************
 * Staff Assigner
 * ---------------------------------------------------------------------------
 * This is a from-scratch rebuild of the plugin's UI, based on the mockup in
 * ui-mockup.drawio. This version only lays out the window and widgets; it
 * does not implement any staff-management functionality yet.
 *
 * Author: Johannes
 * Licence: MIT
 *****************************************************************************/

// --- Staff calculation stores -------------------------------------------------
// Raw tile/entity counts produced by the scan functions. Needed staff counts
// are derived from these via `compute`, so they automatically recompute
// whenever a scan re-runs or a "tiles per staff"-style spinner changes.
const pathTilesCountStore = flexStore<number>(0);
const queueTilesCountStore = flexStore<number>(0);
const gardenTilesCountStore = flexStore<number>(0);
const rideExitCountStore = flexStore<number>(0);

const handymenTilesPerStaffStore = flexStore<number>(8);
const handymenMowerTilesPerStaffStore = flexStore<number>(256);
const guardsTilesPerStaffStore = flexStore<number>(16);
const entertainersTilesPerStaffStore = flexStore<number>(16);
const entertainersPerAreaStore = flexStore<number>(1);
const entertainersIncludeQueueStore = flexStore<boolean>(true);

// Handymen are needed both to clean up the path/queue network (Cleanup) and
// to mow/water the park's garden tiles (Gardening). These are tracked as
// separate needed counts (used when hiring/firing specialised handymen) and
// summed for the single "Needed" row shown in the UI.
const handymenCleanupNeededStore = compute(pathTilesCountStore, queueTilesCountStore, handymenTilesPerStaffStore,
	function (path: number, queue: number, tilesPerStaff: number) {
		return computeNeeded(path + queue, tilesPerStaff);
	});
const handymenGardeningNeededStore = compute(gardenTilesCountStore, handymenMowerTilesPerStaffStore,
	function (garden: number, mowerTilesPerStaff: number) {
		return computeNeeded(garden, mowerTilesPerStaff);
	});
const handymenNeededStore = compute(handymenCleanupNeededStore, handymenGardeningNeededStore,
	function (cleanup: number, gardening: number) { return cleanup + gardening; });

// Guards only patrol plain pathway tiles, not queue tiles.
const guardsNeededStore = compute(pathTilesCountStore, guardsTilesPerStaffStore,
	function (path: number, tilesPerStaff: number) {
		return computeNeeded(path, tilesPerStaff);
	});

// Entertainers patrol path tiles (and queue tiles, if the "Queue" toggle is
// on), but multiple entertainers can be assigned to each patrol area.
const entertainersNeededStore = compute(
	pathTilesCountStore, queueTilesCountStore, entertainersIncludeQueueStore, entertainersTilesPerStaffStore, entertainersPerAreaStore,
	function (path: number, queue: number, includeQueue: boolean, tilesPerStaff: number, perArea: number) {
		const tiles = path + (includeQueue ? queue : 0);
		return computeNeeded(tiles, tilesPerStaff) * Math.max(perArea, 0);
	});

// One mechanic is needed per ride exit in the park.
const mechanicsNeededStore = compute(rideExitCountStore, function (rideExits: number) { return rideExits; });

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
			if (station.entrance) {
				tileKeys.add((station.entrance.x / 32) + "," + (station.entrance.y / 32));
			}
			if (station.exit) {
				tileKeys.add((station.exit.x / 32) + "," + (station.exit.y / 32));
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
		console.log("Staff Assigner: no park entrance found.");
		parkEntranceInfoStore.set("Park entrance: not found.");
		return parkEntranceTiles;
	}
	const coordsText = parkEntranceTiles.map(function (tile) { return "(" + tile.x + ", " + tile.y + ")"; }).join(", ");
	console.log("Staff Assigner: park entrance tile(s) found at " + coordsText);
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
}

// Cardinal neighbour offsets used to walk the footpath network tile by tile.
const CARDINAL_NEIGHBOUR_OFFSETS: CoordsXY[] = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 }
];

function tileKey(x: number, y: number): string {
	return x + "," + y;
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
function scanFootpathNetworkFromEntrance(entranceTile: CoordsXY): { pathTiles: PathTileInfo[]; queueTiles: PathTileInfo[]; allTiles: PathTileInfo[] } {
	const pathTiles: PathTileInfo[] = [];
	const queueTiles: PathTileInfo[] = [];
	const allTiles: PathTileInfo[] = [];
	const visited = new Set<string>();
	const stack: CoordsXY[] = [];

	// Seed the search with the tiles directly next to the entrance.
	for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
		const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
		stack.push({ x: entranceTile.x + offset.x, y: entranceTile.y + offset.y });
	}

	while (stack.length > 0) {
		const current = stack.pop() as CoordsXY;
		const key = tileKey(current.x, current.y);
		if (visited.has(key)) {
			continue;
		}
		visited.add(key);

		if (current.x < 0 || current.y < 0 || current.x >= map.size.x || current.y >= map.size.y) {
			continue;
		}

		// Skip tiles that are not owned by the park (or under construction
		// rights), e.g. the public road/path leading up to the entrance from
		// outside the park, so the scan only covers the park's own network.
		if (!isParkOwnedTile(current.x, current.y)) {
			continue;
		}

		const tile = map.getTile(current.x, current.y);
		let isPath = false;
		let isQueue = false;
		let baseHeight = 0;
		let baseZ = 0;
		for (let e = 0; e < tile.numElements; e++) {
			const element = tile.getElement(e);
			if (element.type === "footpath") {
				const footpathElement = element as FootpathElement;
				isPath = true;
				isQueue = footpathElement.isQueue;
				baseHeight = footpathElement.baseHeight;
				baseZ = footpathElement.baseZ;
				break;
			}
		}

		if (!isPath) {
			continue;
		}

		if (isQueue) {
			queueTiles.push({ x: current.x, y: current.y, baseHeight: baseHeight, baseZ: baseZ, isQueue: true });
		} else {
			pathTiles.push({ x: current.x, y: current.y, baseHeight: baseHeight, baseZ: baseZ, isQueue: false });
		}
		allTiles.push({ x: current.x, y: current.y, baseHeight: baseHeight, baseZ: baseZ, isQueue: isQueue });

		for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
			const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
			const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
			if (!visited.has(tileKey(neighbour.x, neighbour.y))) {
				stack.push(neighbour);
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
		console.log("Staff Assigner: cannot scan footpath network, no park entrance found.");
		return;
	}

	const result = scanFootpathNetworkFromEntrance(parkEntranceTiles[0]);
	console.log(
		"Staff Assigner: footpath scan found " + result.pathTiles.length + " path tile(s) and "
		+ result.queueTiles.length + " queue tile(s)."
	);

	const gardeningResult = scanGardeningTiles();
	console.log("Staff Assigner: gardening scan found " + gardeningResult.gardenTiles + " garden tile(s).");

	const rideExitCount = countRideExits();
	console.log("Staff Assigner: found " + rideExitCount + " ride exit(s).");

	pathTilesCountStore.set(result.pathTiles.length);
	queueTilesCountStore.set(result.queueTiles.length);
	gardenTilesCountStore.set(gardeningResult.gardenTiles);
	rideExitCountStore.set(rideExitCount);

	lastAllPathTiles = result.allTiles;
	lastGardenAreas = gardeningResult.areas;

	tilesCalculatedStore.set(true);

	parkEntranceInfoStore.set(
		"Path tiles: " + result.pathTiles.length + ", Queue tiles: " + result.queueTiles.length
		+ ", Garden tiles: " + gardeningResult.gardenTiles
	);
}

// Counts the number of ride exits in the park; one mechanic is needed per
// ride exit.
function countRideExits(): number {
	const rides = map.rides;
	let count = 0;
	for (let i = 0; i < rides.length; i++) {
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length; s++) {
			if (stations[s].exit) {
				count++;
			}
		}
	}
	return count;
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
			const isMowable = !!surface && surface.grassLength >= 0 && grassSurfaceStyleIndices.has(surface.surfaceStyle);
			const isWaterable = hasWaterableSceneryElement(tile);
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
		const stack: CoordsXY[] = [{ x: startX, y: startY }];
		visited.add(key);
		while (stack.length > 0) {
			const current = stack.pop() as CoordsXY;
			const currentKey = tileKey(current.x, current.y);
			const surface = findSurfaceElement(map.getTile(current.x, current.y));
			component.push({ x: current.x, y: current.y, baseHeight: surface ? surface.baseHeight : 0, baseZ: surface ? surface.baseZ : 0, isQueue: false });
			for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
				const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
				const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
				const neighbourKey = tileKey(neighbour.x, neighbour.y);
				if (!visited.has(neighbourKey) && isGardenTile.has(neighbourKey)) {
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
// costume and is rejected by the game for entertainers.
function findCostumeIndexForStaffType(staffTypeId: number): number {
	if (staffTypeId !== STAFF_TYPE_ID_ENTERTAINER) {
		return 0;
	}

	const entertainerCostumeIndices = findEntertainerCostumeIndices();
	if (entertainerCostumeIndices.length === 0) {
		return 0;
	}

	return entertainerCostumeIndices[Math.floor(Math.random() * entertainerCostumeIndices.length)];
}

// Hires the given number of new staff of the given type, applying the given
// orders bitmask (only relevant for handymen/mechanics). Each hired staff
// member gets its own randomly picked costume (relevant for entertainers).
// Invokes onActionComplete once per action after its callback has fired.
function hireStaff(staffTypeId: number, orders: number, countToHire: number, onActionComplete: () => void): void {
	for (let i = 0; i < countToHire; i++) {
		context.executeAction("staffhire", {
			autoPosition: true,
			staffType: staffTypeId,
			costumeIndex: findCostumeIndexForStaffType(staffTypeId),
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
	context.executeAction("peeppickup", { type: 0, id: next.id, x: 0, y: 0, z: 0, playerId: 0 }, function () {
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

// Splits the given ordered tile list into as many consecutive (contiguous)
// chunks as there are staff members, each chunk roughly totalTiles/staffCount
// tiles large. If there are fewer staff hired than the "needed" count would
// require, each chunk simply comes out larger, covering more tiles per staff
// member; if there are more staff than tiles, the extra staff are left with
// an empty patrol area (nothing to assign them to).
function chunkTilesForStaffCount(tiles: PathTileInfo[], staffCount: number): PathTileInfo[][] {
	if (staffCount <= 0 || tiles.length === 0) {
		return [];
	}
	const chunkSize = Math.ceil(tiles.length / staffCount);
	const chunks: PathTileInfo[][] = [];
	for (let i = 0; i < tiles.length; i += chunkSize) {
		chunks.push(tiles.slice(i, i + chunkSize));
	}
	return chunks;
}

// Clears every given staff member's patrol area. Used at the start of each
// staff type's (re-)assignment so stale patrol areas don't linger.
function clearPatrolAreas(members: Staff[]): void {
	for (let i = 0; i < members.length; i++) {
		members[i].patrolArea.clear();
	}
}

// Assigns one consecutive chunk of the given ordered tile list to each hired
// staff member (only dealing with already-hired staff, per Assign's remit),
// and teleports each staff member to the first tile of their new area.
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
		teleportStaffToTile(member, chunk[0].x, chunk[0].y, chunk[0].baseZ);
	}
}

// Assigns consecutive gardening areas built from the garden tiles' connected
// components (in BFS order), flattened into one list so that when a
// component runs out of tiles before a chunk is filled, the chunk continues
// into the next component - effectively "connecting" the two areas.
function assignGardeningAreas(members: Staff[]): void {
	const flattened: PathTileInfo[] = [];
	for (let i = 0; i < lastGardenAreas.length; i++) {
		const area = lastGardenAreas[i];
		for (let t = 0; t < area.length; t++) {
			flattened.push(area[t]);
		}
	}
	assignConsecutiveAreas(members, flattened);
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
		for (let p = 0; p < perArea && memberIndex < members.length; p++) {
			const member = members[memberIndex];
			member.patrolArea.add(coords);
			teleportStaffToTile(member, chunk[0].x, chunk[0].y, chunk[0].baseZ);
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
// ride exit tile and the path tile directly in front of it (in the exit's
// facing direction). Only runs when exactly enough mechanics are hired to
// cover every ride exit (difference === 0); otherwise does nothing, since
// there's no sensible way to split a single-tile-pair area further.
function assignMechanics(): void {
	const mechanics = getStaffByType("mechanic");
	const mechanicsNeeded = mechanicsNeededStore.get();
	if (mechanics.length !== mechanicsNeeded) {
		return;
	}

	clearPatrolAreas(mechanics);

	const rides = map.rides;
	let mechanicIndex = 0;
	for (let i = 0; i < rides.length && mechanicIndex < mechanics.length; i++) {
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length && mechanicIndex < mechanics.length; s++) {
			const exit = stations[s].exit;
			if (!exit) {
				continue;
			}

			const exitTileX = Math.floor(exit.x / 32);
			const exitTileY = Math.floor(exit.y / 32);
			const offset = CARDINAL_NEIGHBOUR_OFFSETS[exit.direction];
			const frontTileX = exitTileX + offset.x;
			const frontTileY = exitTileY + offset.y;

			const member = mechanics[mechanicIndex];
			member.patrolArea.add([tileToWorldXY(exitTileX, exitTileY), tileToWorldXY(frontTileX, frontTileY)]);

			if (canTeleportMechanic(member)) {
				const frontFootpath = findFootpathElement(map.getTile(frontTileX, frontTileY));
				const z = frontFootpath ? frontFootpath.baseZ : exit.z;
				teleportStaffToTile(member, frontTileX, frontTileY, z);
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
	reassignHandymenOrders();
	assignConsecutiveAreas(getHandymenByPurpose("cleanup"), lastAllPathTiles);
	assignGardeningAreas(getHandymenByPurpose("gardening"));
	assignConsecutiveAreas(getStaffByType("security"), lastAllPathTiles.filter(function (t) { return !t.isQueue; }));
	assignEntertainerAreas(getStaffByType("entertainer"), getEntertainerTiles(entertainersIncludeQueueStore.get()), entertainersPerAreaStore.get());
	assignMechanics();
}

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

function statRow(name: string, value: Bindable<number>, tooltip: string, colorToken?: Bindable<string>): WidgetCreator<FlexiblePosition> {
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
			label({ text: nameText, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip, disabled: staffControlsDisabledStore }),
			label({ text: valueText, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip, disabled: staffControlsDisabledStore })
		]
	});
}

function statTable(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>): Array<WidgetCreator<FlexiblePosition>> {
	const difference = (isStore(needed) || isStore(hired))
		? compute(
			isStore(needed) ? needed : flexStore(needed),
			isStore(hired) ? hired : flexStore(hired),
			function (n: number, h: number) { return n - h; })
		: (needed as number) - (hired as number);
	const differenceColorToken: Bindable<string> = isStore(difference)
		? compute(difference, function (d: number) { return d > 0 ? "{GREEN}" : d < 0 ? "{RED}" : "{BLACK}"; })
		: (difference > 0 ? "{GREEN}" : difference < 0 ? "{RED}" : "{BLACK}");
	return [
		statRow("Hired", hired, "The number of staff of this type currently hired in the park."),
		statRow("Needed", needed, "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each."),
		statRow("Difference", difference, "Needed minus Hired: a positive number means staff of this type need to be hired, a negative number means staff can be fired.", differenceColorToken)
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: Store<number> | null, needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, spinnerLabel?: string, mowerTilesPerStaff?: Store<number>, mowerSpinnerLabel?: string, spinnerTooltip?: string, onSettingsChanged?: () => void): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				...(tilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: spinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
						spinner({
							value: tilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: spinnerTooltip || "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed.",
							disabled: staffControlsDisabledStore,
							onChange: function (value) { tilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...(mowerTilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: mowerSpinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
						spinner({
							value: mowerTilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: "The number of gardening tiles (tiles that need mowing or watering) a single gardening-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many gardening handymen are Needed.",
							disabled: staffControlsDisabledStore,
							onChange: function (value) { mowerTilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...statTable(needed, hired, assigned)
			]
		})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: "Entertainers",
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: "Tiles / Staff", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
							spinner({
								value: entertainersTilesPerStaffStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								disabled: staffControlsDisabledStore,
								onChange: function (value) { entertainersTilesPerStaffStore.set(value); }
							})
						]
					}),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: "Staff / Area", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
							spinner({
								value: entertainersPerAreaStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: "The number of entertainers to assign per patrol area.",
								disabled: staffControlsDisabledStore,
								onChange: function (value) { entertainersPerAreaStore.set(value); }
							})
						]
					}),
				toggle({ text: "Queue", width: "100%", height: 14, isPressed: entertainersIncludeQueueStore, disabled: staffControlsDisabledStore, onChange: function (isPressed) { entertainersIncludeQueueStore.set(isPressed); } }),
				...statTable(needed, hired, assigned)
			]
		})
	});
}

// --- Window ------------------------------------------------------------------
let windowTemplate: WindowTemplate | null = null;

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const BOX_TITLE_HEIGHT = 11; // height reserved for the box's own title label
const BOX_PADDING = 12; // 6px top + 6px bottom default box content padding
const GROUP_CONTENT_HEIGHT = 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // spinner row + spacing + 3 stat rows + spacing between them
const GROUP_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + GROUP_CONTENT_HEIGHT;
const MECHANICS_CONTENT_HEIGHT = (STAT_ROW_HEIGHT * 3) + (3 * 2); // no spinner row: just 3 stat rows + spacing between them
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

function staffAssignerWindowTemplate(): WindowTemplate {
	if (!windowTemplate) {
		const windowWidth = 400;
		windowTemplate = flexWindow({
			title: "Staff Assigner",
			width: windowWidth,
			height: WINDOW_HEIGHT,
			x: Math.round((ui.width - windowWidth) / 2),
			y: Math.round((ui.height - WINDOW_HEIGHT) / 2),
			spacing: 4,
			content: [
				label({ text: parkEntranceInfoStore, width: "100%", height: 14 }),
				horizontal({
					spacing: 6,
					height: COLUMN_ROW_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
									staffGroup("Handymen", handymenTilesPerStaffStore, handymenNeededStore, handymenHiredStore, handymenAssignedStore, "100%", HANDYMEN_HEIGHT, "Cleanup", handymenMowerTilesPerStaffStore, "Gardening", "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed."),
											staffGroup("Guards", guardsTilesPerStaffStore, guardsNeededStore, guardsHiredStore, guardsAssignedStore, "100%", GROUP_HEIGHT, "Tiles / Staff", undefined, undefined, "The number of plain pathway tiles (excluding queue tiles) a single guard is expected to patrol (tiles per staff). Used to calculate how many guards are Needed.")
										]
									}),
								vertical({
									spacing: 4,
									width: GROUP_WIDTH,
									height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
									content: [
											staffGroup("Mechanics", null, mechanicsNeededStore, mechanicsHiredStore, mechanicsAssignedStore, "100%", MECHANICS_HEIGHT),
											entertainersGroup(entertainersNeededStore, entertainersHiredStore, entertainersAssignedStore, "100%", ENTERTAINERS_HEIGHT)
								]
						})
					]
				}),
				label({ text: "", width: "100%", height: APPLY_MESSAGE_ROW_HEIGHT, alignment: "centred" }),
				horizontal({
					spacing: 4,
					width: "100%",
					height: APPLY_ROW_HEIGHT,
					content: [
						button({
							text: "Adjust staff count", width: "50%", height: APPLY_ROW_HEIGHT, disabled: adjustButtonDisabledStore, onClick: function () { adjustStaffCounts(); }
						}),
						button({
							text: "Assign", width: "50%", height: APPLY_ROW_HEIGHT, disabled: staffControlsDisabledStore, onClick: function () { assignStaff(); }
						})
					]
				})
			]
		});
	}
	return windowTemplate;
}

function openWindow(): void {
	staffAssignerWindowTemplate().open();
	refreshHiredAndAssignedStaffCounts();
	findAndReportParkEntrance();
	scanFootpathNetwork();
}

// --- Main --------------------------------------------------------------------
function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Assigner", function () { openWindow(); });
	}
}

registerPlugin({
	name: "Staff Assigner",
	version: "1.0.0",
	authors: ["Johannes"],
	type: "local",
	licence: "MIT",
	minApiVersion: 34,
	targetApiVersion: 77,
	main: main
});

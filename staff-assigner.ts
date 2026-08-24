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
// to mow/water the park's garden tiles (Gardening); both needs are summed.
const handymenNeededStore = compute(
	pathTilesCountStore, queueTilesCountStore, gardenTilesCountStore, handymenTilesPerStaffStore, handymenMowerTilesPerStaffStore,
	function (path: number, queue: number, garden: number, tilesPerStaff: number, mowerTilesPerStaff: number) {
		return computeNeeded(path + queue, tilesPerStaff) + computeNeeded(garden, mowerTilesPerStaff);
	});

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

// Whether a tile is owned by the park (or has construction rights). Tiles
// outside the park (e.g. the public road leading up to the entrance) do not
// have ownership, so this is used to stop the footpath walk from wandering
// off the park's own path network.
function isParkOwnedTile(x: number, y: number): boolean {
	const surface = findSurfaceElement(map.getTile(x, y));
	if (!surface) {
		return false;
	}
	return surface.hasOwnership || surface.hasConstructionRights;
}

// Starting from the park entrance, walks the connected footpath network in all
// directions (breadth-first) and separately collects plain path tiles and queue
// tiles, together with their coordinates and base height.
function scanFootpathNetworkFromEntrance(entranceTile: CoordsXY): { pathTiles: PathTileInfo[]; queueTiles: PathTileInfo[] } {
	const pathTiles: PathTileInfo[] = [];
	const queueTiles: PathTileInfo[] = [];
	const visited = new Set<string>();
	const queue: CoordsXY[] = [];

	// Seed the search with the tiles directly next to the entrance.
	for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
		const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
		queue.push({ x: entranceTile.x + offset.x, y: entranceTile.y + offset.y });
	}

	while (queue.length > 0) {
		const current = queue.shift() as CoordsXY;
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
		for (let e = 0; e < tile.numElements; e++) {
			const element = tile.getElement(e);
			if (element.type === "footpath") {
				const footpathElement = element as FootpathElement;
				isPath = true;
				isQueue = footpathElement.isQueue;
				baseHeight = footpathElement.baseHeight;
				break;
			}
		}

		if (!isPath) {
			continue;
		}

		if (isQueue) {
			queueTiles.push({ x: current.x, y: current.y, baseHeight: baseHeight });
		} else {
			pathTiles.push({ x: current.x, y: current.y, baseHeight: baseHeight });
		}

		for (let i = 0; i < CARDINAL_NEIGHBOUR_OFFSETS.length; i++) {
			const offset = CARDINAL_NEIGHBOUR_OFFSETS[i];
			const neighbour = { x: current.x + offset.x, y: current.y + offset.y };
			if (!visited.has(tileKey(neighbour.x, neighbour.y))) {
				queue.push(neighbour);
			}
		}
	}

	return { pathTiles: pathTiles, queueTiles: queueTiles };
}

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

// Scans every tile owned by the park (or under construction rights) and counts
// how many are "garden tiles": tiles that either have mowable grass or
// waterable scenery on them (a tile with both still only counts once). Tiles
// under a footpath are skipped entirely, since staff can't mow/water grass or
// scenery hidden under a path.
function scanGardeningTiles(): { gardenTiles: number } {
	const mapSize = map.size;
	let gardenTiles = 0;

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
			const isMowable = !!surface && surface.grassLength >= 0;
			const isWaterable = hasWaterableSceneryElement(tile);
			if (isMowable || isWaterable) {
				gardenTiles++;
			}
		}
	}

	return { gardenTiles: gardenTiles };
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

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

function statRow(name: string, value: Bindable<number>, tooltip: string): WidgetCreator<FlexiblePosition> {
	const text = isStore(value) ? compute(value, String) : String(value);
	return horizontal({
		spacing: 4,
		height: STAT_ROW_HEIGHT,
		content: [
			label({ text: name, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip, disabled: staffControlsDisabledStore }),
			label({ text: text, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip, disabled: staffControlsDisabledStore })
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
	return [
		statRow("Hired", hired, "The number of staff of this type currently hired in the park."),
		statRow("Needed", needed, "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each."),
		statRow("Difference", difference, "Needed minus Hired: a positive number means staff of this type need to be hired, a negative number means staff can be fired.")
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
							text: "Adjust staff count", width: "50%", height: APPLY_ROW_HEIGHT, disabled: staffControlsDisabledStore, onClick: function () { }
						}),
						button({
							text: "Assign", width: "50%", height: APPLY_ROW_HEIGHT, disabled: staffControlsDisabledStore, onClick: function () { }
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

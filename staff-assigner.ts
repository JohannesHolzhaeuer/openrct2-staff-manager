/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle,
	store as flexStore, compute, isStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, Bindable, ElementVisibility,
	BuildOutput, Layoutable, WidgetMap, Rectangle, ElementParams, Scale
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

// --- Custom progress bar widget ---------------------------------------------
// A filled-rectangle progress bar drawn with a "custom" widget's onDraw
// callback (see GraphicsContext in @openrct2/types). This renders an actual
// bar instead of simulating one with text characters.
const PROGRESS_BAR_BORDER_COLOUR = 12; // dark grey well border
const PROGRESS_BAR_FILL_COLOUR = 30;   // bright blue fill
let progressBarNameCounter = 0;

function progressBar(percentStore: Store<number>, width: Scale, height: Scale, visibility?: Store<ElementVisibility>): WidgetCreator<FlexiblePosition> {
	let pct = Math.max(0, Math.min(100, percentStore.get()));
	const name = "progressbar" + (progressBarNameCounter++);
	const params: ElementParams & FlexiblePosition = { visibility: visibility, width: width, height: height };
	return {
		params: params,
		create: function (output: BuildOutput): Layoutable {
			const widget = {
				type: "custom",
				name: name,
				x: 0, y: 0, width: 0, height: 0,
				onDraw: function (g: GraphicsContext): void {
					const w = g.width, h = g.height;
					g.colour = PROGRESS_BAR_BORDER_COLOUR;
					g.well(0, 0, w, h);
					const inset = 1;
					const innerW = Math.max(0, w - inset * 2);
					const innerH = Math.max(0, h - inset * 2);
					const filledW = Math.round((innerW * pct) / 100);
					if (filledW > 0) {
						g.colour = PROGRESS_BAR_FILL_COLOUR;
						g.rect(inset, inset, filledW, innerH);
					}
				}
			} as unknown as Widget;
			output.add(widget);
			output.binder.add(widget, "isVisible", visibility, function (v) { return v === "visible"; });
			// The custom widget only redraws when the window is invalidated, so
			// grab the window context (available once the window is open) and
			// force a redraw whenever the bound percentage actually changes.
			// (RedrawContext is derived from BuildOutput.on's callback parameter,
			// since flexui's WindowContext type itself isn't exported.)
			type RedrawContext = Parameters<BuildOutput["on"]>[1] extends (context: infer C) => void ? C : never;
			let windowContext: RedrawContext | null = null;
			output.on("open", function (context) {
				windowContext = context;
			});
			output.binder.on(percentStore, function (value: number) {
				pct = Math.max(0, Math.min(100, value));
				if (windowContext) {
					windowContext.redraw();
				}
			});
			return {
				layout: function (widgets: WidgetMap, area: Rectangle): void {
					const w = widgets[name];
					w.x = Math.round(area.x);
					w.y = Math.round(area.y);
					w.width = Math.round(area.width);
					w.height = Math.round(area.height);
				}
			};
		}
	};
}

// --- Park capacity calculation -----------------------------------------------
// Counts every footpath tile reachable from the park entrance (flood fill),
// every reachable queue tile, and every ride exit in the park. The scan is
// spread out over many game ticks (a limited amount of tile work per tick)
// so large parks never cause the game to freeze while calculating.
const RIDE_ID_NULL = 0xFFFF;
const LOCATION_NULL = 0xFFFF;
const TILES_PER_TICK = 500; // amount of tile work performed per game tick

const capacityProgressStore = flexStore<number>(0);
const capacityResultStore = flexStore<string>("Press Calculate to scan the park.");

// --- Staff calculation stores -------------------------------------------------
// The number of reachable path/queue tiles is only known after a capacity
// scan has completed; it is shared between Handymen and Guards, since both
// patrol the same footpath/queue network. Needed is derived from this tile
// count and each staff type's "tiles per staff" spinner value, assuming the
// tiles will be split into that many contiguous (consecutive) tiles per
// staff member once assigned, so Needed = ceil(tiles / tilesPerStaff).
const totalPatrolTilesStore = flexStore<number>(0);
const totalPathOnlyTilesStore = flexStore<number>(0); // path tiles only, excluding queue tiles (used by Guards)
const totalGardeningTilesStore = flexStore<number>(0);
const totalRideExitsStore = flexStore<number>(0); // used by Mechanics: one mechanic needed per ride exit

// Ordered tile lists retained from the last completed scan, used to split
// the park into consecutive patrol areas when Apply is pressed.
let lastPatrolTileList: CoordsXY[] = [];   // path + queue tiles
let lastGardeningTileList: CoordsXY[] = []; // gardening tiles

const handymenTilesPerStaffStore = flexStore<number>(8);
const handymenMowerTilesPerStaffStore = flexStore<number>(256);
const guardsTilesPerStaffStore = flexStore<number>(16);
const entertainersTilesPerStaffStore = flexStore<number>(16);
const entertainersPerAreaStore = flexStore<number>(1);
const entertainersIncludeQueueStore = flexStore<boolean>(true);

const handymenHiredStore = flexStore<number>(0);
const handymenAssignedStore = flexStore<number>(0);
const guardsHiredStore = flexStore<number>(0);
const guardsAssignedStore = flexStore<number>(0);
const entertainersHiredStore = flexStore<number>(0);
const entertainersAssignedStore = flexStore<number>(0);
const mechanicsHiredStore = flexStore<number>(0);
const mechanicsAssignedStore = flexStore<number>(0);

function computeNeeded(totalTiles: number, tilesPerStaff: number): number {
	if (tilesPerStaff <= 0 || totalTiles <= 0) {
		return 0;
	}
	return Math.ceil(totalTiles / tilesPerStaff);
}

// Handymen are split into two separate jobs: general cleanup (litter, empty
// bins, etc., patrolling the whole footpath/queue network) and gardening
// (patrolling only the tiles that need mowing or watering). Each has its own
// "tiles per staff" spinner, so the total number of handymen needed is the
// sum of both requirements, each rounded up independently.
function computeHandymenNeeded(patrolTiles: number, cleanupTilesPerStaff: number, gardeningTiles: number, mowerTilesPerStaff: number): number {
	return computeNeeded(patrolTiles, cleanupTilesPerStaff) + computeNeeded(gardeningTiles, mowerTilesPerStaff);
}

const handymenNeededStore = compute(totalPatrolTilesStore, handymenTilesPerStaffStore, totalGardeningTilesStore, handymenMowerTilesPerStaffStore, computeHandymenNeeded);
const guardsNeededStore = compute(totalPathOnlyTilesStore, guardsTilesPerStaffStore, computeNeeded);
// Entertainers patrol areas like Guards (plain path tiles by default), but
// optionally also cover queue tiles if the "Queue" toggle is checked, and
// each patrol area is staffed with a configurable number of entertainers.
function computeEntertainersNeeded(pathTiles: number, patrolTiles: number, tilesPerStaff: number, entertainersPerArea: number, includeQueue: boolean): number {
	const tiles = includeQueue ? patrolTiles : pathTiles;
	const areas = computeNeeded(tiles, tilesPerStaff);
	return areas * Math.max(0, entertainersPerArea);
}
const entertainersNeededStore = compute(totalPathOnlyTilesStore, totalPatrolTilesStore, entertainersTilesPerStaffStore, entertainersPerAreaStore, entertainersIncludeQueueStore, computeEntertainersNeeded);
// One mechanic is needed per ride exit in the park.
const mechanicsNeededStore = compute(totalRideExitsStore, function (exits: number) { return exits; });

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

type CalculationPhase = "scanning-entrances" | "flood-fill" | "done";

interface PathTileInfo {
	isQueue: boolean;
	isConnectorOnly: boolean; // ride entrance/exit tile: walkable for reachability, but not a patrol tile
}

interface CalculationState {
	phase: CalculationPhase;
	mapWidth: number;
	mapHeight: number;
	totalTiles: number;
	scanIndex: number;    // linear tile index used while scanning the whole map
	pathInfo: Map<number, PathTileInfo>; // every footpath tile found during the scan, keyed by tileKey
	seeds: CoordsXY[];    // footpath tiles adjacent to a park entrance
	frontier: CoordsXY[]; // tiles still to be visited during the flood fill
	visited: Set<number>; // visited tile keys (y * mapWidth + x)
	pathTiles: number;
	queueTiles: number;
	gardeningTiles: number;
	patrolTileList: CoordsXY[];   // path + queue tiles, in flood-fill visiting order
	gardeningTileList: CoordsXY[]; // gardening tiles, in scan order
}

let calculation: CalculationState | null = null;
let tickIntervalHandle: number | null = null;

const NEIGHBOUR_OFFSETS: CoordsXY[] = [
	{ x: 0, y: -1 },
	{ x: 1, y: 0 },
	{ x: 0, y: 1 },
	{ x: -1, y: 0 }
];

function tileKey(x: number, y: number, mapWidth: number): number {
	return y * mapWidth + x;
}

function findFootpathElement(x: number, y: number): FootpathElement | null {
	const tile = map.getTile(x, y);
	for (let i = 0; i < tile.numElements; i++) {
		const element = tile.getElement(i);
		if (element.type === "footpath") {
			return element as FootpathElement;
		}
	}
	return null;
}

function findSurfaceElement(x: number, y: number): SurfaceElement | null {
	const tile = map.getTile(x, y);
	for (let i = 0; i < tile.numElements; i++) {
		const element = tile.getElement(i);
		if (element.type === "surface") {
			return element as SurfaceElement;
		}
	}
	return null;
}

// A surface tile is water (has a water level above its own height) or sand
// (a "beach" terrain_surface object) if either of these apply; handymen
// can't mow or water either of these, so such tiles must never be treated
// as gardening tiles even if they happen to carry decorative scenery.
function isWaterOrSandSurface(surface: SurfaceElement): boolean {
	if (surface.waterHeight > 0) {
		return true;
	}
	try {
		const surfaceObject = objectManager.getObject("terrain_surface", surface.surfaceStyle);
		if (surfaceObject && surfaceObject.identifier && surfaceObject.identifier.toLowerCase().indexOf("sand") !== -1) {
			return true;
		}
	}
	catch (error) {
		// If the surface object can't be resolved for any reason, fall back to
		// treating the tile as regular ground rather than failing the scan.
	}
	return false;
}

// A tile needs gardening if it is owned by the park, isn't covered by a
// footpath (since guests/staff can't walk on grass/scenery hidden underneath
// a path), isn't water or sand (which can't be mowed or watered), and either
// has a grass surface that can grow (mowing) or has a small scenery element
// on it that can need watering (e.g. flowers/gardens).
function isGardeningTile(x: number, y: number, footpath: FootpathElement | null): boolean {
	if (footpath) {
		return false;
	}
	const surface = findSurfaceElement(x, y);
	if (!surface || !surface.hasOwnership) {
		return false;
	}
	if (isWaterOrSandSurface(surface)) {
		return false;
	}
	if (surface.grassLength >= 0) {
		return true;
	}
	return hasWaterableSceneryElement(x, y);
}

// Small scenery placed directly on the ground (e.g. flowers, gardens) is what
// handymen water; there's no direct "needs watering" flag exposed by the
// scripting API, so the presence of small scenery on the tile is used as an
// approximation of a tile that requires watering.
function hasWaterableSceneryElement(x: number, y: number): boolean {
	const tile = map.getTile(x, y);
	for (let i = 0; i < tile.numElements; i++) {
		const element = tile.getElement(i);
		if (element.type === "small_scenery") {
			return true;
		}
	}
	return false;
}

// A footpath tile is a queue tile if the game marked it as such. (Reading
// .ride/.station on a non-queue footpath element throws in this API version,
// so those fields can't be used as a secondary signal.)
function isQueueFootpath(footpath: FootpathElement): boolean {
	return !!footpath.isQueue;
}

// Entrance elements are used for both ride entrances/exits (which belong to a
// ride) and the park entrance itself. The "ride" field on an EntranceElement
// is NOT a reliable sentinel for telling these apart: a park entrance can
// report the same ride id as an unrelated ride happening to have that same
// index (e.g. ride 0), rather than a dedicated "no ride" value. Instead, the
// set of genuine ride entrance/exit tiles is built directly from
// map.rides[*].stations[*].entrance/exit (authoritative tile coordinates),
// and any other "entrance" tile element is treated as the park entrance.
let rideEntranceExitTileKeys: Set<number> | null = null;

function getRideEntranceExitTileKeys(mapWidth: number): Set<number> {
	if (rideEntranceExitTileKeys !== null) {
		return rideEntranceExitTileKeys;
	}
	const keys = new Set<number>();
	const rides = map.rides;
	for (let r = 0; r < rides.length; r++) {
		const stations = rides[r].stations;
		for (let s = 0; s < stations.length; s++) {
			const entrance = stations[s].entrance;
			const exit = stations[s].exit;
			if (entrance && entrance.x !== LOCATION_NULL) {
				keys.add(tileKey(entrance.x / 32, entrance.y / 32, mapWidth));
			}
			if (exit && exit.x !== LOCATION_NULL) {
				keys.add(tileKey(exit.x / 32, exit.y / 32, mapWidth));
			}
		}
	}
	rideEntranceExitTileKeys = keys;
	return keys;
}

function hasParkEntranceElement(x: number, y: number, mapWidth: number): boolean {
	const tile = map.getTile(x, y);
	let hasEntranceElement = false;
	for (let i = 0; i < tile.numElements; i++) {
		if (tile.getElement(i).type === "entrance") {
			hasEntranceElement = true;
			break;
		}
	}
	if (!hasEntranceElement) {
		return false;
	}
	return !getRideEntranceExitTileKeys(mapWidth).has(tileKey(x, y, mapWidth));
}

// A ride entrance/exit tile connects the main footpath network to a ride's
// queue line; it is not itself a path or queue tile that staff patrol, but
// it must be treated as a walkable connector node during the flood fill,
// otherwise the queue network (which only attaches to the main path network
// through this entrance/exit element) would never be reachable.
function hasRideEntranceOrExitElement(x: number, y: number, mapWidth: number): boolean {
	const tile = map.getTile(x, y);
	let hasEntranceElement = false;
	for (let i = 0; i < tile.numElements; i++) {
		if (tile.getElement(i).type === "entrance") {
			hasEntranceElement = true;
			break;
		}
	}
	if (!hasEntranceElement) {
		return false;
	}
	return getRideEntranceExitTileKeys(mapWidth).has(tileKey(x, y, mapWidth));
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

function countRideExits(): number {
	let exits = 0;
	const rides = map.rides;
	for (let r = 0; r < rides.length; r++) {
		const stations = rides[r].stations;
		for (let s = 0; s < stations.length; s++) {
			const exit = stations[s].exit;
			if (exit && exit.x !== LOCATION_NULL) {
				exits++;
			}
		}
	}
	return exits;
}

// Kicks off (or restarts) the incremental park scan. Only a limited amount of
// tile work is processed per interval callback so the game keeps running
// smoothly while the calculation is in progress. A real-time interval (not
// the simulation "interval.tick" hook) is used so the scan still progresses
// even while the game is paused.
const CALCULATION_INTERVAL_MS = 25;

function startCapacityCalculation(): void {
	if (tickIntervalHandle !== null) {
		context.clearInterval(tickIntervalHandle);
		tickIntervalHandle = null;
	}

	// Ride entrance/exit tiles won't change mid-calculation, but rides can be
	// built/removed between calculations, so the cache must be rebuilt each
	// time a fresh calculation starts.
	rideEntranceExitTileKeys = null;

	const size = map.size;
	calculation = {
		phase: "scanning-entrances",
		mapWidth: size.x,
		mapHeight: size.y,
		totalTiles: size.x * size.y,
		scanIndex: 0,
		pathInfo: new Map<number, PathTileInfo>(),
		seeds: [],
		frontier: [],
		visited: new Set<number>(),
		pathTiles: 0,
		queueTiles: 0,
		gardeningTiles: 0,
		patrolTileList: [],
		gardeningTileList: []
	};

	capacityProgressStore.set(0);
	capacityResultStore.set("Calculating...");

	tickIntervalHandle = context.setInterval(onCalculationTick, CALCULATION_INTERVAL_MS);
}

function onCalculationTick(): void {
	const state = calculation;
	if (!state) {
		return;
	}

	try {
		let budget = TILES_PER_TICK;

		if (state.phase === "scanning-entrances") {
			budget = scanForEntrances(state, budget);
		}

		if (state.phase === "flood-fill") {
			floodFillPaths(state, budget);
		}

		updateProgress(state);

		if (state.phase === "done") {
			finishCalculation(state);
		}
	}
	catch (error) {
		// Never leave the UI stuck on "Calculating..." silently; log the
		// failure and stop the interval so the window recovers.
		console.log("Staff Assigner: capacity calculation failed - " + error);
		if (tickIntervalHandle !== null) {
			context.clearInterval(tickIntervalHandle);
			tickIntervalHandle = null;
		}
		calculation = null;
		capacityResultStore.set("Calculation failed, see console.");
	}
}

// Used only as a fallback when no park-entrance seed tiles were found. Runs
// a quick connected-components scan (in memory, over the already-discovered
// footpath tiles) and returns one tile belonging to the largest connected
// network, so the flood fill starts from the park's real path system rather
// than being seeded from every disconnected/decorative path fragment.
function findLargestConnectedPathTile(state: CalculationState): CoordsXY | null {
	const seen = new Set<number>();
	let bestTile: CoordsXY | null = null;
	let bestSize = 0;

	state.pathInfo.forEach(function (_info, startKey) {
		if (seen.has(startKey)) {
			return;
		}
		const startTile = { x: startKey % state.mapWidth, y: Math.floor(startKey / state.mapWidth) };
		const stack: CoordsXY[] = [startTile];
		seen.add(startKey);
		let size = 0;

		while (stack.length > 0) {
			const tile = stack.pop() as CoordsXY;
			size++;

			for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
				const offset = NEIGHBOUR_OFFSETS[i];
				const nx = tile.x + offset.x;
				const ny = tile.y + offset.y;
				if (nx < 0 || ny < 0 || nx >= state.mapWidth || ny >= state.mapHeight) {
					continue;
				}
				const key = tileKey(nx, ny, state.mapWidth);
				if (seen.has(key) || !state.pathInfo.has(key)) {
					continue;
				}
				seen.add(key);
				stack.push({ x: nx, y: ny });
			}
		}

		if (size > bestSize) {
			bestSize = size;
			bestTile = startTile;
		}
	});

	return bestTile;
}

// Scans the whole map, one batch of tiles at a time, recording every footpath
// tile found (so the flood fill can later expand across them) and looking
// for park entrance tiles; the footpath tile that guests actually walk on is
// usually the entrance tile itself or one of its 4 direct neighbours, so both
// are checked to find the seed tile(s) the flood fill starts from.
function scanForEntrances(state: CalculationState, budget: number): number {
	while (budget > 0 && state.scanIndex < state.totalTiles) {
		const x = state.scanIndex % state.mapWidth;
		const y = Math.floor(state.scanIndex / state.mapWidth);
		state.scanIndex++;
		budget--;

		const footpath = findFootpathElement(x, y);
		if (footpath) {
			// Path tiles outside the owned park boundary (e.g. the approach path
			// leading from off-park land to the park entrance) must remain
			// walkable for reachability purposes, but staff can't be assigned to
			// patrol land that isn't owned by the park, so such tiles are
			// recorded as connector-only (crossed by the flood fill, but never
			// added to the patrol tile list). Only full ownership counts here:
			// tiles with construction rights only (typically the scenario's
			// entrance approach road) can be built on but aren't actually park
			// property, so they must not be treated as patrollable either.
			const surface = findSurfaceElement(x, y);
			const isOwned = !!surface && surface.hasOwnership;
			state.pathInfo.set(tileKey(x, y, state.mapWidth), { isQueue: isQueueFootpath(footpath), isConnectorOnly: !isOwned });
		}
		else if (hasRideEntranceOrExitElement(x, y, state.mapWidth)) {
			// Ride entrance/exit tiles link the main path network to that
			// ride's queue line; record them as walkable connector nodes so
			// the flood fill can cross them, without counting them as a
			// patrol tile themselves.
			state.pathInfo.set(tileKey(x, y, state.mapWidth), { isQueue: false, isConnectorOnly: true });
		}

		if (isGardeningTile(x, y, footpath)) {
			state.gardeningTiles++;
			state.gardeningTileList.push({ x: x, y: y });
		}

		if (hasParkEntranceElement(x, y, state.mapWidth)) {
			if (footpath) {
				state.seeds.push({ x: x, y: y });
			}
			for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
				const offset = NEIGHBOUR_OFFSETS[i];
				const nx = x + offset.x;
				const ny = y + offset.y;
				if (nx < 0 || ny < 0 || nx >= state.mapWidth || ny >= state.mapHeight) {
					continue;
				}
				if (findFootpathElement(nx, ny)) {
					state.seeds.push({ x: nx, y: ny });
				}
			}
		}
	}

	if (state.scanIndex >= state.totalTiles) {
		// Normally the park-entrance seeds are what the flood fill starts
		// from. If none were found (e.g. the entrance tile detection missed
		// due to API differences), fall back to finding the largest connected
		// path network on the map and seeding from a single tile within it.
		// Seeding from every discovered footpath tile (regardless of
		// connectivity) would incorrectly merge disconnected, unreachable
		// decorative path networks (e.g. purely decorative streets) into the
		// counted result, so only a single representative tile from the
		// largest connected component is used here.
		let seedTiles = state.seeds;
		if (seedTiles.length === 0) {
			const largestComponentSeed = findLargestConnectedPathTile(state);
			seedTiles = largestComponentSeed ? [largestComponentSeed] : [];
		}

		for (let i = 0; i < seedTiles.length; i++) {
			const seed = seedTiles[i];
			const key = tileKey(seed.x, seed.y, state.mapWidth);
			if (state.visited.has(key)) {
				continue; // avoid double-counting a tile seeded from multiple entrance tiles
			}
			if (!state.pathInfo.has(key)) {
				continue;
			}
			state.visited.add(key);
			state.frontier.push(seed);
		}
		state.phase = (state.frontier.length > 0) ? "flood-fill" : "done";
	}

	return budget;
}

// Flood fills outwards from the seed tiles across connected footpath and
// ride entrance/exit (connector) tiles, counting plain path tiles and queue
// tiles separately; connector-only tiles are traversed but not counted or
// added to the patrol tile list, since staff can't patrol a ride's entrance
// building itself.
function floodFillPaths(state: CalculationState, budget: number): number {
	while (budget > 0 && state.frontier.length > 0) {
		const tile = state.frontier.pop() as CoordsXY;
		budget--;

		const info = state.pathInfo.get(tileKey(tile.x, tile.y, state.mapWidth));
		if (!info) {
			continue;
		}

		if (!info.isConnectorOnly) {
			if (info.isQueue) {
				state.queueTiles++;
			}
			else {
				state.pathTiles++;
			}
			state.patrolTileList.push({ x: tile.x, y: tile.y });
		}

		for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
			const offset = NEIGHBOUR_OFFSETS[i];
			const nx = tile.x + offset.x;
			const ny = tile.y + offset.y;
			if (nx < 0 || ny < 0 || nx >= state.mapWidth || ny >= state.mapHeight) {
				continue;
			}
			const key = tileKey(nx, ny, state.mapWidth);
			if (state.visited.has(key) || !state.pathInfo.has(key)) {
				continue;
			}
			state.visited.add(key);
			state.frontier.push({ x: nx, y: ny });
		}
	}

	if (state.frontier.length === 0) {
		state.phase = "done";
	}

	return budget;
}

// Scanning and flood-filling are each given half of the progress bar; the
// flood-fill share is approximated from how much of the map has been visited
// so far, since the true size of the reachable network isn't known upfront.
function updateProgress(state: CalculationState): void {
	let progress: number;
	if (state.phase === "done") {
		progress = 100;
	}
	else if (state.phase === "scanning-entrances") {
		progress = (state.totalTiles > 0) ? (state.scanIndex / state.totalTiles) * 50 : 50;
	}
	else {
		const visitedFraction = (state.totalTiles > 0) ? (state.visited.size / state.totalTiles) : 1;
		progress = 50 + Math.min(49, visitedFraction * 200);
	}
	capacityProgressStore.set(Math.max(0, Math.min(100, Math.round(progress))));
}

function finishCalculation(state: CalculationState): void {
	if (tickIntervalHandle !== null) {
		context.clearInterval(tickIntervalHandle);
		tickIntervalHandle = null;
	}

	const exits = countRideExits();
	capacityResultStore.set(state.pathTiles + " path / " + state.queueTiles + " queue / " + exits + " exits / " + state.gardeningTiles + " gardening");
	capacityProgressStore.set(100);
	totalPatrolTilesStore.set(state.pathTiles + state.queueTiles);
	totalPathOnlyTilesStore.set(state.pathTiles);
	totalGardeningTilesStore.set(state.gardeningTiles);
	totalRideExitsStore.set(exits);
	lastPatrolTileList = state.patrolTileList;
	lastGardeningTileList = state.gardeningTileList;
	refreshHiredAndAssignedStaffCounts();
	calculation = null;
}

// --- Apply: Handymen -----------------------------------------------------------
// Bitmask values for Handyman.orders / StaffSetOrdersArgs.staffOrders /
// StaffHireArgs.staffOrders (see openrct2.d.ts): 1 = Sweeping, 2 = Watering
// flowers, 4 = Empty bins, 8 = Mowing.
const HANDYMAN_ORDER_SWEEPING = 1;
const HANDYMAN_ORDER_WATERING = 2;
const HANDYMAN_ORDER_EMPTY_BINS = 4;
const HANDYMAN_ORDER_MOWING = 8;
const HANDYMAN_ORDERS_CLEANUP = HANDYMAN_ORDER_SWEEPING | HANDYMAN_ORDER_EMPTY_BINS;
const HANDYMAN_ORDERS_GARDENING = HANDYMAN_ORDER_WATERING | HANDYMAN_ORDER_MOWING;

const STAFF_TYPE_HANDYMAN = 0; // StaffHireArgs.staffType value for handymen

// Splits an ordered list of tiles into consecutive chunks of at most
// `chunkSize` tiles each, so each chunk can become one staff member's patrol
// area. Returns an empty array if chunkSize is not positive.
function splitIntoChunks(tiles: CoordsXY[], chunkSize: number): CoordsXY[][] {
	if (chunkSize <= 0) {
		return [];
	}
	const chunks: CoordsXY[][] = [];
	for (let i = 0; i < tiles.length; i += chunkSize) {
		chunks.push(tiles.slice(i, i + chunkSize));
	}
	return chunks;
}

// Removes every handyman currently hired, firing the newest ones first if
// there are more than `neededCount` of them, then hires additional handymen
// if understaffed. Invokes onDone with the final full list of handymen
// (oldest first) once hiring/firing and patrol-area resets are complete.
function resetAndTrimHandymen(neededCount: number, onDone: (handymen: Handyman[]) => void): void {
	const allStaff = map.getAllEntities("staff") as Staff[];
	const handymen: Handyman[] = [];
	for (let i = 0; i < allStaff.length; i++) {
		const member = allStaff[i];
		if (member.staffType === "handyman") {
			handymen.push(member as Handyman);
		}
	}

	// Clicking Apply always starts from a clean slate: clear every existing
	// handyman's patrol area first (before any hiring/firing), so stale
	// assignments from a previous Apply never linger, even for staff that
	// are about to be fired anyway.
	for (let i = 0; i < handymen.length; i++) {
		handymen[i].patrolArea.clear();
	}

	// Fire the newest handymen first if there are more than needed. Entity
	// ids increase monotonically as entities are created, so the highest id
	// is the most recently hired.
	handymen.sort(function (a, b) { return (a.id as number) - (b.id as number); });

	const toFire = handymen.length > neededCount ? handymen.splice(neededCount) : [];
	const surviving = handymen;

	let fireIndex = toFire.length - 1; // fire newest (highest id) first
	function fireNext(): void {
		if (fireIndex < 0) {
			hireMissingHandymen(surviving, neededCount, onDone);
			return;
		}
		const member = toFire[fireIndex];
		fireIndex--;
		context.executeAction("stafffire", { id: member.id as number }, function () {
			// This callback runs asynchronously, outside of any try/catch the
			// caller may have wrapped around the initial resetAndTrimHandymen(...)
			// call; an uncaught exception here would silently stop the chain
			// partway through, leaving onDone (and therefore the confirmation
			// dialog) never invoked.
			try {
				fireNext();
			}
			catch (error) {
				console.log("Staff Assigner: firing handymen failed - " + error);
				onDone(surviving);
			}
		});
	}
	fireNext();
}

// Hires additional handymen until `survivors` reaches `neededCount`, then
// invokes onDone with the final full list of handymen (oldest first).
function hireMissingHandymen(survivors: Handyman[], neededCount: number, onDone: (handymen: Handyman[]) => void): void {
	const missing = neededCount - survivors.length;
	if (missing <= 0) {
		onDone(survivors);
		return;
	}

	let remaining = missing;
	function hireNext(): void {
		if (remaining <= 0) {
			onDone(survivors);
			return;
		}
		remaining--;
		context.executeAction("staffhire", {
			autoPosition: true,
			staffType: STAFF_TYPE_HANDYMAN,
			costumeIndex: 0,
			staffOrders: 0
		}, function (result) {
			// This callback runs asynchronously, outside of any try/catch the
			// caller may have wrapped around the initial resetAndTrimHandymen(...)
			// call; an uncaught exception here (e.g. hiring failing, such as
			// insufficient funds) would silently stop the chain partway through,
			// leaving onDone (and therefore the confirmation dialog) never invoked.
			try {
				const peepId = (result as StaffHireNewActionResult).peep;
				if (typeof peepId === "number") {
					const entity = map.getEntity(peepId);
					if (entity) {
						survivors.push(entity as Handyman);
					}
				}
				hireNext();
			}
			catch (error) {
				console.log("Staff Assigner: hiring handymen failed - " + error);
				onDone(survivors);
			}
		});
	}
	hireNext();
}

// Assigns consecutive chunks of `tiles` to `handymen` (one chunk per
// handyman, in order), sets their orders, and teleports each handyman to a
// tile within their new patrol area. Handymen beyond the available chunks
// (or if there are no tiles for their job) are left with an empty patrol
// area and no orders for that job.
function assignHandymenToTiles(handymen: Handyman[], tiles: CoordsXY[], tilesPerStaff: number, orders: number): void {
	const chunks = splitIntoChunks(tiles, tilesPerStaff);
	for (let i = 0; i < handymen.length; i++) {
		const member = handymen[i];
		const chunk = i < chunks.length ? chunks[i] : [];
		if (chunk.length > 0) {
			member.patrolArea.add(chunk);
		}
		context.executeAction("staffsetorders", { id: member.id as number, staffOrders: orders }, function () { });
		if (chunk.length > 0) {
			const tile = chunk[0];
			// Use the footpath's own height, not the ground surface's height:
			// on elevated/bridge paths the surface underneath can be far below
			// (e.g. over water), and placing staff there would teleport them
			// into the water instead of onto the path.
			const tileFootpath = findFootpathElement(tile.x, tile.y);
			let z = member.z;
			if (tileFootpath) {
				z = tileFootpath.baseHeight * 8;
			}
			else {
				const surface = findSurfaceElement(tile.x, tile.y);
				if (surface) {
					z = surface.baseHeight * 8;
				}
			}
			member.x = tile.x * 32 + 16;
			member.y = tile.y * 32 + 16;
			member.z = z;
		}
	}
}

// Applies the full Handymen plan: reset patrol areas, hire/fire to match
// Needed (firing newest first), split the cleanup and gardening tile lists
// into consecutive areas, assign orders, and teleport each handyman into
// their new area.
function applyHandymenChanges(onComplete: () => void): void {
	const needed = handymenNeededStore.get();
	resetAndTrimHandymen(needed, function (handymen) {
		// The confirmation dialog only closes once onComplete() is invoked, so
		// it must always run - even if something below throws - otherwise the
		// dialog is left open forever with no way to dismiss it.
		try {
			const cleanupCount = computeNeeded(lastPatrolTileList.length, handymenTilesPerStaffStore.get());
			const cleanupHandymen = handymen.slice(0, cleanupCount);
			const gardeningHandymen = handymen.slice(cleanupCount);

			assignHandymenToTiles(cleanupHandymen, lastPatrolTileList, handymenTilesPerStaffStore.get(), HANDYMAN_ORDERS_CLEANUP);
			assignHandymenToTiles(gardeningHandymen, lastGardeningTileList, handymenMowerTilesPerStaffStore.get(), HANDYMAN_ORDERS_GARDENING);

			refreshHiredAndAssignedStaffCounts();
		}
		catch (error) {
			console.log("Staff Assigner: applying handymen changes failed - " + error);
		}
		finally {
			onComplete();
		}
	});
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
			label({ text: name, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip }),
			label({ text: text, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip })
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
		statRow("Needed", needed, "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each."),
		statRow("Hired", hired, "The number of staff of this type currently hired in the park."),
		statRow("Difference", difference, "Needed minus Hired: a positive number means staff of this type need to be hired, a negative number means staff can be fired.")
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: Store<number> | null, needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, spinnerLabel?: string, mowerTilesPerStaff?: Store<number>, mowerSpinnerLabel?: string, spinnerTooltip?: string): WidgetCreator<FlexiblePosition> {
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
						label({ text: spinnerLabel || "", width: "2w", height: 14, padding: { top: 2 } }),
						spinner({
							value: tilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: spinnerTooltip || "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed.",
							onChange: function (value) { tilesPerStaff.set(value); }
						})
					]
				})] : []),
				...(mowerTilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: mowerSpinnerLabel || "", width: "2w", height: 14, padding: { top: 2 } }),
						spinner({
							value: mowerTilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: "The number of gardening tiles (tiles that need mowing or watering) a single gardening-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many gardening handymen are Needed.",
							onChange: function (value) { mowerTilesPerStaff.set(value); }
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
							label({ text: "Tiles / Staff", width: "2w", height: 14, padding: { top: 2 } }),
							spinner({
								value: entertainersTilesPerStaffStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								onChange: function (value) { entertainersTilesPerStaffStore.set(value); }
							})
						]
					}),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: "Staff / Area", width: "2w", height: 14, padding: { top: 2 } }),
							spinner({
								value: entertainersPerAreaStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: "The number of entertainers to assign per patrol area.",
								onChange: function (value) { entertainersPerAreaStore.set(value); }
							})
						]
					}),
				toggle({ text: "Queue", width: "100%", height: 14, isPressed: entertainersIncludeQueueStore, onChange: function (isPressed) { entertainersIncludeQueueStore.set(isPressed); } }),
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
const APPLY_ROW_HEIGHT = 20;
const CONTENT_SPACING = 4; // spacing between the window's top-level content rows
const WINDOW_CHROME_HEIGHT = 29; // title bar + top/bottom window padding
const WINDOW_HEIGHT = TOP_ROW_HEIGHT + CONTENT_SPACING + COLUMN_ROW_HEIGHT + CONTENT_SPACING + APPLY_ROW_HEIGHT + WINDOW_CHROME_HEIGHT;

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
				horizontal({
					spacing: 6,
					height: 14,
					content: [
						button({ text: "Calculate", width: 70, height: 14, onClick: startCapacityCalculation }),
						label({ text: capacityResultStore, width: "1w", height: 14 })
					]
				}),
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
				button({
					text: "Apply and close", width: "100%", height: 20, onClick: function () {
						const delta = handymenNeededStore.get() - handymenHiredStore.get();
						const message = delta > 0
							? ("This will hire " + delta + " additional handymen")
							: (delta < 0
								? ("This will fire " + (-delta) + " handymen")
								: "This will not change the number of handymen");
						showConfirmDialog("Confirm Handymen", message, function (onComplete) {
							applyHandymenChanges(function () {
								onComplete();
								if (windowTemplate) {
									windowTemplate.close();
								}
							});
						});
					}
				})
			]
		});
	}
	return windowTemplate;
}

function openWindow(): void {
	staffAssignerWindowTemplate().open();
}

// --- Confirmation dialog -------------------------------------------------------
// A small, self-contained Confirm/Cancel dialog. A fresh window is built
// every time it's shown (rather than reusing a cached WindowTemplate like
// the main window) since its message and callback differ per invocation.
// Cancel closes the dialog immediately; Confirm keeps it open until onConfirm
// invokes the completion callback it's given (i.e. once the action is done).
function showConfirmDialog(title: string, message: string, onConfirm: (onComplete: () => void) => void): void {
	let dialog: WindowTemplate | null = null;

	function closeDialog(): void {
		if (dialog) {
			dialog.close();
			dialog = null;
		}
	}

	dialog = flexWindow({
		title: title,
		width: 260,
		height: 90,
		x: Math.round((ui.width - 260) / 2),
		y: Math.round((ui.height - 90) / 2),
		spacing: 6,
		content: [
			label({ text: message, width: "100%", height: "1w" }),
			horizontal({
				spacing: 6,
				height: 14,
				content: [
					button({
						text: "Confirm", width: "1w", height: 14, onClick: function () {
							// onConfirm may throw synchronously (before any async
							// callback runs) if something goes wrong; without this
							// try/catch such an error would propagate out of the
							// button's onClick handler and leave the dialog open
							// forever with no way to dismiss it.
							try {
								onConfirm(closeDialog);
							}
							catch (error) {
								console.log("Staff Assigner: confirm action failed - " + error);
								closeDialog();
							}
						}
					}),
					button({ text: "Cancel", width: "1w", height: 14, onClick: closeDialog })
				]
			})
		]
	});
	dialog.open();
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

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
const totalMowableTilesStore = flexStore<number>(0);

const handymenTilesPerStaffStore = flexStore<number>(8);
const handymenMowerTilesPerStaffStore = flexStore<number>(64);
const guardsTilesPerStaffStore = flexStore<number>(16);
const mechanicsTilesPerStaffStore = flexStore<number>(4); // placeholder: Mechanics calculation not implemented yet

const handymenHiredStore = flexStore<number>(0);
const handymenAssignedStore = flexStore<number>(0);
const guardsHiredStore = flexStore<number>(0);
const guardsAssignedStore = flexStore<number>(0);

function computeNeeded(totalTiles: number, tilesPerStaff: number): number {
	if (tilesPerStaff <= 0 || totalTiles <= 0) {
		return 0;
	}
	return Math.ceil(totalTiles / tilesPerStaff);
}

const handymenNeededStore = compute(totalPatrolTilesStore, handymenTilesPerStaffStore, computeNeeded);
const guardsNeededStore = compute(totalPatrolTilesStore, guardsTilesPerStaffStore, computeNeeded);

// Refreshes the Hired/Assigned stores for both Handymen and Guards from the
// current, real-time staff roster. Unlike Needed (which depends on the
// potentially slow tile scan), this is cheap and can be refreshed whenever
// Calculate is pressed.
function refreshHiredAndAssignedStaffCounts(): void {
	handymenHiredStore.set(countHiredStaff("handyman"));
	handymenAssignedStore.set(countAssignedStaff("handyman"));
	guardsHiredStore.set(countHiredStaff("security"));
	guardsAssignedStore.set(countAssignedStaff("security"));
}

type CalculationPhase = "scanning-entrances" | "flood-fill" | "done";

interface PathTileInfo {
	isQueue: boolean;
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
	mowableTiles: number;
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

// A tile is mowable if it is owned by the park, has a grass surface (i.e. not
// water) and isn't covered by a footpath, since guests/staff can't walk on
// grass hidden underneath a path.
function isMowableTile(x: number, y: number, footpath: FootpathElement | null): boolean {
	if (footpath) {
		return false;
	}
	const surface = findSurfaceElement(x, y);
	if (!surface || !surface.hasOwnership) {
		return false;
	}
	return surface.grassLength >= 0;
}

// Entrance elements are used for both ride entrances/exits (which have a real
// ride index) and the park entrance itself (which does not belong to a ride).
// On the current OpenRCT2 scripting API, park entrances report a "no ride"
// value of either RIDE_ID_NULL (0xFFFF) or null/undefined, depending on the
// element accessor used.
function isNoRideSentinel(rideId: number | null | undefined): boolean {
	return rideId === null || rideId === undefined || rideId === RIDE_ID_NULL;
}

function hasParkEntranceElement(x: number, y: number): boolean {
	const tile = map.getTile(x, y);
	for (let i = 0; i < tile.numElements; i++) {
		const element = tile.getElement(i);
		if (element.type === "entrance" && isNoRideSentinel((element as EntranceElement).ride)) {
			return true;
		}
	}
	return false;
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
		mowableTiles: 0
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
			state.pathInfo.set(tileKey(x, y, state.mapWidth), { isQueue: !!footpath.isQueue });
		}

		if (isMowableTile(x, y, footpath)) {
			state.mowableTiles++;
		}

		if (hasParkEntranceElement(x, y)) {
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
		// due to API differences), fall back to seeding from every footpath
		// tile discovered during the scan so the calculation still reports
		// the size of the path network instead of silently returning zero.
		let seedTiles = state.seeds;
		if (seedTiles.length === 0) {
			seedTiles = [];
			state.pathInfo.forEach(function (_info, key) {
				seedTiles.push({ x: key % state.mapWidth, y: Math.floor(key / state.mapWidth) });
			});
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

// Flood fills outwards from the seed tiles across connected footpath tiles,
// counting plain path tiles and queue tiles separately.
function floodFillPaths(state: CalculationState, budget: number): number {
	while (budget > 0 && state.frontier.length > 0) {
		const tile = state.frontier.pop() as CoordsXY;
		budget--;

		const info = state.pathInfo.get(tileKey(tile.x, tile.y, state.mapWidth));
		if (!info) {
			continue;
		}

		if (info.isQueue) {
			state.queueTiles++;
		}
		else {
			state.pathTiles++;
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
	capacityResultStore.set(state.pathTiles + " path / " + state.queueTiles + " queue / " + exits + " exits / " + state.mowableTiles + " mowable");
	capacityProgressStore.set(100);
	totalPatrolTilesStore.set(state.pathTiles + state.queueTiles);
	totalMowableTilesStore.set(state.mowableTiles);
	refreshHiredAndAssignedStaffCounts();
	calculation = null;
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
			isStore(hired) ? hired : flexStore(hired),
			isStore(needed) ? needed : flexStore(needed),
			function (h: number, n: number) { return h - n; })
		: (hired as number) - (needed as number);
	return [
		statRow("Needed", needed, "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each."),
		statRow("Hired", hired, "The number of staff of this type currently hired in the park."),
		statRow("Difference", difference, "Needed minus Hired: a negative number means staff of this type need to be hired, a positive number means staff can be fired.")
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: Store<number> | null, needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, spinnerLabel?: string, mowerTilesPerStaff?: Store<number>, mowerSpinnerLabel?: string): WidgetCreator<FlexiblePosition> {
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
							minimum: 1,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: "The number of pathway tiles a single staff member of this type is expected to patrol (tiles per staff). Used to calculate how many staff are Needed.",
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
							minimum: 1,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: "The number of pathway tiles a single mower-assigned handyman is expected to patrol (tiles per staff).",
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
function entertainersGroup(needed: number, hired: number, assigned: number, width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
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
							label({ text: "Tiles", width: "2w", height: 14, padding: { top: 2 } }),
							spinner({ value: 16, minimum: 0, maximum: 999, width: "3w", height: 14 })
						]
					}),
					toggle({ text: "Queue", width: "100%", height: 14, isPressed: true }),
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
const ENTERTAINERS_EXTRA_HEIGHT = 14 + 3; // extra "Queue" toggle row + spacing
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
		const windowWidth = 360;
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
									staffGroup("Handymen", handymenTilesPerStaffStore, handymenNeededStore, handymenHiredStore, handymenAssignedStore, "100%", HANDYMEN_HEIGHT, "Cleanup", handymenMowerTilesPerStaffStore, "Mowing"),
											staffGroup("Guards", guardsTilesPerStaffStore, guardsNeededStore, guardsHiredStore, guardsAssignedStore, "100%", GROUP_HEIGHT, "Tiles")
										]
									}),
								vertical({
									spacing: 4,
									width: GROUP_WIDTH,
									height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
									content: [
											staffGroup("Mechanics", null, 160, 150, 145, "100%", MECHANICS_HEIGHT),
											entertainersGroup(160, 150, 145, "100%", ENTERTAINERS_HEIGHT)
								]
						})
					]
				}),
				button({ text: "apply", width: "100%", height: 20 })
			]
		});
	}
	return windowTemplate;
}

function openWindow(): void {
	staffAssignerWindowTemplate().open();
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

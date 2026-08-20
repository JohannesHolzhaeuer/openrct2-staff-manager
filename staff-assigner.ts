/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle,
	store as flexStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, ElementVisibility,
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

type CalculationPhase = "scanning-entrances" | "flood-fill" | "done";

interface CalculationState {
	phase: CalculationPhase;
	mapWidth: number;
	mapHeight: number;
	totalTiles: number;
	scanIndex: number;    // linear tile index used while scanning for the park entrance
	seeds: CoordsXY[];
	frontier: CoordsXY[]; // tiles still to be visited during the flood fill
	visited: Set<number>; // visited tile keys (y * mapWidth + x)
	pathTiles: number;
	queueTiles: number;
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
		seeds: [],
		frontier: [],
		visited: new Set<number>(),
		pathTiles: 0,
		queueTiles: 0
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

// Scans the whole map, one batch of tiles at a time, looking for a park
// entrance tile; the footpath tile that guests actually walk on is usually
// the entrance tile itself or one of its 4 direct neighbours, so both are
// checked to find the seed tile(s) the flood fill starts from.
function scanForEntrances(state: CalculationState, budget: number): number {
	while (budget > 0 && state.scanIndex < state.totalTiles) {
		const x = state.scanIndex % state.mapWidth;
		const y = Math.floor(state.scanIndex / state.mapWidth);
		state.scanIndex++;
		budget--;

		if (hasParkEntranceElement(x, y)) {
			if (findFootpathElement(x, y)) {
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
		for (let i = 0; i < state.seeds.length; i++) {
			const seed = state.seeds[i];
			const key = tileKey(seed.x, seed.y, state.mapWidth);
			if (state.visited.has(key)) {
				continue; // avoid double-counting a tile seeded from multiple entrance tiles
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

		const element = findFootpathElement(tile.x, tile.y);
		if (!element) {
			continue;
		}

		if (element.isQueue) {
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
			if (state.visited.has(key)) {
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
	capacityResultStore.set(state.pathTiles + " path / " + state.queueTiles + " queue / " + exits + " exits");
	capacityProgressStore.set(100);
	calculation = null;
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, "current/target"
// text, apply and reset buttons. Mirrors the marginRect groups in the
// mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, count: number, ratioText: string, width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 4,
			content: [
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						spinner({ value: count, minimum: 0, maximum: 999, width: "5w", height: 14 }),
						label({ text: ratioText, width: "8w", height: 14, alignment: "centred" })
					]
				}),
				horizontal({
					spacing: 4,
					height: 16,
					content: [
						button({ text: "apply", width: "11w", height: 16 }),
						button({ text: "reset", width: "10w", height: 16 })
					]
				})
			]
		})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: "Entertainers",
		width: width,
		height: height,
		content: vertical({
			spacing: 4,
			content: [
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						spinner({ value: 16, minimum: 0, maximum: 999, width: "5w", height: 14 }),
						label({ text: "160 / 150", width: "8w", height: 14, alignment: "centred" })
					]
				}),
				toggle({ text: "Queue", width: "100%", height: 12 }),
				horizontal({
					spacing: 4,
					height: 16,
					content: [
						button({ text: "apply", width: "11w", height: 16 }),
						button({ text: "reset", width: "10w", height: 16 })
					]
				})
			]
		})
	});
}

// --- Window ------------------------------------------------------------------
let windowTemplate: WindowTemplate | null = null;

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const GROUP_HEIGHT = 48;
const STACK_HEIGHT = GROUP_HEIGHT * 2 + 4; // two stacked groups + spacing

function staffAssignerWindowTemplate(): WindowTemplate {
	if (!windowTemplate) {
		windowTemplate = flexWindow({
			title: "Staff Assigner",
			width: 420,
			height: 180,
			minWidth: 420,
			minHeight: 180,
			spacing: 4,
			content: [
				horizontal({
					spacing: 6,
					height: 30,
					content: [
						button({ text: "Calculate", width: 70, height: 30, onClick: startCapacityCalculation }),
							vertical({
								spacing: 2,
								width: "1w",
								height: 30,
								content: [
									progressBar(capacityProgressStore, "100%", 14),
									label({ text: capacityResultStore, width: "100%", height: 12 })
								]
							})
					]
				}),
				horizontal({
					spacing: 6,
					height: STACK_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
								staffGroup("Handymen", 8, "160 / 150", "100%", GROUP_HEIGHT),
								staffGroup("Guards", 16, "160 / 150", "100%", GROUP_HEIGHT)
							]
						}),
						entertainersGroup(GROUP_WIDTH, STACK_HEIGHT),
						staffGroup("Mechanics", 4, "160 / 150", GROUP_WIDTH, STACK_HEIGHT)
					]
				})
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

/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { autoEnabledStore } from "./store";
import { isPlainPathTile, isQueueTile, worldToTile } from "./scan";
import { handlePlacedPathTile, handleBoughtLandTile } from "./staff";

// The storage key backing the persisted auto flag. Versioned so an earlier
// persisted "on" value isn't carried over (the default is off).
const AUTO_STORAGE_KEY = "staffManager.autoEnabled.v1";

// How long to wait after the last relevant action before processing any queued tiles.
// Coalesces bursts of tile placements (e.g. dragging a long path) into a single
// batch, but never performs a full map rescan.
const DEBOUNCE_MS = 250;

let actionSubscription: IDisposable | null = null;
let pendingTimer: number | null = null;
let pendingTiles: { x: number; y: number; kind: "path" | "queue" | "land" }[] = [];
let isWorking = false;

export function setAutoEnabled(enabled: boolean): void {
	autoEnabledStore.set(enabled);
	context.sharedStorage.set(AUTO_STORAGE_KEY, enabled);
	if (pendingTimer !== null) {
		context.clearTimeout(pendingTimer);
		pendingTimer = null;
	}
	pendingTiles = [];
	if (actionSubscription) {
		actionSubscription.dispose();
		actionSubscription = null;
	}
	if (enabled) {
		actionSubscription = context.subscribe("action.execute", onAction);
	}
}

// Called for every executed game action while auto is on.
function onAction(e: GameActionEventArgs): void {
	// Ignore actions fired by this plugin itself (hires/teleports/patrol-area).
	if (isWorking) {
		return;
	}
	collectFromAction(e);
}

// Extracts the affected tile(s) from a relevant action and queues them.
function collectFromAction(e: GameActionEventArgs): void {
	const action = e.action;

	if (action === "footpathplace" || action === "footpathremove") {
		const args = e.args as { x: number; y: number };
		const tile = worldToTile(args.x, args.y);
		// Removing a path can't change need upward (staff aren't going to need more of
		// a removed tile), so only handle placements.
		if (action === "footpathplace") {
			queueTile(tile.x, tile.y, classifyPathTile(tile.x, tile.y));
		}
		return;
	}

	if (action === "footpathlayoutplace") {
		const args = e.args as { x: number; y: number; slope: number };
		const centre = worldToTile(args.x, args.y);
		// A layout place can add the centre and (via the slope edges bitmask)
		// adjacent tiles; process the centre plus its cardinal neighbours that got a
		// footpath. To keep it simple and still robust, queue the touched tiles that
		// actually now have a path.
		queueTile(centre.x, centre.y, classifyPathTile(centre.x, centre.y));
		return;
	}

	if (action === "landbuyrights") {
		const args = e.args as { x1: number; y1: number; x2: number; y2: number; setting: number };
		// Only buying LAND (setting 0), not construction rights.
		if (args.setting !== 0) {
			return;
		}
		const bx1 = Math.floor(Math.min(args.x1, args.x2) / 32);
		const by1 = Math.floor(Math.min(args.y1, args.y2) / 32);
		const bx2 = Math.floor(Math.max(args.x1, args.x2) / 32);
		const by2 = Math.floor(Math.max(args.y1, args.y2) / 32);
		for (let x = bx1; x <= bx2; x++) {
			for (let y = by1; y <= by2; y++) {
				pendingTiles.push({ x: x, y: y, kind: "land" });
			}
		}
		schedule();
		return;
	}

	// rideentranceexitplace: an exit placed next to an existing path should get a
	// mechanic. We treat the placed exit tile as a "path-like" tile so the mechanic
	// adjacency check runs.
	if (action === "rideentranceexitplace") {
		const args = e.args as { x: number; y: number; isExit: boolean };
		if (args.isExit) {
			const tile = worldToTile(args.x, args.y);
			pendingTiles.push({ x: tile.x, y: tile.y, kind: "path" });
			schedule();
		}
		return;
	}
}

function classifyPathTile(x: number, y: number): "path" | "queue" | "land" {
	return isQueueTile(x, y) ? "queue" : (isPlainPathTile(x, y) ? "path" : "land");
}

function queueTile(x: number, y: number, kind: "path" | "queue" | "land"): void {
	pendingTiles.push({ x: x, y: y, kind: kind });
	schedule();
}

// Debounce: coalesce a burst of tile placements into one grouped processing pass.
function schedule(): void {
	if (pendingTimer !== null) {
		context.clearTimeout(pendingTimer);
	}
	pendingTimer = context.setTimeout(function () {
		pendingTimer = null;
		processPending();
	}, DEBOUNCE_MS);
}

// Processes all queued tiles in one batch (still only touching affected tiles, no
// full map scan).
function processPending(): void {
	const tiles = pendingTiles;
	pendingTiles = [];
	if (tiles.length === 0) {
		return;
	}
	if (isWorking) {
		return;
	}
	isWorking = true;
	try {
		for (const t of tiles) {
			if (t.kind === "land") {
				handleBoughtLandTile(t.x, t.y);
			} else {
				handlePlacedPathTile(t.x, t.y, t.kind === "queue");
			}
		}
	} catch {
		// ignore errors from individual tile handling
	} finally {
		isWorking = false;
	}
}

// Initialises automatic mode from the persisted setting. Safe to call more than once
// (only subscribes when the flag is true and no subscription exists yet).
export function initAuto(): void {
	if (autoEnabledStore.get() && actionSubscription === null) {
		actionSubscription = context.subscribe("action.execute", onAction);
	}
}

/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { autoEnabledStore } from "./store";
import { isQueueTile, worldToTile, hasNonGhostFootpathElements } from "./scan";
import { handlePlacedPathTile, handleBoughtLandTile } from "./staff-auto";
import { BATCH_TICK_DELAY } from "./staff";

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

// Deduplicates a list of pending tiles by (x, y, kind), preserving order. Dragging
// the path tool fires a burst of actions that can place the same tile more than
// once (e.g. over a drag, or a preview plus the actual placement); without this, each
// duplicate would be handled separately (and, worse, could hire a fresh staff
// member each time). Keeping the first occurrence per tile means each distinct
// tile is handled exactly once per batch.
function dedupeTiles(tiles: { x: number; y: number; kind: "path" | "queue" | "land" }[]): { x: number; y: number; kind: "path" | "queue" | "land" }[] {
	const seen = new Set<string>();
	const result: { x: number; y: number; kind: "path" | "queue" | "land" }[] = [];
	for (const tile of tiles) {
		const key = String(tile.x) + ":" + String(tile.y) + ":" + tile.kind;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(tile);
	}
	return result;
}

// How many pending tiles to handle per game tick. Processing is chunked and
// re-scheduled with context.setTimeout so a large burst of queued tiles (e.g. a
// long path drag) never blocks the game loop in one tick (which froze the game).
const TILES_PER_TICK = 16;

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
			queueTileIfPlacedPath(tile.x, tile.y);
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
		queueTileIfPlacedPath(centre.x, centre.y);
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

// Queues a freshly placed path/queue tile, but only if it now actually holds a
// real (non-ghost) footpath. Hovering the path tool fires repeated
// footpathplace actions that add then remove a ghost preview path; without the
// non-ghost check, every hover tile would be queued and then classified as
// "land", hiring a staff member (or reassigning one) for a tile no path was
// ever built on.
function queueTileIfPlacedPath(x: number, y: number): void {
	if (!hasNonGhostFootpathElements(x, y)) {
		return;
	}
	const kind = isQueueTile(x, y) ? "queue" : "path";
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

// Processes all queued tiles in one batch per tick (still only touching affected
// tiles, no full map scan), chunking the work across ticks so a large burst
// (e.g. a long path drag) doesn't block the game loop.
function processPending(): void {
	const tiles = dedupeTiles(pendingTiles);
	pendingTiles = [];
	if (tiles.length === 0) {
		return;
	}
	if (isWorking) {
		return;
	}
	isWorking = true;
	let index = 0;
	function step(): void {
		const end = Math.min(tiles.length, index + TILES_PER_TICK);
		try {
			for (; index < end; index++) {
				const t = tiles[index];
				if (t.kind === "land") {
					handleBoughtLandTile(t.x, t.y);
				} else {
					handlePlacedPathTile(t.x, t.y, t.kind === "queue");
				}
			}
		} catch {
			// ignore errors from individual tile handling
		}
		if (index < tiles.length) {
			context.setTimeout(step, BATCH_TICK_DELAY);
		} else {
			isWorking = false;
		}
	}
	step();
}

// Initialises automatic mode from the persisted setting. Safe to call more than once
// (only subscribes when the flag is true and no subscription exists yet).
export function initAuto(): void {
	if (autoEnabledStore.get() && actionSubscription === null) {
		actionSubscription = context.subscribe("action.execute", onAction);
	}
}

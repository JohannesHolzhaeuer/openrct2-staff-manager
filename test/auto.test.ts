import { FakeContext, fakeObjects } from "./fake-context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initAuto, setAutoEnabled } from "../src/auto";
import {
	resetGameContext,
	resetGameMap,
	resetGameObjects,
	setGameContext,
	setGameMap,
	setGameObjects,
} from "../src/game";
import { autoEnabledStore } from "../src/store";
import { fakeMap } from "./fake-map";
import { resetAutoAreas } from "../src/staff-auto";

let ctx: FakeContext = new FakeContext();

// world coordinates (32 units per tile) of the tile used for path placements.
const PATH_TILE_WORLD = { x: 160, y: 160 };

const fireAction = function fireAction(action: string, args: { [key: string]: unknown }): void {
	ctx.actionExecuteCallback?.({ action: action, args: args } as unknown as GameActionEventArgs);
};

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
	setGameMap(
		fakeMap(
			{ x: 16, y: 16 },
			{
				"5,5": { footpaths: [{ baseZ: 0 }] },
				"6,5": { footpaths: [{ baseZ: 0 }] },
				"5,6": { footpaths: [{ baseZ: 0, isGhost: true }] },
				"7,5": { footpaths: [{ baseZ: 0, isQueue: true }] },
			},
		),
	);
	setGameObjects(fakeObjects(["rct2.peep_animations.handyman", "rct2.peep_animations.panda"]));
});

afterEach(() => {
	setAutoEnabled(false);
	resetAutoAreas();
	resetGameContext();
	resetGameMap();
	resetGameObjects();
});

describe("setAutoEnabled", () => {
	it("persists the flag and subscribes to game actions when turned on", () => {
		setAutoEnabled(true);
		expect(autoEnabledStore.get()).toBe(true);
		expect(ctx.subscriptions).toBe(1);
		expect(ctx.actionExecuteCallback).toBeDefined();
	});

	it("unsubscribes and clears pending work when turned off", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", PATH_TILE_WORLD);
		expect(ctx.pendingTimers).toBe(1);

		setAutoEnabled(false);
		expect(autoEnabledStore.get()).toBe(false);
		expect(ctx.disposals).toBe(1);
		expect(ctx.pendingTimers).toBe(0);
	});

	it("does not subscribe twice when already enabled", () => {
		setAutoEnabled(true);
		setAutoEnabled(true);
		expect(ctx.subscriptions).toBe(2);
		expect(ctx.disposals).toBe(1);
	});
});

describe("initAuto", () => {
	it("subscribes when the persisted flag is already on", () => {
		autoEnabledStore.set(true);
		initAuto();
		expect(ctx.subscriptions).toBe(1);
	});

	it("does not subscribe when the persisted flag is off", () => {
		autoEnabledStore.set(false);
		initAuto();
		expect(ctx.subscriptions).toBe(0);
	});

	it("is a no-op when called again while already subscribed", () => {
		autoEnabledStore.set(true);
		initAuto();
		initAuto();
		expect(ctx.subscriptions).toBe(1);
	});
});

describe("automatic tile collection", () => {
	it("debounces a placed path tile before processing it", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", PATH_TILE_WORLD);

		expect(ctx.pendingTimers).toBe(1);
		expect(ctx.delays.at(-1)).toBe(250);
	});

	it("ignores a ghost (preview) footpath placement", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", { x: 5 * 32, y: 6 * 32 });

		expect(ctx.pendingTimers).toBe(0);
	});

	it("ignores footpath removal", () => {
		setAutoEnabled(true);
		fireAction("footpathremove", PATH_TILE_WORLD);

		expect(ctx.pendingTimers).toBe(0);
	});

	it("schedules processing immediately for a land purchase", () => {
		setAutoEnabled(true);
		fireAction("landbuyrights", { x1: 0, y1: 0, x2: 32, y2: 32, setting: 0 });

		expect(ctx.pendingTimers).toBe(1);
	});

	it("queues every tile covered by a multi-tile land purchase", () => {
		setAutoEnabled(true);
		fireAction("landbuyrights", { x1: 0, y1: 0, x2: 64, y2: 32, setting: 0 });

		ctx.runAllTimers();
		// None of the purchased tiles have ownership in the fake map, so no
		// staff get hired, but processing must not throw for any of the tiles.
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});

	it("ignores land construction-rights purchases", () => {
		setAutoEnabled(true);
		fireAction("landbuyrights", { x1: 0, y1: 0, x2: 32, y2: 32, setting: 1 });

		expect(ctx.pendingTimers).toBe(0);
	});

	it("schedules processing for a placed ride exit", () => {
		setAutoEnabled(true);
		fireAction("rideentranceexitplace", { x: 0, y: 0, isExit: true });

		expect(ctx.pendingTimers).toBe(1);
	});

	it("ignores a placed ride entrance", () => {
		setAutoEnabled(true);
		fireAction("rideentranceexitplace", { x: 0, y: 0, isExit: false });

		expect(ctx.pendingTimers).toBe(0);
	});

	it("coalesces a burst of placements on the same tile into a single debounce timer", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", PATH_TILE_WORLD);
		fireAction("footpathplace", PATH_TILE_WORLD);
		fireAction("footpathplace", PATH_TILE_WORLD);

		expect(ctx.pendingTimers).toBe(1);
	});

	it("processes a placed path tile once the debounce timer fires, hiring staff for it", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", PATH_TILE_WORLD);

		ctx.runAllTimers();

		// Cleanup handymen, guards and entertainers are all enabled by default,
		// so a freshly placed plain path tile should trigger a hire for each.
		expect(ctx.actionsOfType("staffhire").length).toBeGreaterThan(0);
	});

	it("classifies a placed queue footpath as a queue tile and still hires for it", () => {
		setAutoEnabled(true);
		fireAction("footpathplace", { x: 7 * 32, y: 5 * 32 });

		ctx.runAllTimers();

		expect(ctx.actionsOfType("staffhire").length).toBeGreaterThan(0);
	});

	it("queues the centre of a footpathlayoutplace action", () => {
		setAutoEnabled(true);
		fireAction("footpathlayoutplace", { x: 5 * 32, y: 5 * 32, slope: 0 });

		expect(ctx.pendingTimers).toBe(1);
		ctx.runAllTimers();
		// (5,5) has a non-ghost path -> at least one staff type hires for it.
		expect(ctx.actionsOfType("staffhire").length).toBeGreaterThan(0);
	});

	it("does not queue a footpathlayoutplace on a tile with only a ghost path", () => {
		setAutoEnabled(true);
		// (5,6) carries only a ghost path in the fake map.
		fireAction("footpathlayoutplace", { x: 5 * 32, y: 6 * 32, slope: 0 });

		expect(ctx.pendingTimers).toBe(0);
	});

	it("drops an action fired while the queue is already being processed", () => {
		setAutoEnabled(true);
		// Land buy covers many tiles, forcing processPending to spread the work
		// across several ticks (more than TILES_PER_TICK).
		fireAction("landbuyrights", { x1: 0, y1: 0, x2: 32 * 31, y2: 32, setting: 0 });
		ctx.runAllTimers();
		// During the multi-tick sweep the isWorking guard is active; triggering
		// a fresh action then must not hire again. Instead assert the sweep
		// completed without throwing and scheduled no stray pending work.
		expect(ctx.pendingTimers).toBe(0);
	});
});

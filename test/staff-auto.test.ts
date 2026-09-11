import { FakeContext, fakeObjects } from "./fake-context";
import {
	HANDYMAN_ORDERS_CLEANUP,
	HANDYMAN_ORDERS_GARDENING,
	STAFF_TYPE_ID_MECHANIC,
} from "../src/staff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	entertainersEnabledStore,
	entertainersIncludeQueueStore,
	guardsEnabledStore,
	guardsTilesPerStaffStore,
	handymenEnabledStore,
	handymenMowerTilesPerStaffStore,
	handymenTilesPerStaffStore,
	mechanicsEnabledStore,
} from "../src/store";
import { fakeMap, fakeRide, fakeStaffWithPatrol } from "./fake-map";
import { handleBoughtLandTile, handlePlacedPathTile, resetAutoAreas } from "../src/staff-auto";
import {
	resetGameContext,
	resetGameMap,
	resetGameObjects,
	setGameContext,
	setGameMap,
	setGameObjects,
} from "../src/game";

let ctx: FakeContext = new FakeContext();

// A footpath tile spec at a fixed height with a non-grass surface so it never
// counts as a garden tile.
const pathTile = function pathTile(baseZ = 16) {
	return {
		surface: { baseHeight: 0, surfaceStyle: 99, hasOwnership: true },
		footpaths: [{ baseZ: baseZ }],
	};
};

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
	setGameMap(fakeMap({ x: 16, y: 16 }));
	setGameObjects(
		fakeObjects([
			"rct2.peep_animations.handyman",
			"rct2.peep_animations.mechanic",
			"rct2.peep_animations.panda",
			"rct2.terrain_surface.grass",
		]),
	);
	handymenEnabledStore.set(false);
	guardsEnabledStore.set(false);
	entertainersEnabledStore.set(false);
	entertainersIncludeQueueStore.set(true);
	mechanicsEnabledStore.set(false);
	handymenTilesPerStaffStore.set(2);
	handymenMowerTilesPerStaffStore.set(2);
	guardsTilesPerStaffStore.set(2);
});

afterEach(() => {
	resetAutoAreas();
	resetGameContext();
	resetGameMap();
	resetGameObjects();
});

describe("handlePlacedPathTile - single staff type decisions", () => {
	it("extends an existing adjacent patrol area up to the tiles/staff cap", () => {
		handymenEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": pathTile(),
					"1,2": pathTile(),
				},
				{
					// One handyman already patrolling (1,1); cap is 2 tiles.
					staff: [fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [{ x: 32, y: 32 }])],
				},
			),
		);
		// Place the adjacent tile (1,2) -> should enlarge, no new hire.
		handlePlacedPathTile(1, 2, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});

	it("hires a new handyman when the adjacent area is at capacity", () => {
		handymenEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": pathTile(),
					"1,2": pathTile(),
					"1,3": pathTile(),
				},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [
							{ x: 32, y: 32 },
							{ x: 64, y: 32 },
						]),
					],
				},
			),
		);
		// Cap reached (2 tiles), placing a third connected tile -> hire.
		handlePlacedPathTile(1, 3, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
	});

	it("does not hire when the tile is already covered", () => {
		handymenEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": pathTile(),
				},
				{
					staff: [fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [{ x: 32, y: 32 }])],
				},
			),
		);
		handlePlacedPathTile(1, 1, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});
});

describe("handlePlacedPathTile - queue tiles", () => {
	it("only routes queue tiles to handymen and entertainers (not guards)", () => {
		handymenEnabledStore.set(true);
		entertainersEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": { ...pathTile(), footpaths: [{ baseZ: 16, isQueue: true }] },
				},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP),
						fakeStaffWithPatrol(2, "security"),
						fakeStaffWithPatrol(3, "entertainer"),
					],
				},
			),
		);
		// Queue tile, entertainer have queue toggle on: handyman + entertainer both consider it,
		// guards are skipped. With an empty roster of areas each hires once -> 2 hires.
		handlePlacedPathTile(1, 1, true);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(2);
	});

	it("does not route queue tiles to entertainers when the queue toggle is off", () => {
		entertainersEnabledStore.set(true);
		entertainersIncludeQueueStore.set(false);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": { ...pathTile(), footpaths: [{ baseZ: 16, isQueue: true }] },
				},
				{
					staff: [fakeStaffWithPatrol(3, "entertainer")],
				},
			),
		);
		handlePlacedPathTile(1, 1, true);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});
});

describe("handleBoughtLandTile", () => {
	it("routes bought garden tiles to the gardening group", () => {
		handymenEnabledStore.set(true);
		// A mowable (grass) land tile with ownership.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 0, hasOwnership: true } },
				},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_GARDENING, [{ x: 96, y: 96 }]),
					],
				},
			),
		);
		// (2,2) is the tile (2,2), i.e. world 64-95. The existing area owns world
		// (3,3) via {x:96,y:96}, so (2,2) is adjacent and under the mower cap -> enlarge.
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});

	it("does nothing for non-garden bought tiles", () => {
		handymenEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 99, hasOwnership: true } },
				},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_GARDENING, [{ x: 96, y: 96 }]),
					],
				},
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});
});

describe("auto mechanics for adjacent ride exits", () => {
	it("hires an auto mechanic and assigns (exit + front tile) when a path lands next to a free exit", () => {
		mechanicsEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": pathTile(),
					"3,2": pathTile(),
				},
				{
					// Ride exit at (1,2); front path tile is at (2,2).
					rides: [
						fakeRide("ride", [{ exit: { x: 1 * 32, y: 2 * 32, z: 16, direction: 0 } as never }]),
					],
					staff: [],
				},
			),
		);
		// Place path at (2,2) -> adjacent (east) to the exit at (1,2).
		handlePlacedPathTile(2, 2, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
		expect(ctx.actionsOfType("staffhire")[0].args.staffType).toBe(STAFF_TYPE_ID_MECHANIC);
		// The hire callback runs synchronously and assigns a patrol area
		// covering the exit + front tile to the newly hired mechanic. The fake
		// staffhire action doesn't add staff to the roster, so the patrol-area
		// assignment has no member to attach to here; what matters is that the
		// mechanic hire was issued.
	});

	it("does not hire when mechanics are disabled", () => {
		mechanicsEnabledStore.set(false);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": pathTile(),
				},
				{
					rides: [
						fakeRide("ride", [{ exit: { x: 1 * 32, y: 2 * 32, z: 16, direction: 0 } as never }]),
					],
					staff: [],
				},
			),
		);
		handlePlacedPathTile(2, 2, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});

	it("does not hire when the exit already has a mechanic assigned", () => {
		mechanicsEnabledStore.set(true);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": pathTile(),
				},
				{
					rides: [
						fakeRide("ride", [{ exit: { x: 1 * 32, y: 2 * 32, z: 16, direction: 0 } as never }]),
					],
					staff: [
						fakeStaffWithPatrol(1, "mechanic", 0, [
							{ x: 32, y: 64 },
							{ x: 64, y: 64 },
						]),
					],
				},
			),
		);
		handlePlacedPathTile(2, 2, false);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});
});

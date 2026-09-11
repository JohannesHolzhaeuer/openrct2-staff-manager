import { FakeContext, fakeObjects } from "./fake-context";
import {
	HANDYMAN_ORDERS_CLEANUP,
	HANDYMAN_ORDERS_GARDENING,
	STAFF_TYPE_ID_ENTERTAINER,
	STAFF_TYPE_ID_SECURITY,
	adjustStaffCounts,
	assignStaff,
	canTeleportMechanic,
	countStaffedRideExitFronts,
	getStaffAreas,
	isExitAlreadyAssigned,
	refreshHiredAndAssignedStaffCounts,
	worldToTileX,
} from "../src/staff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	entertainersAssignedStore,
	entertainersEnabledStore,
	entertainersHiredStore,
	entertainersNeededStore,
	guardsAssignedStore,
	guardsEnabledStore,
	guardsHiredStore,
	guardsNeededStore,
	guardsTilesPerStaffStore,
	handymenAssignedStore,
	handymenCleanupNeededStore,
	handymenEnabledStore,
	handymenGardeningNeededStore,
	handymenHiredStore,
	handymenMowerTilesPerStaffStore,
	handymenTilesPerStaffStore,
	mechanicsAssignedStore,
	mechanicsEnabledStore,
	mechanicsHiredStore,
	mechanicsNeededStore,
	progressStore,
	statusTextStore,
} from "../src/store";
import { fakeMap, fakeRide, fakeStaff, fakeStaffWithPatrol } from "./fake-map";
import {
	resetGameContext,
	resetGameMap,
	resetGameObjects,
	setGameContext,
	setGameMap,
	setGameObjects,
} from "../src/game";
import { scanFootpathNetwork } from "../src/scan";

let ctx: FakeContext = new FakeContext();

const entranceElement = function entranceElement() {
	return { type: "entrance", sequence: 0 } as unknown as TileElement;
};

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
	setGameMap(fakeMap({ x: 16, y: 16 }));
	setGameObjects(
		fakeObjects([
			"rct2.peep_animations.handyman",
			"rct2.peep_animations.panda",
			"rct2.peep_animations.tiger",
		]),
	);
	// Defaults: everything enabled with sane "tiles per staff" values.
	handymenEnabledStore.set(true);
	guardsEnabledStore.set(true);
	entertainersEnabledStore.set(true);
	mechanicsEnabledStore.set(true);
	handymenTilesPerStaffStore.set(2);
	guardsTilesPerStaffStore.set(2);
	handymenMowerTilesPerStaffStore.set(2);
});

afterEach(() => {
	resetGameContext();
	resetGameMap();
	resetGameObjects();
});

describe("adjustStaffCounts", () => {
	it("refreshes counts and reports done when there is no work to do", () => {
		setGameMap(
			fakeMap({ x: 8, y: 8 }, {}, { staff: [fakeStaff(1, "handyman", HANDYMAN_ORDERS_CLEANUP)] }),
		);
		handymenCleanupNeededStore.set(1);
		handymenGardeningNeededStore.set(0);
		guardsNeededStore.set(0);
		entertainersNeededStore.set(0);
		mechanicsNeededStore.set(0);

		let completed = false;
		adjustStaffCounts(function onComplete() {
			completed = true;
		});

		expect(completed).toBe(true);
		expect(progressStore.get()).toBe(0.4);
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
		expect(ctx.actionsOfType("stafffire")).toHaveLength(0);
	});

	it("hires the number of missing handymen of the right purpose", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }));
		handymenCleanupNeededStore.set(2);
		handymenGardeningNeededStore.set(1);
		guardsNeededStore.set(0);
		entertainersNeededStore.set(0);
		mechanicsNeededStore.set(0);

		let completed = false;
		adjustStaffCounts(function onComplete() {
			completed = true;
		});
		ctx.runAllTimers();

		expect(completed).toBe(true);
		const hires = ctx.actionsOfType("staffhire");
		// 2 cleanup + 1 gardening.
		expect(hires).toHaveLength(3);
		expect(
			hires.filter((h) => (h.args.staffOrders as number) === HANDYMAN_ORDERS_CLEANUP),
		).toHaveLength(2);
		expect(
			hires.filter((h) => (h.args.staffOrders as number) === HANDYMAN_ORDERS_GARDENING),
		).toHaveLength(1);
	});

	it("fires the oldest staff first when overstaffed", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{},
				{
					staff: [
						fakeStaff(1, "handyman", HANDYMAN_ORDERS_CLEANUP),
						fakeStaff(2, "handyman", HANDYMAN_ORDERS_CLEANUP),
						fakeStaff(3, "handyman", HANDYMAN_ORDERS_CLEANUP),
					],
				},
			),
		);
		handymenCleanupNeededStore.set(1);
		handymenGardeningNeededStore.set(0);
		guardsNeededStore.set(0);
		entertainersNeededStore.set(0);
		mechanicsNeededStore.set(0);

		let completed = false;
		adjustStaffCounts(function onComplete() {
			completed = true;
		});
		ctx.runAllTimers();

		expect(completed).toBe(true);
		const fires = ctx.actionsOfType("stafffire");
		expect(fires).toHaveLength(2);
		// Oldest entities (lowest ids) fired first.
		expect(fires.map((f) => f.args.id)).toEqual([1, 2]);
	});

	it("combines hires and fires across all staff types", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{},
				{
					staff: [
						fakeStaff(1, "handyman", HANDYMAN_ORDERS_CLEANUP),
						fakeStaff(2, "mechanic"),
						fakeStaff(3, "mechanic"),
					],
				},
			),
		);
		handymenCleanupNeededStore.set(1);
		handymenGardeningNeededStore.set(0);
		guardsNeededStore.set(1);
		entertainersNeededStore.set(1);
		mechanicsNeededStore.set(1);

		let completed = false;
		adjustStaffCounts(function onComplete() {
			completed = true;
		});
		ctx.runAllTimers();

		expect(completed).toBe(true);
		const hires = ctx.actionsOfType("staffhire");
		const fires = ctx.actionsOfType("stafffire");
		// one security hire + one entertainer hire; one mechanic fired (oldest, id 2).
		expect(hires.map((h) => h.args.staffType)).toEqual([
			STAFF_TYPE_ID_SECURITY,
			STAFF_TYPE_ID_ENTERTAINER,
		]);
		expect(fires.map((f) => f.args.id)).toEqual([2]);
	});
});

describe("refreshHiredAndAssignedStaffCounts", () => {
	it("counts hired and assigned staff of each type", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman"),
						fakeStaffWithPatrol(2, "handyman", 0, [{ x: 32, y: 32 }]),
						fakeStaffWithPatrol(3, "security"),
						fakeStaffWithPatrol(4, "mechanic"),
						fakeStaffWithPatrol(5, "mechanic", 0, [{ x: 32, y: 32 }]),
						fakeStaffWithPatrol(6, "entertainer"),
					],
				},
			),
		);
		refreshHiredAndAssignedStaffCounts();
		expect(handymenHiredStore.get()).toBe(2);
		expect(handymenAssignedStore.get()).toBe(1);
		expect(guardsHiredStore.get()).toBe(1);
		expect(guardsAssignedStore.get()).toBe(0);
		expect(mechanicsHiredStore.get()).toBe(2);
		expect(mechanicsAssignedStore.get()).toBe(1);
		expect(entertainersHiredStore.get()).toBe(1);
		expect(entertainersAssignedStore.get()).toBe(0);
	});
});

describe("canTeleportMechanic", () => {
	it("returns true only when the mechanic stands on a footpath tile", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"0,0": { footpaths: [{ baseZ: 16 }] },
					"1,1": {},
				},
			),
		);
		expect(canTeleportMechanic({ ...fakeStaff(1, "mechanic"), x: 5, y: 5 })).toBe(true);
		expect(canTeleportMechanic({ ...fakeStaff(2, "mechanic"), x: 40, y: 40 })).toBe(false);
	});
});

describe("countStaffedRideExitFronts", () => {
	it("counts only ride exits that have a footpath in front", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					// exit at (2,2) facing east -> front is (2,3)
					"2,3": { footpaths: [{ baseZ: 16 }] },
					// exit at (5,5) facing north -> front is (4,5) with no path
					"4,5": {},
				},
				{
					rides: [
						fakeRide("ride", [
							{ exit: { x: 2 * 32, y: 2 * 32, z: 16, direction: 0 } as never },
							{ exit: { x: 5 * 32, y: 5 * 32, z: 16, direction: 2 } as never },
						]),
						fakeRide("shop", [{ exit: { x: 3 * 32, y: 3 * 32, z: 16, direction: 0 } as never }]),
						// invalid (out of bounds / null) exits are ignored
						fakeRide("ride", [
							{ exit: undefined },
							{ exit: { x: 9999, y: 9999, z: 0, direction: 0 } as never },
						]),
					],
				},
			),
		);
		// The exit facing north has no footpath in front -> not staffed.
		expect(countStaffedRideExitFronts()).toBe(1);
	});
});

describe("isExitAlreadyAssigned", () => {
	it("detects a mechanic already patrolling the exit tile", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{},
				{
					staff: [
						fakeStaffWithPatrol(1, "mechanic", 0, [
							{ x: 2 * 32, y: 2 * 32 },
							{ x: 2 * 32, y: 3 * 32 },
						]),
					],
				},
			),
		);
		expect(isExitAlreadyAssigned(2, 2)).toBe(true);
		expect(isExitAlreadyAssigned(9, 9)).toBe(false);
	});
});

describe("assignStaff (manual)", () => {
	it("runs the handymen/guards/entertainers/mechanics steps and finishes", () => {
		// A small park with an entrance and a path network, so the scanned
		// cache is populated before Assign is pressed.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": {
						surface: { baseHeight: 0, ownership: 1, hasOwnership: true },
						customElements: [entranceElement()],
					},
					"1,2": {
						surface: { baseHeight: 0, surfaceStyle: 99, ownership: 1, hasOwnership: true },
						footpaths: [{ baseZ: 16 }],
					},
					"1,3": {
						surface: { baseHeight: 0, surfaceStyle: 99, ownership: 1, hasOwnership: true },
						footpaths: [{ baseZ: 16 }],
					},
				},
				{
					staff: [
						fakeStaff(1, "handyman", HANDYMAN_ORDERS_CLEANUP),
						fakeStaff(2, "handyman", HANDYMAN_ORDERS_GARDENING),
						fakeStaff(3, "security"),
						fakeStaff(4, "entertainer"),
						fakeStaff(5, "mechanic"),
					],
				},
			),
		);
		scanFootpathNetwork();
		ctx.runAllTimers();

		assignStaff();
		ctx.runAllTimers();

		expect(progressStore.get()).toBe(1);
		expect(statusTextStore.get().toLowerCase()).toContain("done");
		// Teleports are issued via the teleport queue (peeppickup actions).
		expect(ctx.actionsOfType("peeppickup").length).toBeGreaterThan(0);
	});
});

describe("getStaffAreas", () => {
	it("returns one patrol-area tile array per staff member of the type", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{},
				{
					staff: [
						fakeStaffWithPatrol(1, "security", 0, [
							{ x: 0, y: 0 },
							{ x: 32, y: 0 },
						]),
						fakeStaffWithPatrol(2, "security"),
					],
				},
			),
		);
		const areas = getStaffAreas("security");
		expect(areas).toHaveLength(2);
		expect(areas[0]).toEqual([
			{ x: 0, y: 0 },
			{ x: 32, y: 0 },
		]);
		expect(areas[1]).toEqual([]);
	});
});

describe("worldToTileX", () => {
	it("floor-divides world coordinate by 32", () => {
		expect(worldToTileX(0)).toBe(0);
		expect(worldToTileX(31)).toBe(0);
		expect(worldToTileX(32)).toBe(1);
		expect(worldToTileX(95)).toBe(2);
	});
});

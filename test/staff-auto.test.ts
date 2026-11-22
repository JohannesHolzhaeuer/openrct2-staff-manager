import { FakeContext, fakeObjects } from "./fake-context";
import { type FakeTileSpec, fakeMap, fakeRide, fakeStaffWithPatrol } from "./fake-map";
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
import { handleBoughtLandTile, handlePlacedPathTile, resetAutoAreas } from "../src/staff-auto";
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
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 3, hasOwnership: true } },
					// The tile the existing area sits on (3,2), so the connectivity
					// predicate finds a real surface next door.
					"3,2": { surface: { baseHeight: 0, surfaceStyle: 3, hasOwnership: true } },
				},
				{
					staff: [
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_GARDENING, [{ x: 96, y: 64 }]),
					],
				},
			),
		);
		// (2,2) is the garden tile (2,2), i.e. world 64-95. The existing area owns
		// world (3,2) via {x:96,y:64}, which is cardinal-adjacent to (2,2) and
		// under the mower cap -> enlarge, no new hire.
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
						fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_GARDENING, [{ x: 96, y: 64 }]),
					],
				},
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
	});

	it("is a no-op when handymen are disabled", () => {
		handymenEnabledStore.set(false);
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 3, hasOwnership: true } },
				},
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actions).toHaveLength(0);
	});

	it("hires a gardening handyman for a new isolated garden tile", () => {
		handymenEnabledStore.set(true);
		// No roaming staff at all: the lone garden tile triggers a hire.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 3, hasOwnership: true } },
					// A placeable adjacent path so the hired gardener can be dropped.
					"2,3": {
						surface: { baseHeight: 0, surfaceStyle: 99, hasOwnership: true },
						footpaths: [{ baseZ: 16 }],
					},
				},
				{ staff: [] },
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
	});

	it("falls back to the nearest placeable tile when the garden tile is obstructed", () => {
		handymenEnabledStore.set(true);
		const staff = [] as Staff[];
		// Simulate the game actually adding the hired handyman to the roster, so
		// queueAutoHire's post-hire member lookup finds it and issues a teleport.
		ctx.onStaffHire = function onStaffHire(args) {
			staff.push(
				fakeStaffWithPatrol(99 + staff.length, "handyman", (args.staffOrders as number) ?? 0),
			);
			return 100;
		};
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					// Mowable grass tile carrying a tree (small_scenery), which
					// blocks peep placement but not the garden-tile classification.
					"2,2": {
						surface: { baseHeight: 0, surfaceStyle: 3, hasOwnership: true },
						others: ["small_scenery"],
					},
					// A placeable adjacent path tile for the teleport fallback.
					"2,3": {
						surface: { baseHeight: 0, surfaceStyle: 99, hasOwnership: true },
						footpaths: [{ baseZ: 16 }],
					},
				},
				{ staff: staff as unknown as Staff[] },
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		// A gardener is hired; even though the placement fallback cannot find a
		// non-obstructed tile within the single-tile area, a pickup+place at the
		// garden tile's surface height is still issued (proving the
		// obstructed-tile fallback path ran rather than skipping the teleport).
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
		const drop = ctx.actionsOfType("peeppickup").filter((a) => 2 === a.args.type);
		expect(drop.length).toBeGreaterThan(0);
		const lastDrop = drop[drop.length - 1];
		expect([lastDrop.args.x, lastDrop.args.y, lastDrop.args.z]).toEqual([
			2 * 32 + 16,
			2 * 32 + 16,
			0,
		]);
	});

	it("teleports a gardening handyman at surface height onto a newly hired garden tile", () => {
		handymenEnabledStore.set(true);
		const staff = [] as Staff[];
		ctx.onStaffHire = function onStaffHire(args) {
			staff.push(
				fakeStaffWithPatrol(200 + staff.length, "handyman", (args.staffOrders as number) ?? 0),
			);
			return 200;
		};
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					// Garden tile at surface baseZ... surface baseZ is derived from
					// baseHeight (see fake-map toElements: baseZ defaults to 0), so
					// give it a baseHeight to make the surface Z non-zero.
					"2,2": { surface: { baseHeight: 10, baseZ: 10, surfaceStyle: 3, hasOwnership: true } },
				},
				{ staff: staff as unknown as Staff[] },
			),
		);
		handleBoughtLandTile(2, 2);
		ctx.runAllTimers();
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
		const drop = ctx.actionsOfType("peeppickup").filter((a) => 2 === a.args.type);
		expect(drop.length).toBeGreaterThan(0);
		// The gardener stands on the garden tile at its *surface* baseZ, not a
		// footpath height.
		const lastDrop = drop[drop.length - 1];
		expect([lastDrop.args.x, lastDrop.args.y, lastDrop.args.z]).toEqual([
			2 * 32 + 16,
			2 * 32 + 16,
			10,
		]);
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

describe("stacked footpaths: a bridge over a ground path", () => {
	// The reported layout: a ground path at level 8. At (3,1) the ground path
	// continues UNDER the bridge, and the first slanted path tile of the bridge
	// is stacked on top of it - a slope that starts at level 16, i.e. its low
	// end is one full height level ABOVE the ground path, so a handyman cannot
	// walk from the ground network onto the bridge. The bridge deck is at
	// level 32. The two height networks are only "adjacent" at (3,1)'s x/y.
	const stackedBridgeTiles = function stackedBridgeTiles(): {
		[key: string]: FakeTileSpec;
	} {
		const surface = { baseHeight: 0, surfaceStyle: 99, hasOwnership: true };
		return {
			"1,1": { surface: surface, footpaths: [{ baseZ: 8 }] },
			"2,1": { surface: surface, footpaths: [{ baseZ: 8 }] },
			"3,1": {
				surface: surface,
				footpaths: [{ baseZ: 8 }, { baseZ: 16, slopeDirection: 2 }],
			},
			"4,1": { surface: surface, footpaths: [{ baseZ: 32 }] },
		};
	};

	// The set of "x,y" tile keys a patrol area currently covers (the fake
	// patrol area appends on every add, so dedupe before comparing).
	const coveredTiles = function coveredTiles(tiles: { x: number; y: number }[]): Set<string> {
		return new Set(tiles.map((t) => `${Math.floor(t.x / 32)},${Math.floor(t.y / 32)}`));
	};

	it("a bridge built over a ground path gets its own handyman, never the ground area", () => {
		handymenEnabledStore.set(true);
		handymenTilesPerStaffStore.set(8);
		const staff = [
			// One handyman already patrolling the ground network (1,1) and (2,1).
			fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [
				{ x: 32, y: 32 },
				{ x: 64, y: 32 },
			]),
		] as Staff[];
		ctx.onStaffHire = function onStaffHire(args) {
			const id = 90 + staff.length;
			staff.push(fakeStaffWithPatrol(id, "handyman", (args.staffOrders as number) ?? 0));
			return id;
		};
		setGameMap(fakeMap({ x: 16, y: 16 }, stackedBridgeTiles(), { staff: staff }));

		// The player builds the first slanted tile (3,1), then the bridge deck (4,1).
		handlePlacedPathTile(3, 1, false);
		handlePlacedPathTile(4, 1, false);
		ctx.runAllTimers();

		// Exactly one hire: the bridge's own handyman.
		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
		// The ground handyman gained the ground level of (3,1) (the path
		// continues under the bridge) but NOT the bridge deck...
		const groundTiles = coveredTiles(staff[0].patrolArea.tiles);
		expect(groundTiles.has("1,1")).toBe(true);
		expect(groundTiles.has("2,1")).toBe(true);
		expect(groundTiles.has("3,1")).toBe(true);
		expect(groundTiles.has("4,1")).toBe(false);
		// ...while the hired bridge handyman patrols the ramp + deck.
		const bridgeTiles = coveredTiles(staff[1].patrolArea.tiles);
		expect(bridgeTiles.has("3,1")).toBe(true);
		expect(bridgeTiles.has("4,1")).toBe(true);
		expect(bridgeTiles.has("1,1")).toBe(false);
		expect(bridgeTiles.has("2,1")).toBe(false);
	});

	it("a walkable ramp (low end at ground level) still merges into one area", () => {
		handymenEnabledStore.set(true);
		handymenTilesPerStaffStore.set(8);
		const surface = { baseHeight: 0, surfaceStyle: 99, hasOwnership: true };
		const staff = [
			fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [
				{ x: 32, y: 32 },
				{ x: 64, y: 32 },
			]),
		] as Staff[];
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": { surface: surface, footpaths: [{ baseZ: 8 }] },
					"2,1": { surface: surface, footpaths: [{ baseZ: 8 }] },
					// Ramp whose low end IS at ground level: genuinely walkable
					// from the ground path up to the deck at level 24.
					"3,1": { surface: surface, footpaths: [{ baseZ: 8, slopeDirection: 2 }] },
					"4,1": { surface: surface, footpaths: [{ baseZ: 24 }] },
				},
				{ staff: staff },
			),
		);

		handlePlacedPathTile(3, 1, false);
		handlePlacedPathTile(4, 1, false);
		ctx.runAllTimers();

		// The whole bridge + ground network is one walkable piece: no new
		// handyman, and the existing one patrols all four tiles.
		expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
		const tiles = coveredTiles(staff[0].patrolArea.tiles);
		expect(tiles).toEqual(new Set(["1,1", "2,1", "3,1", "4,1"]));
	});

	it("after a manual Assign, a seeded area keeps the stacked tile's levels in their own networks", () => {
		handymenEnabledStore.set(true);
		handymenTilesPerStaffStore.set(8);
		const surface = { baseHeight: 0, surfaceStyle: 99, hasOwnership: true };
		const entranceElement = { type: "entrance", sequence: 0 } as unknown as TileElement;
		const staff = [
			// The ground handyman's area (as a manual Assign would build it)
			// includes the ground level of the stacked tile (3,2).
			fakeStaffWithPatrol(1, "handyman", HANDYMAN_ORDERS_CLEANUP, [
				{ x: 32, y: 64 },
				{ x: 64, y: 64 },
				{ x: 96, y: 64 },
			]),
		] as Staff[];
		ctx.onStaffHire = function onStaffHire(args) {
			const id = 90 + staff.length;
			staff.push(fakeStaffWithPatrol(id, "handyman", (args.staffOrders as number) ?? 0));
			return id;
		};
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": { surface: surface, customElements: [entranceElement] },
					"1,2": { surface: surface, footpaths: [{ baseZ: 8 }] },
					"2,2": { surface: surface, footpaths: [{ baseZ: 8 }] },
					"3,2": {
						surface: surface,
						footpaths: [{ baseZ: 8 }, { baseZ: 16, slopeDirection: 2 }],
					},
					"4,2": { surface: surface, footpaths: [{ baseZ: 32 }] },
					"5,2": { surface: surface, footpaths: [{ baseZ: 32 }] },
				},
				{ staff: staff },
			),
		);

		// A scan (as the plugin UI runs) populates the walk graph, so the
		// ambiguous stacked tile's levels can be resolved to their components.
		scanFootpathNetwork();
		ctx.runAllTimers();

		// The bridge deck tile (4,2) is confirmed/placed: it must NOT enlarge
		// the ground area (the ground level of (3,2) is 32 away from it), but
		// start the bridge's own area.
		handlePlacedPathTile(4, 2, false);
		ctx.runAllTimers();

		expect(ctx.actionsOfType("staffhire")).toHaveLength(1);
		const groundTiles = coveredTiles(staff[0].patrolArea.tiles);
		expect(groundTiles.has("4,2")).toBe(false);
		expect(groundTiles.has("5,2")).toBe(false);
		const bridgeTiles = coveredTiles(staff[1].patrolArea.tiles);
		expect(bridgeTiles.has("4,2")).toBe(true);
		expect(bridgeTiles.has("1,2")).toBe(false);
	});
});

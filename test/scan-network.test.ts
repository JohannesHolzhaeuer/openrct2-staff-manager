import { FakeContext, fakeObjects } from "./fake-context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMap, fakeRide } from "./fake-map";
import {
	findAndReportParkEntrance,
	findParkEntranceTiles,
	invalidateGrassSurfaceStyleCache,
	isGardenTile,
	isPlainPathTile,
	isQueueTile,
	scanFootpathNetwork,
	surfaceBaseZAt,
	tileKey,
	worldToTile,
} from "../src/scan";
import {
	gardenAreaSizesStore,
	gardenTilesCountStore,
	ownedTilesCountStore,
	parkEntranceInfoStore,
	pathTilesCountStore,
	queueTilesCountStore,
	tilesCalculatedStore,
} from "../src/store";
import {
	resetGameContext,
	resetGameMap,
	resetGameObjects,
	setGameContext,
	setGameMap,
	setGameObjects,
} from "../src/game";

let ctx: FakeContext = new FakeContext();

// A minimal "entrance" tile element with sequence 0, as a plain TileElement.
const entranceElement = function entranceElement() {
	return { type: "entrance", sequence: 0 } as unknown as TileElement;
};

// A minimal ride-exit element with a non-zero sequence (like a real exit).
const exitElement = function exitElement() {
	return { type: "entrance", sequence: 1 } as unknown as TileElement;
};

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
	setGameMap(fakeMap({ x: 16, y: 16 }));
	invalidateGrassSurfaceStyleCache();
	setGameObjects(fakeObjects(["grass", "grass_clumps", "dirt"]));
	// Reset stores that a scan publishes to, so tests are independent.
	pathTilesCountStore.set(0);
	queueTilesCountStore.set(0);
	gardenTilesCountStore.set(0);
	ownedTilesCountStore.set(0);
	tilesCalculatedStore.set(false);
	parkEntranceInfoStore.set("");
});

afterEach(() => {
	resetGameContext();
	resetGameMap();
	resetGameObjects();
});

describe("findParkEntranceTiles", () => {
	it("returns the middle tile of the park entrance (sequence 0)", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"5,5": { surface: { baseHeight: 0 }, customElements: [entranceElement()] },
				},
			),
		);
		expect(findParkEntranceTiles()).toEqual([{ x: 5, y: 5 }]);
	});

	it("returns multiple entrances when several exist", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"5,5": { surface: { baseHeight: 0 }, customElements: [entranceElement()] },
					"8,8": { surface: { baseHeight: 0 }, customElements: [entranceElement()] },
				},
			),
		);
		expect(findParkEntranceTiles().length).toBe(2);
	});

	it("excludes ride entrance/exit tiles from being the park entrance", () => {
		// A park entrance at (5,5), plus a separate ride exit element at (6,6)
		// whose tile is in the ride's exit set -> must not be reported.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"5,5": { surface: { baseHeight: 0 }, customElements: [entranceElement()] },
					"6,6": { surface: { baseHeight: 0 }, customElements: [exitElement()] },
				},
				{
					rides: [
						fakeRide("ride", [{ exit: { x: 6 * 32, y: 6 * 32, z: 0, direction: 2 } as never }]),
					],
				},
			),
		);
		expect(findParkEntranceTiles()).toEqual([{ x: 5, y: 5 }]);
	});

	it("reports no entrance when the map has none", () => {
		expect(findParkEntranceTiles()).toEqual([]);
	});
});

describe("findAndReportParkEntrance", () => {
	it("sets the not-found message when there is no park entrance", () => {
		findAndReportParkEntrance();
		expect(parkEntranceInfoStore.get()).not.toBe("");
	});

	it("leaves the info row empty when an entrance is found", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"5,5": { surface: { baseHeight: 0 }, customElements: [entranceElement()] },
				},
			),
		);
		findAndReportParkEntrance();
		expect(parkEntranceInfoStore.get()).toBe("");
	});
});

describe("scanFootpathNetwork (end-to-end)", () => {
	it("counts paths, queues, owned and garden tiles, then publishes to the stores", () => {
		// Entrance at (1,1); owned path network, a queue branch, an unowned
		// public path (walked through but not counted) and a garden tile.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": {
						surface: { baseHeight: 0, surfaceStyle: 99, ownership: 1, hasOwnership: true },
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
					"2,3": {
						surface: { baseHeight: 0, surfaceStyle: 99, ownership: 1, hasOwnership: true },
						footpaths: [{ baseZ: 16, isQueue: true }],
					},
					"2,2": { surface: { baseHeight: 0, surfaceStyle: 99 }, footpaths: [{ baseZ: 16 }] },
					"3,3": { surface: { baseHeight: 0, surfaceStyle: 0, ownership: 1, hasOwnership: true } },
				},
			),
		);
		setGameObjects(fakeObjects(["grass"]));

		scanFootpathNetwork();
		ctx.runAllTimers();

		expect(tilesCalculatedStore.get()).toBe(true);
		expect(pathTilesCountStore.get()).toBe(2);
		expect(queueTilesCountStore.get()).toBe(1);
		// Garden: (3,3) is mowable grass (surfaceStyle 0 = grass index).
		expect(gardenTilesCountStore.get()).toBe(1);
		// Owned: (1,1),(1,2),(1,3),(2,3),(3,3) = 5.
		expect(ownedTilesCountStore.get()).toBe(5);
	});

	it("calls onComplete synchronously and leaves tilesCalculated false when no entrance", () => {
		let completed = false;
		scanFootpathNetwork(function onScanComplete() {
			completed = true;
		});
		expect(completed).toBe(true);
		expect(tilesCalculatedStore.get()).toBe(false);
	});
});

describe("isGardenTile / waterable scenery", () => {
	it("classifies a tile with waterable small scenery as a garden tile", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"2,2": {
						surface: { baseHeight: 0, ownership: 1, hasOwnership: true },
						smallScenery: [{ object: 1 }],
					},
				},
			),
		);
		setGameObjects(
			fakeObjects(["grass"], {
				smallSceneryFlags: { 1: 1 << 5 },
			}),
		);
		expect(isGardenTile(2, 2)).toBe(true);
	});

	it("does not classify a non-waterable scenery tile as a garden tile", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"2,2": {
						// Non-grass surface (style 99) so mowing can't make it a garden tile.
						surface: { baseHeight: 0, surfaceStyle: 99, ownership: 1, hasOwnership: true },
						smallScenery: [{ object: 1 }],
					},
				},
			),
		);
		setGameObjects(fakeObjects(["grass"])); // flags 0 -> not waterable
		expect(isGardenTile(2, 2)).toBe(false);
	});
});

describe("per-tile classification helpers", () => {
	it("isPlainPathTile / isQueueTile distinguish path from queue", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 16 }] },
					"2,1": { footpaths: [{ baseZ: 16, isQueue: true }] },
				},
			),
		);
		expect(isPlainPathTile(1, 1)).toBe(true);
		expect(isQueueTile(1, 1)).toBe(false);
		expect(isPlainPathTile(2, 1)).toBe(false);
		expect(isQueueTile(2, 1)).toBe(true);
	});
});

describe("surfaceBaseZAt", () => {
	it("returns the surface baseZ or 0 when there's no surface", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20, baseZ: 20 } },
				},
			),
		);
		expect(surfaceBaseZAt(1, 1)).toBe(20);
		expect(surfaceBaseZAt(5, 5)).toBe(0);
	});
});

describe("worldToTile", () => {
	it("maps world coordinates to tile coordinates by flooring /32", () => {
		expect(worldToTile(0, 0)).toEqual({ x: 0, y: 0 });
		expect(worldToTile(31, 31)).toEqual({ x: 0, y: 0 });
		expect(worldToTile(32, 64)).toEqual({ x: 1, y: 2 });
		expect(worldToTile(70, 10)).toEqual({ x: 2, y: 0 });
	});
});

describe("constants", () => {
	it("tileKey formats as x,y", () => {
		expect(tileKey(3, 4)).toBe("3,4");
	});
});

const ownedGrassTile = function ownedGrassTile(_x: number, _y: number, parkFences = 0) {
	return {
		surface: { baseHeight: 0, surfaceStyle: 0, hasOwnership: true, parkFences: parkFences },
	};
};

const entranceTileSpec = function entrance() {
	return {
		surface: { baseHeight: 0, surfaceStyle: 99, hasOwnership: true },
		customElements: [entranceElement()],
	};
};

const pathTileSpec = function path(baseZ = 16, owned = true, slopeDirection?: number | null) {
	return {
		surface: {
			baseHeight: 0,
			surfaceStyle: 99,
			...(owned ? { hasOwnership: true } : {}),
		},
		footpaths: [{ baseZ: baseZ, slopeDirection: slopeDirection }],
	};
};

describe("scanFootpathNetwork walk behaviours", () => {
	it("walks through an unowned path to reach owned tiles beyond it", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": entranceTileSpec(),
					"1,2": pathTileSpec(), // owned
					"1,3": pathTileSpec(16, false), // unowned public road - walked through
					"1,4": pathTileSpec(), // owned, beyond the road
				},
			),
		);
		scanFootpathNetwork();
		ctx.runAllTimers();
		// Both owned path tiles are counted even though the unowned road sits between them.
		expect(pathTilesCountStore.get()).toBe(2);
	});

	it("does not spread across unowned land/water without a path", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": entranceTileSpec(),
					"1,2": pathTileSpec(), // owned
					// unowned non-path land is a dead end - nothing beyond is reached.
					"1,3": { surface: { baseHeight: 0 } },
					"1,4": { surface: { baseHeight: 0 }, footpaths: [{ baseZ: 16 }] },
				},
			),
		);
		scanFootpathNetwork();
		ctx.runAllTimers();
		// Only the owned path at (1,2) counts; (1,4) is never reached.
		expect(pathTilesCountStore.get()).toBe(1);
	});

	it("treats an elevated (bridge) path over unowned land as part of the network", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": entranceTileSpec(),
					"2,1": pathTileSpec(), // owned ground path heading east
					"3,1": pathTileSpec(16, true, 2), // ramp rising toward +X (east)
					// Elevated landing over unowned land (baseZ 32 >= surface 0 + 32).
					"4,1": {
						surface: { baseHeight: 0, surfaceStyle: 99 },
						footpaths: [{ baseZ: 32 }],
					},
				},
			),
		);
		scanFootpathNetwork();
		ctx.runAllTimers();
		// (2,1) owned, (3,1) owned ramp, (4,1) elevated bridge -> all three count.
		expect(pathTilesCountStore.get()).toBe(3);
	});
});

describe("gardening grouping", () => {
	it("keeps two garden areas split by a park fence in separate components", () => {
		// Two grass patches on either side of a fenced edge. (3,2) carries an
		// east fence (bit 0x2) and (4,2) carries the matching west fence
		// (bit 0x8), so walking between them is blocked and they must be
		// grouped as separate components rather than merged into one area.
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{
					"1,1": entranceTileSpec(),
					"1,2": pathTileSpec(),
					"2,2": ownedGrassTile(2, 2),
					"3,2": ownedGrassTile(3, 2, 0x2),
					"4,2": ownedGrassTile(4, 2, 0x8),
					"5,2": ownedGrassTile(5, 2),
				},
			),
		);
		setGameObjects(fakeObjects(["grass", "grass_clumps", "dirt"]));
		scanFootpathNetwork();
		ctx.runAllTimers();
		// Left patch = (2,2),(3,2); right patch = (4,2),(5,2): two components.
		expect(gardenAreaSizesStore.get().toSorted()).toEqual([2, 2]);
	});
});

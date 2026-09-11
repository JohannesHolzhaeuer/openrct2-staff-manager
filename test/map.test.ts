import { afterEach, describe, expect, it } from "vitest";
import {
	countRideExits,
	footpathsConnectTiles,
	isValidStationExit,
	surfaceFenceBlocksWalking,
	surfaceTilesConnect,
} from "../src/scan";
import { fakeMap, fakeRide } from "./fake-map";
import { resetGameMap, setGameMap } from "../src/game";

afterEach(() => {
	resetGameMap();
});

describe("footpathsConnectTiles", () => {
	it("connects two flat neighbouring paths at the same height", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		expect(footpathsConnectTiles({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(true);
	});

	it("does not connect a bridge path to the path passing underneath", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 148 }] },
				},
			),
		);
		expect(footpathsConnectTiles({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(false);
	});

	it("picks the matching path when a tile carries several at different heights", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 148 }, { baseZ: 100 }] },
				},
			),
		);
		expect(footpathsConnectTiles({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(true);
	});

	it("rejects diagonal and identical tiles", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,2": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		expect(footpathsConnectTiles({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(false);
		expect(footpathsConnectTiles({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(false);
	});

	it("treats out-of-bounds tiles as having no paths", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"0,0": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		expect(footpathsConnectTiles({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(false);
	});
});

describe("surfaceTilesConnect", () => {
	it("connects neighbouring land at the same height", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
					"1,2": { surface: { baseHeight: 20 } },
				},
			),
		);
		expect(surfaceTilesConnect({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(true);
	});

	it("does not connect across an unclimbable step", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
					"1,2": { surface: { baseHeight: 26 } },
				},
			),
		);
		expect(surfaceTilesConnect({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(false);
	});

	it("does not connect to a submerged tile", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
					"1,2": { surface: { baseHeight: 20, waterHeight: 24 } },
				},
			),
		);
		expect(surfaceTilesConnect({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(false);
	});

	it("does not connect when a tile has no surface at all", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
				},
			),
		);
		expect(surfaceTilesConnect({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(false);
	});
});

describe("surfaceFenceBlocksWalking", () => {
	it("reports no blocking when neither tile is fenced", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
					"1,0": { surface: { baseHeight: 20 } },
				},
			),
		);
		expect(surfaceFenceBlocksWalking({ x: 1, y: 1 }, { x: 1, y: 0 })).toBe(false);
	});

	it("blocks when the source tile is fenced on the shared edge", () => {
		// direction 0 is north (0,-1) and uses fence bit 0x4.
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20, parkFences: 0x4 } },
					"1,0": { surface: { baseHeight: 20 } },
				},
			),
		);
		expect(surfaceFenceBlocksWalking({ x: 1, y: 1 }, { x: 1, y: 0 })).toBe(true);
	});

	it("blocks when only the destination tile is fenced on the shared edge", () => {
		// The opposite of north is south (index 2), which uses fence bit 0x1.
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20 } },
					"1,0": { surface: { baseHeight: 20, parkFences: 0x1 } },
				},
			),
		);
		expect(surfaceFenceBlocksWalking({ x: 1, y: 1 }, { x: 1, y: 0 })).toBe(true);
	});

	it("ignores fences on unrelated edges", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20, parkFences: 0x8 } },
					"1,0": { surface: { baseHeight: 20, parkFences: 0x8 } },
				},
			),
		);
		expect(surfaceFenceBlocksWalking({ x: 1, y: 1 }, { x: 1, y: 0 })).toBe(false);
	});

	it("reports no blocking for non-cardinal neighbours", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { surface: { baseHeight: 20, parkFences: 15 } },
					"2,2": { surface: { baseHeight: 20, parkFences: 15 } },
				},
			),
		);
		expect(surfaceFenceBlocksWalking({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(false);
	});
});

describe("isValidStationExit", () => {
	it("accepts an exit inside the injected map bounds", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }));
		expect(isValidStationExit({ x: 64, y: 64, z: 0, direction: 0 })).toBe(true);
	});

	it("rejects an unused station slot pointing outside the map", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }));
		expect(isValidStationExit({ x: 32_000, y: 32_000, z: 0, direction: 0 })).toBe(false);
	});
});

describe("countRideExits", () => {
	it("counts only actual rides with valid, in-map exits", () => {
		setGameMap(
			fakeMap(
				{ x: 16, y: 16 },
				{},
				{
					rides: [
						fakeRide("ride", [{ exit: { x: 2 * 32, y: 2 * 32, z: 0, direction: 0 } as never }]),
						fakeRide("ride", [{ exit: undefined }]),
						// Shops don't need mechanics.
						fakeRide("shop", [{ exit: { x: 5 * 32, y: 5 * 32, z: 0, direction: 0 } as never }]),
					],
				},
			),
		);
		expect(countRideExits()).toBe(1);
	});
});

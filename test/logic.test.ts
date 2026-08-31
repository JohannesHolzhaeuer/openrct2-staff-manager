import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computeNeeded } from "../src/store";
import { tileKey, isValidStationExit, footpathIsElevated, ELEVATED_FOOTPATH_LEVELS } from "../src/scan";
import { classifyHandyman, HANDYMAN_ORDERS_CLEANUP, HANDYMAN_ORDERS_GARDENING, STAFF_TYPE_ID_ENTERTAINER } from "../src/staff";

// Stub the OpenRCT2 global `map` object so functions that read map.size work.
const testGlobal = globalThis as unknown as { map?: { size: CoordsXY } };
const origMap = testGlobal.map;
beforeAll(() => {
	testGlobal.map = { size: { x: 256, y: 256 } };
});
afterAll(() => {
	if (origMap === undefined) {
		delete testGlobal.map;
	} else {
		testGlobal.map = origMap;
	}
});

describe("computeNeeded", () => {
	it("returns ceil of totalTiles / tilesPerStaff", () => {
		expect(computeNeeded(8, 8)).toBe(1);
		expect(computeNeeded(9, 8)).toBe(2);
		expect(computeNeeded(0, 8)).toBe(0);
		expect(computeNeeded(100, 0)).toBe(0);
		expect(computeNeeded(-5, 8)).toBe(0);
	});
});

describe("tileKey", () => {
	it("formats coordinates as x,y", () => {
		expect(tileKey(3, 7)).toBe("3,7");
		expect(tileKey(-1, 0)).toBe("-1,0");
	});
});

describe("footpathIsElevated", () => {
	it("returns false for a footpath at ground level", () => {
		expect(footpathIsElevated(0, 0)).toBe(false);
	});
	it("returns false for a footpath just above the ground", () => {
		// one height level (16 Z) above still counts as ground-level path.
		expect(footpathIsElevated(100 + 16 - 1, 100)).toBe(false);
	});
	it("returns true when the footpath clears ELEVATED_FOOTPATH_LEVELS height levels (bridge)", () => {
		expect(footpathIsElevated(100 + ELEVATED_FOOTPATH_LEVELS * 16, 100)).toBe(true);
		expect(footpathIsElevated(200, 100)).toBe(true);
	});
});

describe("isValidStationExit", () => {
	it("rejects null/undefined", () => {
		expect(isValidStationExit(null)).toBe(false);
		expect(isValidStationExit(undefined)).toBe(false);
	});
	it("rejects out-of-map coordinates", () => {
		expect(isValidStationExit({ x: -32, y: 0, z: 0, direction: 0 })).toBe(false);
		expect(isValidStationExit({ x: 256 * 32, y: 0, z: 0, direction: 0 })).toBe(false);
	});
	it("accepts in-map coordinates", () => {
		expect(isValidStationExit({ x: 0, y: 0, z: 0, direction: 0 })).toBe(true);
		expect(isValidStationExit({ x: (256 - 1) * 32, y: (256 - 1) * 32, z: 0, direction: 0 })).toBe(true);
	});
});

describe("classifyHandyman", () => {
	it("cleanup when orders are sweeping+empty bins only", () => {
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_CLEANUP } as Handyman)).toBe("cleanup");
	});
	it("gardening when orders include watering/mowing", () => {
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_GARDENING } as Handyman)).toBe("gardening");
	});
	it("no orders defaults to cleanup", () => {
		expect(classifyHandyman({ orders: 0 } as Handyman)).toBe("cleanup");
	});
	it("mixed orders incl. gardening => gardening", () => {
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_CLEANUP | 8 } as Handyman)).toBe("gardening");
	});
	it("STAFF_TYPE_ID_ENTERTAINER constant present", () => {
		expect(STAFF_TYPE_ID_ENTERTAINER).toBe(3);
	});
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computeNeeded } from "../src/store";
import { tileKey, isValidStationExit } from "../src/scan";
import { classifyHandyman, HANDYMAN_ORDERS_CLEANUP, HANDYMAN_ORDERS_GARDENING, STAFF_TYPE_ID_ENTERTAINER } from "../src/staff";

// Stub the OpenRCT2 global `map` object so functions that read map.size work.
const origMap = (globalThis as any).map;
beforeAll(() => {
	(globalThis as any).map = { size: { x: 256, y: 256 } };
});
afterAll(() => {
	if (origMap === undefined) {
		delete (globalThis as any).map;
	} else {
		(globalThis as any).map = origMap;
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
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_CLEANUP } as any)).toBe("cleanup");
	});
	it("gardening when orders include watering/mowing", () => {
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_GARDENING } as any)).toBe("gardening");
	});
	it("no orders defaults to cleanup", () => {
		expect(classifyHandyman({ orders: 0 } as any)).toBe("cleanup");
	});
	it("mixed orders incl. gardening => gardening", () => {
		expect(classifyHandyman({ orders: HANDYMAN_ORDERS_CLEANUP | 8 } as any)).toBe("gardening");
	});
	it("STAFF_TYPE_ID_ENTERTAINER constant present", () => {
		expect(STAFF_TYPE_ID_ENTERTAINER).toBe(3);
	});
});

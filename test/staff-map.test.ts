import { describe, it, expect, afterEach } from "vitest";
import { setGameMap, resetGameMap } from "../src/game";
import { fakeMap, fakeStaff } from "./fake-map";
import {
    getStaffByType, getHandymenByPurpose, isPeepPlaceableTile, findNearestPathInOrderedTiles,
    HANDYMAN_ORDERS_CLEANUP, HANDYMAN_ORDERS_GARDENING
} from "../src/staff";
import type { PathTileInfo } from "../src/scan";

afterEach(() => {
    resetGameMap();
});

function pathTile(x: number, y: number): PathTileInfo {
    return { x: x, y: y, baseHeight: 20, baseZ: 160, isQueue: false, neighbourKeys: [] };
}

describe("getStaffByType", () => {
    it("returns only the staff of the requested type", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {}, [], [
            fakeStaff(1, "handyman"),
            fakeStaff(2, "mechanic"),
            fakeStaff(3, "security"),
            fakeStaff(4, "mechanic")
        ]));
        expect(getStaffByType("mechanic").map(s => s.id)).toEqual([2, 4]);
        expect(getStaffByType("entertainer")).toEqual([]);
    });
});

describe("getHandymenByPurpose", () => {
    it("splits handymen by their orders bitmask", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {}, [], [
            fakeStaff(1, "handyman", HANDYMAN_ORDERS_CLEANUP),
            fakeStaff(2, "handyman", HANDYMAN_ORDERS_GARDENING),
            fakeStaff(3, "handyman", 0),
            fakeStaff(4, "mechanic", HANDYMAN_ORDERS_GARDENING)
        ]));
        // No orders at all counts as cleanup; the mechanic is never included.
        expect(getHandymenByPurpose("cleanup").map(s => s.id)).toEqual([1, 3]);
        expect(getHandymenByPurpose("gardening").map(s => s.id)).toEqual([2]);
    });
});

describe("isPeepPlaceableTile", () => {
    it("accepts a plain footpath tile", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, { "1,1": { footpaths: [{ baseZ: 160 }] } }));
        expect(isPeepPlaceableTile(1, 1)).toBe(true);
    });

    it("accepts bare land", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, { "1,1": { surface: { baseHeight: 20 } } }));
        expect(isPeepPlaceableTile(1, 1)).toBe(true);
    });

    it("rejects a tile obstructed by small scenery even if it has a path", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 }, footpaths: [{ baseZ: 160 }], others: ["small_scenery"] }
        }));
        expect(isPeepPlaceableTile(1, 1)).toBe(false);
    });

    it("rejects tiles occupied by track, entrance or large scenery", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 }, others: ["track"] },
            "2,1": { surface: { baseHeight: 20 }, others: ["entrance"] },
            "3,1": { surface: { baseHeight: 20 }, others: ["large_scenery"] }
        }));
        expect(isPeepPlaceableTile(1, 1)).toBe(false);
        expect(isPeepPlaceableTile(2, 1)).toBe(false);
        expect(isPeepPlaceableTile(3, 1)).toBe(false);
    });

    it("rejects an empty tile and out-of-bounds coordinates", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, { "1,1": { footpaths: [{ baseZ: 160 }] } }));
        expect(isPeepPlaceableTile(5, 5)).toBe(false);
        expect(isPeepPlaceableTile(-1, 1)).toBe(false);
        expect(isPeepPlaceableTile(8, 1)).toBe(false);
    });
});

describe("findNearestPathInOrderedTiles", () => {
    it("returns the nearest placeable tile by Manhattan distance", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 160 }] },
            "4,4": { footpaths: [{ baseZ: 160 }] }
        }));
        const found = findNearestPathInOrderedTiles([pathTile(4, 4), pathTile(1, 1)], 0, 0);
        expect(found).not.toBeNull();
        expect([found?.x, found?.y]).toEqual([1, 1]);
    });

    it("skips obstructed candidates in favour of a placeable one further away", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 160 }], others: ["small_scenery"] },
            "4,4": { footpaths: [{ baseZ: 160 }] }
        }));
        const found = findNearestPathInOrderedTiles([pathTile(1, 1), pathTile(4, 4)], 0, 0);
        expect([found?.x, found?.y]).toEqual([4, 4]);
    });

    it("ignores candidates outside the map bounds", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, { "2,2": { footpaths: [{ baseZ: 160 }] } }));
        const found = findNearestPathInOrderedTiles([pathTile(-1, 0), pathTile(2, 2)], 0, 0);
        expect([found?.x, found?.y]).toEqual([2, 2]);
    });

    it("returns null when no candidate is placeable", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 160 }], others: ["small_scenery"] }
        }));
        expect(findNearestPathInOrderedTiles([pathTile(1, 1)], 0, 0)).toBeNull();
    });
});

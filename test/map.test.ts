import { describe, it, expect, afterEach } from "vitest";
import { setGameMap, resetGameMap } from "../src/game";
import { footpathsConnectTiles, surfaceTilesConnect, surfaceFenceBlocksWalking, isValidStationExit } from "../src/scan";
import { fakeMap } from "./fake-map";

afterEach(() => {
    resetGameMap();
});

describe("footpathsConnectTiles", () => {
    it("connects two flat neighbouring paths at the same height", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 100 }] },
            "2,1": { footpaths: [{ baseZ: 100 }] }
        }));
        expect(footpathsConnectTiles(1, 1, 2, 1)).toBe(true);
    });

    it("does not connect a bridge path to the path passing underneath", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 100 }] },
            "2,1": { footpaths: [{ baseZ: 148 }] }
        }));
        expect(footpathsConnectTiles(1, 1, 2, 1)).toBe(false);
    });

    it("picks the matching path when a tile carries several at different heights", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 100 }] },
            "2,1": { footpaths: [{ baseZ: 148 }, { baseZ: 100 }] }
        }));
        expect(footpathsConnectTiles(1, 1, 2, 1)).toBe(true);
    });

    it("rejects diagonal and identical tiles", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { footpaths: [{ baseZ: 100 }] },
            "2,2": { footpaths: [{ baseZ: 100 }] }
        }));
        expect(footpathsConnectTiles(1, 1, 2, 2)).toBe(false);
        expect(footpathsConnectTiles(1, 1, 1, 1)).toBe(false);
    });

    it("treats out-of-bounds tiles as having no paths", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "0,0": { footpaths: [{ baseZ: 100 }] }
        }));
        expect(footpathsConnectTiles(0, 0, -1, 0)).toBe(false);
    });
});

describe("surfaceTilesConnect", () => {
    it("connects neighbouring land at the same height", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } },
            "1,2": { surface: { baseHeight: 20 } }
        }));
        expect(surfaceTilesConnect(1, 1, 1, 2)).toBe(true);
    });

    it("does not connect across an unclimbable step", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } },
            "1,2": { surface: { baseHeight: 26 } }
        }));
        expect(surfaceTilesConnect(1, 1, 1, 2)).toBe(false);
    });

    it("does not connect to a submerged tile", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } },
            "1,2": { surface: { baseHeight: 20, waterHeight: 24 } }
        }));
        expect(surfaceTilesConnect(1, 1, 1, 2)).toBe(false);
    });

    it("does not connect when a tile has no surface at all", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } }
        }));
        expect(surfaceTilesConnect(1, 1, 1, 2)).toBe(false);
    });
});

describe("surfaceFenceBlocksWalking", () => {
    it("reports no blocking when neither tile is fenced", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } },
            "1,0": { surface: { baseHeight: 20 } }
        }));
        expect(surfaceFenceBlocksWalking(1, 1, 1, 0)).toBe(false);
    });

    it("blocks when the source tile is fenced on the shared edge", () => {
        // direction 0 is north (0,-1) and uses fence bit 0x4.
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20, parkFences: 0x4 } },
            "1,0": { surface: { baseHeight: 20 } }
        }));
        expect(surfaceFenceBlocksWalking(1, 1, 1, 0)).toBe(true);
    });

    it("blocks when only the destination tile is fenced on the shared edge", () => {
        // The opposite of north is south (index 2), which uses fence bit 0x1.
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20 } },
            "1,0": { surface: { baseHeight: 20, parkFences: 0x1 } }
        }));
        expect(surfaceFenceBlocksWalking(1, 1, 1, 0)).toBe(true);
    });

    it("ignores fences on unrelated edges", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20, parkFences: 0x8 } },
            "1,0": { surface: { baseHeight: 20, parkFences: 0x8 } }
        }));
        expect(surfaceFenceBlocksWalking(1, 1, 1, 0)).toBe(false);
    });

    it("reports no blocking for non-cardinal neighbours", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }, {
            "1,1": { surface: { baseHeight: 20, parkFences: 0xf } },
            "2,2": { surface: { baseHeight: 20, parkFences: 0xf } }
        }));
        expect(surfaceFenceBlocksWalking(1, 1, 2, 2)).toBe(false);
    });
});

describe("isValidStationExit", () => {
    it("accepts an exit inside the injected map bounds", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }));
        expect(isValidStationExit({ x: 64, y: 64, z: 0, direction: 0 })).toBe(true);
    });

    it("rejects an unused station slot pointing outside the map", () => {
        setGameMap(fakeMap({ x: 8, y: 8 }));
        expect(isValidStationExit({ x: 32000, y: 32000, z: 0, direction: 0 })).toBe(false);
    });
});

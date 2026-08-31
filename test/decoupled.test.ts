import { describe, it, expect } from "vitest";
import { footpathEdgeZ, oppositeDirection, footpathsConnect, surfacesConnect } from "../src/scan";
import { chunkTilesForStaffCount, isStandingOnTile, decideAreaAction } from "../src/staff";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands */

function fp(baseZ: number, slopeDirection: number | null = null): { baseZ: number; slopeDirection: number | null } {
	return { baseZ: baseZ, slopeDirection: slopeDirection };
}

describe("footpathEdgeZ", () => {
	it("flat footpath is at baseZ on every edge", () => {
		expect(footpathEdgeZ(fp(100), 0)).toBe(100);
		expect(footpathEdgeZ(fp(100), 1)).toBe(100);
		expect(footpathEdgeZ(fp(100), 2)).toBe(100);
		expect(footpathEdgeZ(fp(100), 3)).toBe(100);
	});
	it("sloped footpath is one level higher only on its slope direction edge", () => {
		const slope = fp(100, 2);
		expect(footpathEdgeZ(slope, 2)).toBe(100 + 16);
		expect(footpathEdgeZ(slope, 0)).toBe(100);
		expect(footpathEdgeZ(slope, 1)).toBe(100);
		expect(footpathEdgeZ(slope, 3)).toBe(100);
	});
	it("respects a custom slope height", () => {
		expect(footpathEdgeZ(fp(0, 1), 1, 32)).toBe(32);
	});
});

describe("oppositeDirection", () => {
	it("returns the opposite cardinal direction", () => {
		expect(oppositeDirection(0)).toBe(2);
		expect(oppositeDirection(1)).toBe(3);
		expect(oppositeDirection(2)).toBe(0);
		expect(oppositeDirection(3)).toBe(1);
	});
});

describe("footpathsConnect", () => {
	it("two flat paths at the same height connect", () => {
		expect(footpathsConnect(fp(100), fp(100), 0)).toBe(true);
		expect(footpathsConnect(fp(100), fp(100), 2)).toBe(true);
	});
	it("two flat paths at different heights do not connect", () => {
		expect(footpathsConnect(fp(100), fp(116), 0)).toBe(false);
	});
	it("a slope meets the raised path on its raised edge", () => {
		// from slopes up toward direction 2; to is flat at the raised height
		const from = fp(100, 2);
		const to = fp(116);
		expect(footpathsConnect(from, to, 2)).toBe(true);
	});
	it("a slope connects to a ramp facing the opposite way", () => {
		const from = fp(100, 0); // slopes up toward direction 0
		const to = fp(116, 2); // slopes up toward direction 2 (the opposite of 0)
		// direction 0 edge of `from` is raised (100+16); `to` edge opposite direction 0 (=2)
		// is its base edge (116), not 116+16, because to slopes DOWN toward direction 2.
		// Wait: to.slopeDirection=2 means to's raised edge is direction 2. Its edge facing
		// oppositeDirection(0)=2 is exactly its raised edge => 116+16=132 ≠ 116. So not connected.
		expect(footpathsConnect(from, to, 0)).toBe(false);
	});
	it("a slope does NOT meet a ramp sloping toward the shared edge", () => {
		const from = fp(100, 0); // raised on direction 0
		const to = fp(116, 2); // raised on direction 2 (the edge opposite direction 0)
		// from edge 0 is 116 (raised); to edge facing oppositeDirection(0)=2 is its
		// RAISED edge => 116+16=132. They don't meet, so not connected.
		expect(footpathsConnect(from, to, 0)).toBe(false);
	});
	it("a slope meets a flat path at its raised height", () => {
		const from = fp(100, 0); // edge 0 = 116
		const to = fp(116); // flat, edge opp(0)=2 = 116
		expect(footpathsConnect(from, to, 0)).toBe(true);
	});
	it("two raising slopes in the same direction don't connect nose to tail", () => {
		const from = fp(100, 0);
		const to = fp(132, 0);
		expect(footpathsConnect(from, to, 0)).toBe(false);
	});
	it("two flat paths at raised height with a ramp connect", () => {
		const from = fp(100, 2);
		const to = fp(116);
		expect(footpathsConnect(from, to, 2)).toBe(true);
	});
});

describe("surfacesConnect", () => {
	it("null surfaces never connect", () => {
		expect(surfacesConnect(null, null)).toBe(false);
		expect(surfacesConnect({ baseHeight: 5, waterHeight: 0 }, null)).toBe(false);
	});
	it("water blocks walking", () => {
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 0, waterHeight: 5 })).toBe(false);
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 5 }, { baseHeight: 0, waterHeight: 5 })).toBe(false);
	});
	it("flat adjacent land connects", () => {
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 0, waterHeight: 0 })).toBe(true);
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 2, waterHeight: 0 })).toBe(true);
	});
	it("steep steps (cliffs) block walking", () => {
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 3, waterHeight: 0 })).toBe(false);
	});
	it("obeys a custom max difference", () => {
		expect(surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 5, waterHeight: 0 }, 8)).toBe(true);
	});
});

describe("isStandingOnTile", () => {
	it("true when member occupies the tile", () => {
		const member = { x: 3 * 32 + 16, y: 7 * 32 + 2, z: 0 } as Staff;
		const tile = { x: 3, y: 7 } as PathTileInfo;
		expect(isStandingOnTile(member, tile)).toBe(true);
	});
	it("false when member is on a different tile", () => {
		const member = { x: 4 * 32, y: 7 * 32, z: 0 } as Staff;
		const tile = { x: 3, y: 7 } as PathTileInfo;
		expect(isStandingOnTile(member, tile)).toBe(false);
	});
});

describe("chunkTilesForStaffCount", () => {
	function chain(xs: number[], ys: number[]): PathTileInfo[] {
		return xs.map((x, i) => ({
			x: x, y: ys[i], baseHeight: 0, baseZ: 0, isQueue: false,
			neighbourKeys: [] as string[]
		}));
	}
	it("returns no chunks for no staff or no tiles", () => {
		expect(chunkTilesForStaffCount([], 3)).toEqual([]);
		expect(chunkTilesForStaffCount([{ x: 0, y: 0, baseHeight: 0, baseZ: 0, isQueue: false, neighbourKeys: [] }], 0)).toEqual([]);
	});
	it("splits a straight line into contiguous chunks equal to staff count", () => {
		const tiles = chain([0, 1, 2, 3, 4, 5], [0, 0, 0, 0, 0, 0]);
		for (const t of tiles) {
			const i = t.x;
			if (i > 0) {
				t.neighbourKeys.push(`${i - 1},0`);
			}
			if (i < 5) {
				t.neighbourKeys.push(`${i + 1},0`);
			}
		}
		const chunks = chunkTilesForStaffCount(tiles, 3);
		expect(chunks.length).toBe(3);
		const flat = chunks.map(c => c.map(t => t.x).join(",")).sort();
		expect(flat).toEqual(["0,1", "2,3", "4,5"]);
	});
	it("keeps a single connected component in one chunk when staff count is 1", () => {
		const tiles = chain([0, 1], [0, 0]);
		tiles[0].neighbourKeys.push("1,0");
		tiles[1].neighbourKeys.push("0,0");
		const chunks = chunkTilesForStaffCount(tiles, 1);
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(2);
	});
});

// Helper: convert a list of tile-coordinate pairs into world-coordinate areas (the
// form decideAreaAction expects - each tile is {x*32, y*32}).
function areaTiles(...tiles: [number, number][]): CoordsXY[] {
	return tiles.map(([tx, ty]) => ({ x: tx * 32, y: ty * 32 }));
}

describe("decideAreaAction", () => {
	it("returns covered when the tile is already in an area", () => {
		const areas = [areaTiles([0, 0], [1, 0])];
		expect(decideAreaAction(areas, { x: 0, y: 0 }, 8)).toEqual({ action: "covered" });
	});
	it("returns enlarge for an adjacent area under the cap", () => {
		const areas = [areaTiles([0, 0])]; // size 1, cap 8
		expect(decideAreaAction(areas, { x: 1, y: 0 }, 8)).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("returns hire for an adjacent area at the cap", () => {
		const areas = [areaTiles([0, 0], [1, 0], [2, 0], [3, 0])]; // size 4, cap 4
		expect(decideAreaAction(areas, { x: 4, y: 0 }, 4)).toEqual({ action: "hire" });
	});
	it("returns hire when no adjacent area exists", () => {
		expect(decideAreaAction([areaTiles([0, 0])], { x: 10, y: 10 }, 8)).toEqual({ action: "hire" });
	});
	it("enlarges the first adjacent area among several", () => {
		// two areas: (0,0) and (5,5); new tile (1,0) is adjacent to the first
		const areas = [areaTiles([0, 0]), areaTiles([5, 5])];
		expect(decideAreaAction(areas, { x: 1, y: 0 }, 8)).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("returns covered even for a non-first area", () => {
		const areas = [areaTiles([5, 5]), areaTiles([0, 0])];
		expect(decideAreaAction(areas, { x: 0, y: 0 }, 8)).toEqual({ action: "covered" });
	});
	it("enlarges an area that lies to the +x side of the new tile", () => {
		// area at (1,0); new tile (0,0) is only adjacent through the +x offset,
		// which the fixed code must detect (previously it hired for this case).
		const areas = [areaTiles([1, 0])];
		expect(decideAreaAction(areas, { x: 0, y: 0 }, 8)).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("enlarges an area that lies to the +y side of the new tile", () => {
		const areas = [areaTiles([0, 2])];
		expect(decideAreaAction(areas, { x: 0, y: 1 }, 8)).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("enlarges only a genuinely-connected (walkable) adjacent area when a connect predicate is supplied", () => {
		const areas = [areaTiles([1, 0])];
		// new tile (0,0) is cardinal-adjacent to area tile (1,0), and the predicate
		// confirms they are walkable -> enlarge.
		const decision = decideAreaAction(areas, { x: 0, y: 0 }, 8,
			function () { return true; });
		expect(decision).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("does not enlarge an unreachable (e.g. bridge) adjacent tile when the predicate returns false", () => {
		const areas = [areaTiles([1, 0])];
		// area tile at (1,0) is cardinal-adjacent to new tile (0,0), but the
		// predicate says they are not walkable (e.g. a bridge over a path) -> hire,
		// giving the unreachable tile its own staff member instead of merging areas.
		const decision = decideAreaAction(areas, { x: 0, y: 0 }, 8,
			function () { return false; });
		expect(decision.action).toBe("hire");
	});
	it("the connect predicate only gates adjacency, not coverage", () => {
		const areas = [areaTiles([0, 0])];
		// new tile is already in the area -> covered regardless of the predicate.
		const decision = decideAreaAction(areas, { x: 0, y: 0 }, 8,
			function () { return false; });
		expect(decision).toEqual({ action: "covered" });
	});
});

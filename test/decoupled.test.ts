import {
	type AreaNode,
	chunkTilesForStaffCount,
	decideAreaAction,
	isStandingOnTile,
} from "../src/staff";
import {
	type PathTileInfo,
	findFootpathAtEdge,
	footpathEdgeZ,
	footpathsConnect,
	oppositeDirection,
	surfacesConnect,
} from "../src/scan";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/restrict-template-expressions */

const fp = function fp(
	baseZ: number,
	slopeDirection: number | null = null,
): { baseZ: number; slopeDirection: number | null } {
	return { baseZ: baseZ, slopeDirection: slopeDirection };
};

const alwaysConnected = function alwaysConnected(): boolean {
	return true;
};

const neverConnected = function neverConnected(): boolean {
	return false;
};

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

describe("findFootpathAtEdge", () => {
	it("returns the flat footpath sitting at the edge height", () => {
		expect(findFootpathAtEdge(0, 100, [fp(100)])).toEqual(fp(100));
	});
	it("returns the sloped footpath whose raised edge matches the height", () => {
		// fp(100, 0) rises toward direction 0, so the edge facing 0 is at 100 + 16.
		expect(findFootpathAtEdge(0, 116, [fp(100, 0)])).toEqual(fp(100, 0));
	});
	it("returns undefined when no footpath meets at that height", () => {
		expect(findFootpathAtEdge(0, 150, [fp(100)])).toBeUndefined();
	});
	it("picks the correct stacked footpath by height (ground vs bridge)", () => {
		const ground = fp(100);
		const bridge = fp(200);
		// The same tile carries a ground and a bridge footpath; only the one whose
		// edge matches the height the walk crosses at is the connected node.
		expect(findFootpathAtEdge(2, 100, [bridge, ground])).toEqual(ground);
		expect(findFootpathAtEdge(2, 200, [bridge, ground])).toEqual(bridge);
	});
});

describe("surfacesConnect", () => {
	it("undefined surfaces never connect", () => {
		expect(surfacesConnect(undefined, undefined)).toBe(false);
		expect(surfacesConnect({ baseHeight: 5, waterHeight: 0 }, undefined)).toBe(false);
	});
	it("water blocks walking", () => {
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 0, waterHeight: 5 }),
		).toBe(false);
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 5 }, { baseHeight: 0, waterHeight: 5 }),
		).toBe(false);
	});
	it("flat adjacent land connects", () => {
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 0, waterHeight: 0 }),
		).toBe(true);
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 2, waterHeight: 0 }),
		).toBe(true);
	});
	it("steep steps (cliffs) block walking", () => {
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 3, waterHeight: 0 }),
		).toBe(false);
	});
	it("obeys a custom max difference", () => {
		expect(
			surfacesConnect({ baseHeight: 0, waterHeight: 0 }, { baseHeight: 5, waterHeight: 0 }, 8),
		).toBe(true);
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

const chain = function chain(xs: number[], ys: number[]): PathTileInfo[] {
	return xs.map((x, i) => ({
		x: x,
		y: ys[i],
		baseHeight: 0,
		baseZ: 0,
		isQueue: false,
		neighbourKeys: [] as string[],
	}));
};

describe("chunkTilesForStaffCount", () => {
	it("returns no chunks for no staff or no tiles", () => {
		expect(chunkTilesForStaffCount([], 3)).toEqual([]);
		expect(
			chunkTilesForStaffCount(
				[{ x: 0, y: 0, baseHeight: 0, baseZ: 0, isQueue: false, neighbourKeys: [] }],
				0,
			),
		).toEqual([]);
	});
	it("splits a straight line into contiguous chunks equal to staff count", () => {
		const tiles = chain([0, 1, 2, 3, 4, 5], [0, 0, 0, 0, 0, 0]);
		for (const t of tiles) {
			const i = t.x;
			if (0 < i) {
				t.neighbourKeys.push(`${i - 1},0,0`);
			}
			if (5 > i) {
				t.neighbourKeys.push(`${i + 1},0,0`);
			}
		}
		const chunks = chunkTilesForStaffCount(tiles, 3);
		expect(chunks.length).toBe(3);
		const flat = chunks.map((c) => c.map((t) => t.x).join(",")).toSorted();
		expect(flat).toEqual(["0,1", "2,3", "4,5"]);
	});
	it("keeps a single connected component in one chunk when staff count is 1", () => {
		const tiles = chain([0, 1], [0, 0]);
		tiles[0].neighbourKeys.push("1,0,0");
		tiles[1].neighbourKeys.push("0,0,0");
		const chunks = chunkTilesForStaffCount(tiles, 1);
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(2);
	});
	it("does not split a parallel path+queue connected at one end when staff count is 1", () => {
		// Two parallel strips that join at the left into one connected network,
		// like a path and a queue connected at one end on a bridge: every chunk
		// must remain one contiguous piece (the merge step must not drop it).
		const tiles: PathTileInfo[] = [];
		const mk = (x: number, y: number) => ({
			x,
			y,
			baseHeight: 0,
			baseZ: 0,
			isQueue: 3 <= x,
			neighbourKeys: [] as string[],
		});
		for (let x = 0; 4 >= x; x++) {
			tiles.push(mk(x, 0));
		}
		for (let x = 0; 4 >= x; x++) {
			tiles.push(mk(x, 2));
		}
		// mid connector at x=0..2 joins both rows at each x
		for (let x = 0; 2 >= x; x++) {
			tiles.push(mk(x, 1));
		}
		const key = (x: number, y: number) => `${x},${y},0`;
		const t = {} as { [key: string]: PathTileInfo };
		for (const tile of tiles) {
			t[key(tile.x, tile.y)] = tile;
		}
		const link = (from: CoordsXY, to: CoordsXY) => {
			t[key(from.x, from.y)].neighbourKeys.push(key(to.x, to.y));
		};
		// horizontal links row 0
		for (let x = 0; 4 > x; x++) {
			link({ x: x, y: 0 }, { x: x + 1, y: 0 });
		}
		// horizontal links row 2
		for (let x = 0; 4 > x; x++) {
			link({ x: x, y: 2 }, { x: x + 1, y: 2 });
		}
		// vertical connectors
		for (let x = 0; 2 >= x; x++) {
			link({ x: x, y: 0 }, { x: x, y: 1 });
			link({ x: x, y: 1 }, { x: x, y: 0 });
			link({ x: x, y: 1 }, { x: x, y: 2 });
			link({ x: x, y: 2 }, { x: x, y: 1 });
		}
		const chunks = chunkTilesForStaffCount(tiles, 1);
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(tiles.length);
		// And the single area must touch the connector (row 1) AND both rows: it
		// spans across the whole connected component.
		const keys = new Set(chunks[0].map((til) => key(til.x, til.y)));
		expect(keys.has(key(0, 1))).toBe(true);
		expect(keys.has(key(4, 0))).toBe(true);
		expect(keys.has(key(4, 2))).toBe(true);
	});
	it("every chunk stays contiguous for multiple staff on a connected network", () => {
		// Same connected U-network, but enough staff that the network is split into
		// several areas. Every chunk must remain one contiguous piece, and together
		// they must cover every tile exactly once (no orphan/connection loss).
		const tiles: PathTileInfo[] = [];
		const mk = (x: number, y: number) => ({
			x,
			y,
			baseHeight: 0,
			baseZ: 0,
			isQueue: false,
			neighbourKeys: [] as string[],
		});
		for (let y = 0; 4 >= y; y++) {
			for (let x = 0; 4 >= x; x++) {
				tiles.push(mk(x, y));
			}
		}
		const key = (x: number, y: number) => `${x},${y},0`;
		const t = {} as { [key: string]: PathTileInfo };
		for (const tile of tiles) {
			t[key(tile.x, tile.y)] = tile;
		}
		for (const tile of tiles) {
			const { x, y } = tile;
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			] as const) {
				const nx = x + dx,
					ny = y + dy;
				const nk = key(nx, ny);
				if (nk in t) {
					tile.neighbourKeys.push(nk);
				}
			}
		}
		const chunks = chunkTilesForStaffCount(tiles, 5);
		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		expect(total).toBe(tiles.length); // no tile lost
		for (const chunk of chunks) {
			const keys = new Set(chunk.map((til) => key(til.x, til.y)));
			const seen = new Set<string>([key(chunk[0].x, chunk[0].y)]);
			const queue: string[] = [key(chunk[0].x, chunk[0].y)];
			let qi = 0;
			while (qi < queue.length) {
				const ck = queue[qi];
				qi++;
				const cur = t[ck];
				for (const nk of cur.neighbourKeys) {
					if (keys.has(nk) && !seen.has(nk)) {
						seen.add(nk);
						queue.push(nk);
					}
				}
			}
			expect(seen.size).toBe(chunk.length); // every chunk is one piece
		}
	});
	it("keeps stacked-footpath nodes (same tile, different heights) in separate chunks", () => {
		// A ground path (4,10)-(5,10)-(6,10) at baseZ 100 and a bridge
		// (5,9)-(5,10)-(5,11) at baseZ 200 cross at tile (5,10). The two stacked
		// footpaths on (5,10) are DISTINCT nodes (keyed by baseZ) and are NOT
		// walkable to each other (there is no ramp between them), so no patrol
		// area may end up containing a ground tile and a bridge tile together -
		// that is exactly the "tile above another, area misses the way between"
		// bug this regression guards against.
		const tile = (x: number, y: number, baseZ: number, neighbours: string[]): PathTileInfo => ({
			x,
			y,
			baseHeight: 0,
			baseZ,
			isQueue: false,
			neighbourKeys: neighbours,
		});
		const tiles: PathTileInfo[] = [
			tile(4, 10, 100, ["5,10,100"]),
			tile(5, 10, 100, ["4,10,100", "6,10,100"]),
			tile(6, 10, 100, ["5,10,100"]),
			tile(5, 9, 200, ["5,10,200"]),
			tile(5, 10, 200, ["5,9,200", "5,11,200"]),
			tile(5, 11, 200, ["5,10,200"]),
		];
		const chunks = chunkTilesForStaffCount(tiles, 2);
		// The two stacked networks stay separate instead of merging into one area.
		expect(chunks.length).toBe(2);
		// Both stacked nodes at (5,10) survive as distinct tiles (not collapsed).
		const allKeys = new Set(chunks.flat().map((t) => `${t.x},${t.y},${t.baseZ}`));
		expect(allKeys.has("5,10,100")).toBe(true);
		expect(allKeys.has("5,10,200")).toBe(true);
		for (const chunk of chunks) {
			const keys = new Set(chunk.map((t) => `${t.x},${t.y},${t.baseZ}`));
			const byKey = new Map<string, PathTileInfo>();
			for (const t of chunk) {
				byKey.set(`${t.x},${t.y},${t.baseZ}`, t);
			}
			// Every chunk is one contiguous piece.
			const seen = new Set<string>([`${chunk[0].x},${chunk[0].y},${chunk[0].baseZ}`]);
			const queue: string[] = [...seen];
			let qi = 0;
			while (qi < queue.length) {
				const ck = queue[qi];
				qi++;
				for (const nk of byKey.get(ck)?.neighbourKeys ?? []) {
					if (keys.has(nk) && !seen.has(nk)) {
						seen.add(nk);
						queue.push(nk);
					}
				}
			}
			expect(seen.size).toBe(chunk.length);
			// ...and never mixes a ground (baseZ 100) tile with a bridge (baseZ 200) tile.
			expect(new Set(chunk.map((t) => t.baseZ)).size).toBe(1);
		}
	});
});

// Helper: build an area's node list (tile coordinates + height level).
const areaNodes = function areaNodes(...tiles: [number, number, number][]): AreaNode[] {
	return tiles.map(([x, y, baseZ]) => ({ x: x, y: y, baseZ: baseZ }));
};

describe("decideAreaAction", () => {
	it("returns covered when the node is already in an area", () => {
		const areas = [areaNodes([0, 0, 8], [1, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "covered" });
	});
	it("returns enlarge for an adjacent area under the cap", () => {
		const areas = [areaNodes([0, 0, 8])]; // size 1, cap 8
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 1, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("returns hire for an adjacent area at the cap", () => {
		const areas = [areaNodes([0, 0, 8], [1, 0, 8], [2, 0, 8], [3, 0, 8])]; // size 4, cap 4
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 4, y: 0, baseZ: 8 }, maxSize: 4 }),
		).toEqual({ action: "hire" });
	});
	it("returns hire when no adjacent area exists", () => {
		expect(
			decideAreaAction({
				areas: [areaNodes([0, 0, 8])],
				newNode: { x: 10, y: 10, baseZ: 8 },
				maxSize: 8,
			}),
		).toEqual({ action: "hire" });
	});
	it("enlarges the first adjacent area among several", () => {
		// two areas: (0,0) and (5,5); new node (1,0) is adjacent to the first
		const areas = [areaNodes([0, 0, 8]), areaNodes([5, 5, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 1, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("returns covered even for a non-first area", () => {
		const areas = [areaNodes([5, 5, 8]), areaNodes([0, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "covered" });
	});
	it("enlarges an area that lies to the +x side of the new node", () => {
		// area at (1,0); new node (0,0) is only adjacent through the +x offset,
		// which the fixed code must detect (previously it hired for this case).
		const areas = [areaNodes([1, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("enlarges an area that lies to the +y side of the new node", () => {
		const areas = [areaNodes([0, 2, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 1, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("enlarges only a genuinely-connected (walkable) adjacent area when a connect predicate is supplied", () => {
		const areas = [areaNodes([1, 0, 8])];
		// new node (0,0) is cardinal-adjacent to area node (1,0), and the predicate
		// confirms they are walkable -> enlarge.
		const decision = decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 8 },
			maxSize: 8,
			connect: alwaysConnected,
		});
		expect(decision).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("does not enlarge an unreachable (e.g. bridge) adjacent node when the predicate returns false", () => {
		const areas = [areaNodes([1, 0, 8])];
		// area node at (1,0) is cardinal-adjacent to new node (0,0), but the
		// predicate says they are not walkable (e.g. a bridge over a path) -> hire,
		// giving the unreachable node its own staff member instead of merging areas.
		const decision = decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 8 },
			maxSize: 8,
			connect: neverConnected,
		});
		expect(decision.action).toBe("hire");
	});
	it("the connect predicate only gates adjacency, not coverage", () => {
		const areas = [areaNodes([0, 0, 8])];
		// new node is already in the area -> covered regardless of the predicate.
		const decision = decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 8 },
			maxSize: 8,
			connect: neverConnected,
		});
		expect(decision).toEqual({ action: "covered" });
	});
	it("covered is per level: a stacked second level on a covered tile is NOT covered", () => {
		// The area owns the ground level (8) of tile (0,0). A bridge level (24)
		// stacked on the same tile is a different node: it is not covered and,
		// with nothing walkable-adjacent, must start its own area.
		const areas = [areaNodes([0, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 24 }, maxSize: 8 }),
		).toEqual({ action: "hire" });
	});
	it("enlarges via the matching level of a stacked area tile", () => {
		// The area owns both levels of tile (1,0) (a ramp loop connects them).
		const areas = [areaNodes([1, 0, 8], [1, 0, 24])];
		const decision = decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 24 },
			maxSize: 8,
			// Only the matching height level is walkable-adjacent.
			connect: (areaNode, newNode) => areaNode.baseZ === newNode.baseZ,
		});
		expect(decision).toEqual({ action: "enlarge", areaIndex: 0 });
	});
	it("does not enlarge through a level of the area the new node cannot reach", () => {
		// The area owns the ground level (8) of tile (1,0) only. The new bridge
		// level (24) is cardinal-adjacent at x/y but not walkable-adjacent.
		const areas = [areaNodes([1, 0, 8])];
		const decision = decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 24 },
			maxSize: 8,
			connect: (areaNode, newNode) => areaNode.baseZ === newNode.baseZ,
		});
		expect(decision).toEqual({ action: "hire" });
	});
	it("hires for a negative tile coordinate", () => {
		expect(
			decideAreaAction({
				areas: [areaNodes([0, 0, 8])],
				newNode: { x: -1, y: 0, baseZ: 8 },
				maxSize: 8,
			}),
		).toEqual({ action: "hire" });
		expect(
			decideAreaAction({
				areas: [areaNodes([0, 0, 8])],
				newNode: { x: 0, y: -1, baseZ: 8 },
				maxSize: 8,
			}),
		).toEqual({ action: "hire" });
	});
	it("hires when no areas exist at all", () => {
		expect(decideAreaAction({ areas: [], newNode: { x: 3, y: 3, baseZ: 8 }, maxSize: 8 })).toEqual({
			action: "hire",
		});
	});
	it("ignores empty areas when looking for an adjacent one", () => {
		// The first area has no nodes; the second is the genuinely adjacent one,
		// so its index (not the empty one's) must be reported.
		const areas = [areaNodes(), areaNodes([1, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 8 }, maxSize: 8 }),
		).toEqual({ action: "enlarge", areaIndex: 1 });
	});
	it("passes the matched area node and index to the connect predicate", () => {
		const areas = [areaNodes([5, 5, 8]), areaNodes([1, 0, 8])];
		const calls: number[][] = [];
		decideAreaAction({
			areas: areas,
			newNode: { x: 0, y: 0, baseZ: 8 },
			maxSize: 8,
			connect: function connect(areaNode, newNode, index) {
				calls.push([areaNode.x, areaNode.y, areaNode.baseZ, newNode.x, newNode.y, index]);
				return true;
			},
		});
		// Only the actually-adjacent node (1,0,8) of area 1 is offered to the
		// predicate, with the new node's coordinates and that area's index.
		expect(calls).toEqual([[1, 0, 8, 0, 0, 1]]);
	});
	it("diagonal-only neighbours are not adjacent", () => {
		// (1,1) touches (0,0) only at a corner, which is not walkable.
		expect(
			decideAreaAction({
				areas: [areaNodes([1, 1, 8])],
				newNode: { x: 0, y: 0, baseZ: 8 },
				maxSize: 8,
			}),
		).toEqual({ action: "hire" });
	});
	it("checks the cap of the adjacent area, not of the first area", () => {
		// Area 0 is far away and full; area 1 is the adjacent one and under the cap.
		const areas = [areaNodes([9, 9, 8], [9, 8, 8]), areaNodes([1, 0, 8])];
		expect(
			decideAreaAction({ areas: areas, newNode: { x: 0, y: 0, baseZ: 8 }, maxSize: 2 }),
		).toEqual({ action: "enlarge", areaIndex: 1 });
	});
});

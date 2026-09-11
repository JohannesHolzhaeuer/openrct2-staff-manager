import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildNetwork,
	centralTile,
	exitToPathTile,
	getCachedNetwork,
	getConnectedPaths,
	graphDistance,
	invalidatePathGraphCache,
	nearestZoneIndex,
	pathTilesConnected,
	resetPathGraphCacheForTests,
	snapToNetwork,
	splitIntoZones,
} from "../src/paths/path-graph";
import { resetGameContext, resetGameMap, setGameContext, setGameMap } from "../src/game";
import { FakeContext } from "./fake-context";
import { fakeMap } from "./fake-map";

let ctx: FakeContext = new FakeContext();
const isIncluded = function isIncluded(): boolean {
	return true;
};

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
});

afterEach(() => {
	resetGameMap();
	resetGameContext();
	resetPathGraphCacheForTests();
});

const fireAction = function fireAction(action: string): void {
	ctx.actionExecuteCallback?.({ action: action, args: {} } as unknown as GameActionEventArgs);
};

describe("pathTilesConnected", () => {
	it("reports a connection reachable via getConnectedPaths", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		expect(pathTilesConnected({ x: 1, y: 1, z: 100 }, { x: 2, y: 1 })).toBe(true);
	});

	it("does not connect a bridge path to the path passing underneath, across a slope", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100, slopeDirection: 2 }] },
					"2,1": { footpaths: [{ baseZ: 116 }] },
					"3,1": { footpaths: [{ baseZ: 148 }] },
				},
			),
		);
		// The slope at (1,1) climbs towards +X (direction 2), so its edge
		// there is one level up (116) and correctly meets (2,1); a distant,
		// unrelated path at a different height must not be reported connected.
		expect(pathTilesConnected({ x: 1, y: 1, z: 100 }, { x: 2, y: 1 })).toBe(true);
		expect(pathTilesConnected({ x: 2, y: 1, z: 116 }, { x: 3, y: 1 })).toBe(false);
	});
});

describe("buildNetwork", () => {
	it("only includes tiles reachable via real PathConnections, excluding islands", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
					"3,1": { footpaths: [{ baseZ: 100 }] },
					// Disconnected island: no footpath links it to the rest.
					"6,6": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect([...graph.nodes.keys()].toSorted()).toEqual(["1,1", "2,1", "3,1"]);
	});

	it("respects the isIncluded filter (e.g. excluding queue tiles)", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100, isQueue: true }] },
					"3,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function excludeQueueTile(x, y) {
			return !(2 === x && 1 === y);
		});
		expect(graph.nodes.has("2,1")).toBe(false);
	});
});

describe("graphDistance", () => {
	it("counts hops along real edges, not straight-line distance", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"1,2": { footpaths: [{ baseZ: 100 }] },
					"1,3": { footpaths: [{ baseZ: 100 }] },
					"2,3": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect(graphDistance(graph, "1,1", "2,3")).toBe(3);
		expect(graphDistance(graph, "1,1", "9,9")).toBe(Infinity);
	});
});

describe("splitIntoZones", () => {
	it("splits a connected network into the requested number of connected zones", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
					"3,1": { footpaths: [{ baseZ: 100 }] },
					"4,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		const zones = splitIntoZones(graph, 2);
		expect(zones.length).toBe(2);
		const allKeys = zones.flat().toSorted();
		expect(allKeys).toEqual(["1,1", "2,1", "3,1", "4,1"]);
		// Every zone must itself be connected within the source graph.
		for (const zone of zones) {
			const zoneKeys = new Set(zone);
			const reached = new Set<string>([zone[0]]);
			const queue = [zone[0]];
			let head = 0;
			while (head < queue.length) {
				const current = queue[head++];
				for (const neighbour of graph.edges.get(current) ?? []) {
					if (zoneKeys.has(neighbour) && !reached.has(neighbour)) {
						reached.add(neighbour);
						queue.push(neighbour);
					}
				}
			}
			expect(reached.size).toBe(zone.length);
		}
	});
});

describe("nearestZoneIndex", () => {
	it("picks the zone closest by real graph distance", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
					"3,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		const zones = [["3,1"], ["1,1"]];
		expect(nearestZoneIndex(graph, "1,1", zones)).toBe(1);
	});

	it("returns -1 when no zone is reachable", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect(nearestZoneIndex(graph, "1,1", [["9,9"]])).toBe(-1);
	});
});

describe("centralTile", () => {
	it("picks the tile minimising the maximum hop distance to the rest of the zone", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
					"3,1": { footpaths: [{ baseZ: 100 }] },
					"4,1": { footpaths: [{ baseZ: 100 }] },
					"5,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		const keys = ["1,1", "2,1", "3,1", "4,1", "5,1"];
		expect(centralTile(graph, keys)).toBe("3,1");
	});

	it("returns undefined for an empty key list", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect(centralTile(graph, [])).toBeUndefined();
	});
});

describe("getConnectedPaths", () => {
	it("returns an empty list when there is no footpath at the position", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {}));
		expect(getConnectedPaths({ x: 1, y: 1, z: 100 })).toEqual([]);
	});
});

describe("snapToNetwork", () => {
	it("returns the tile key when the start is already a node", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect(snapToNetwork(graph, { x: 1, y: 1, z: 100 })).toBe("1,1");
	});

	it("snaps to the nearest reachable node for a start outside the network", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
					// The start tile (1,2) has a path connecting up to (1,1),
					// but is excluded from the graph by the isIncluded filter.
					"1,2": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function excludeStartTile(x, y) {
			return !(1 === x && 2 === y);
		});
		// (1,2) is not part of the graph, but connects to (1,1).
		expect(snapToNetwork(graph, { x: 1, y: 2, z: 100 })).toBe("1,1");
	});

	it("returns undefined when no neighbouring node belongs to the graph", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		// An island at (6,6) is not in the graph built from (1,1).
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		expect(snapToNetwork(graph, { x: 6, y: 6, z: 100 })).toBeUndefined();
	});
});

describe("splitIntoZones edge cases", () => {
	it("returns a single zone for zoneCount 1", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		const zones = splitIntoZones(graph, 1);
		expect(zones.length).toBe(1);
		expect(zones[0]).toHaveLength(2);
	});

	it("handles a graph with only the start node (no connections)", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function includeAllTiles() {
			return true;
		});
		// An isolated start is always its own single node/zone.
		expect(splitIntoZones(graph, 3)).toEqual([["1,1"]]);
	});
});

describe("exitToPathTile", () => {
	it("finds the connected path tile via the engine's own PathNavigator instead of a plain cardinal probe", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const result = exitToPathTile({ x: 1, y: 1, z: 100 }, [
			{ x: 1, y: 0 },
			{ x: -1, y: 0 },
			{ x: 0, y: 1 },
			{ x: 0, y: -1 },
		]);
		expect(result).toEqual({ x: 2, y: 1, z: 100 });
	});

	it("returns undefined when none of the candidate offsets have a footpath", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {}));
		const result = exitToPathTile({ x: 1, y: 1, z: 100 }, [{ x: 1, y: 0 }]);
		expect(result).toBeUndefined();
	});
});

describe("path graph cache", () => {
	it("reuses the cached network until an invalidating action fires", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
					"2,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).toBe(first);

		fireAction("footpathplace");
		const third = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(third).not.toBe(first);
	});

	it("is not invalidated by unrelated actions", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		fireAction("staffhire");
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).toBe(first);
	});

	it("invalidatePathGraphCache forces a rebuild on next use", () => {
		setGameMap(
			fakeMap(
				{ x: 8, y: 8 },
				{
					"1,1": { footpaths: [{ baseZ: 100 }] },
				},
			),
		);
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		invalidatePathGraphCache();
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).not.toBe(first);
	});
});

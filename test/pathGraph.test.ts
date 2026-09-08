import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetGameContext, resetGameMap, setGameContext, setGameMap } from "../src/game";
import { fakeMap } from "./fake-map";
import { FakeContext } from "./fake-context";
import {
	buildNetwork, centralTile, exitToPathTile, getCachedNetwork, graphDistance,
	invalidatePathGraphCache, nearestZoneIndex, pathTilesConnected, resetPathGraphCacheForTests,
	splitIntoZones
} from "../src/paths/pathGraph";

let ctx: FakeContext;
const isIncluded = function  isIncluded(): boolean { return true; };

beforeEach(() => {
	ctx = new FakeContext();
	setGameContext(ctx);
});

afterEach(() => {
	resetGameMap();
	resetGameContext();
	resetPathGraphCacheForTests();
});

function fireAction(action: string): void {
	ctx.actionExecuteCallback?.({ action: action, args: {} } as unknown as GameActionEventArgs);
}

describe("pathTilesConnected", () => {
	it("reports a connection reachable via getConnectedPaths", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] }
		}));
		expect(pathTilesConnected(1, 1, 100, 2, 1)).toBe(true);
	});

	it("does not connect a bridge path to the path passing underneath, across a slope", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100, slopeDirection: 2 }] },
			"2,1": { footpaths: [{ baseZ: 116 }] },
			"3,1": { footpaths: [{ baseZ: 148 }] }
		}));
		// The slope at (1,1) climbs towards +X (direction 2), so its edge
		// there is one level up (116) and correctly meets (2,1); a distant,
		// unrelated path at a different height must not be reported connected.
		expect(pathTilesConnected(1, 1, 100, 2, 1)).toBe(true);
		expect(pathTilesConnected(2, 1, 116, 3, 1)).toBe(false);
	});
});

describe("buildNetwork", () => {
	it("only includes tiles reachable via real PathConnections, excluding islands", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] },
			"3,1": { footpaths: [{ baseZ: 100 }] },
			// Disconnected island: no footpath links it to the rest.
			"6,6": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		expect([...graph.nodes.keys()].sort()).toEqual(["1,1", "2,1", "3,1"]);
	});

	it("respects the isIncluded filter (e.g. excluding queue tiles)", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100, isQueue: true }] },
			"3,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function (x, y) { return !(2 === x && 1 === y); });
		expect(graph.nodes.has("2,1")).toBe(false);
	});
});

describe("graphDistance", () => {
	it("counts hops along real edges, not straight-line distance", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"1,2": { footpaths: [{ baseZ: 100 }] },
			"1,3": { footpaths: [{ baseZ: 100 }] },
			"2,3": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		expect(graphDistance(graph, "1,1", "2,3")).toBe(3);
		expect(graphDistance(graph, "1,1", "9,9")).toBe(Infinity);
	});
});

describe("splitIntoZones", () => {
	it("splits a connected network into the requested number of connected zones", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] },
			"3,1": { footpaths: [{ baseZ: 100 }] },
			"4,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		const zones = splitIntoZones(graph, 2);
		expect(zones.length).toBe(2);
		const allKeys = zones.flat().sort();
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
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] },
			"3,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		const zones = [["3,1"], ["1,1"]];
		expect(nearestZoneIndex(graph, "1,1", zones)).toBe(1);
	});

	it("returns -1 when no zone is reachable", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		expect(nearestZoneIndex(graph, "1,1", [["9,9"]])).toBe(-1);
	});
});

describe("centralTile", () => {
	it("picks the tile minimising the maximum hop distance to the rest of the zone", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] },
			"3,1": { footpaths: [{ baseZ: 100 }] },
			"4,1": { footpaths: [{ baseZ: 100 }] },
			"5,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const graph = buildNetwork({ x: 1, y: 1, z: 100 }, function () { return true; });
		const keys = ["1,1", "2,1", "3,1", "4,1", "5,1"];
		expect(centralTile(graph, keys)).toBe("3,1");
	});
});

describe("exitToPathTile", () => {
	it("finds the connected path tile via the engine's own PathNavigator instead of a plain cardinal probe", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"2,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const result = exitToPathTile(1, 1, 100, [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]);
		expect(result).toEqual({ x: 2, y: 1, z: 100 });
	});

	it("returns null when none of the candidate offsets have a footpath", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {}));
		const result = exitToPathTile(1, 1, 100, [{ x: 1, y: 0 }]);
		expect(result).toBeNull();
	});
});

describe("path graph cache", () => {
	it("reuses the cached network until an invalidating action fires", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] },
			"2,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).toBe(first);

		fireAction("footpathplace");
		const third = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(third).not.toBe(first);
	});

	it("is not invalidated by unrelated actions", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		fireAction("staffhire");
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).toBe(first);
	});

	it("invalidatePathGraphCache forces a rebuild on next use", () => {
		setGameMap(fakeMap({ x: 8, y: 8 }, {
			"1,1": { footpaths: [{ baseZ: 100 }] }
		}));
		const first = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		invalidatePathGraphCache();
		const second = getCachedNetwork({ x: 1, y: 1, z: 100 }, isIncluded);
		expect(second).not.toBe(first);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	gameContext,
	gameMap,
	gameObjects,
	resetGameContext,
	resetGameMap,
	resetGameObjects,
} from "../src/game";

// The real delegates forward to the OpenRCT2 `objectManager` / `map` /
// `context` globals. Every other test swaps in fakes via the set*Game*()
// seams, so the real delegates' forwarding bodies would otherwise never
// execute. Stub the globals (as main.test.ts / ui.test.ts do) so the
// forwarding is exercised and the seam contract is pinned.
interface TestGlobal {
	objectManager?: {
		getAllObjects(type: "terrain_surface" | "peep_animations"): LoadedObject[];
		getObject(type: "small_scenery", index: number): SmallSceneryObject;
	};
	map?: {
		size: CoordsXY;
		rides: unknown[];
		getTile(x: number, y: number): unknown;
		getAllEntities(type: "staff"): unknown[];
		getPathNavigator: (...args: unknown[]) => unknown;
	};
	context?: {
		setTimeout(callback: () => void, delay: number): number;
		clearTimeout(handle: number): void;
		executeAction(action: string, args: object, callback: (result: unknown) => void): void;
		subscribe(hook: string, callback: (event: unknown) => void): { dispose: () => void };
		sharedStorage: { get: (key: string, fallback: unknown) => unknown; set: (key: string) => void };
	};
}
const testGlobal = globalThis as unknown as TestGlobal;

const surfaceObjects = function surfaceObjects(): LoadedObject[] {
	return [{ identifier: "rct2.surface.grass", index: 0 }] as unknown as LoadedObject[];
};

const waterableScenery = function waterableScenery(): SmallSceneryObject {
	// SMALL_SCENERY_FLAG_CAN_BE_WATERED is the bit read by scan.ts.
	return { identifier: "rct2.scenery.flower", index: 4, flags: 1 } as unknown as SmallSceneryObject;
};

beforeEach(() => {
	testGlobal.objectManager = {
		getAllObjects(): LoadedObject[] {
			return surfaceObjects();
		},
		getObject(): SmallSceneryObject {
			return waterableScenery();
		},
	};
	testGlobal.map = {
		size: { x: 8, y: 8 } as CoordsXY,
		rides: [],
		getTile: (): unknown => ({}) as unknown,
		getAllEntities: (): unknown[] => [],
		getPathNavigator: (): undefined => undefined,
	};
	testGlobal.context = {
		setTimeout: (): number => 1,
		clearTimeout: (): void => {
			/* no-op */
		},
		executeAction: (): void => {
			/* no-op */
		},
		subscribe: (): { dispose: () => void } => ({
			dispose: (): void => {
				/* no-op */
			},
		}),
		sharedStorage: {
			get: (_key: string, fallback: unknown): unknown => fallback,
			set: (): void => {
				/* no-op */
			},
		},
	};
});

afterEach(() => {
	delete testGlobal.objectManager;
	delete testGlobal.map;
	delete testGlobal.context;
	resetGameObjects();
	resetGameMap();
	resetGameContext();
});

describe("real GameObjects delegate", () => {
	it("forwards getAllObjects to the objectManager global", () => {
		const objects = gameObjects().getAllObjects("terrain_surface");
		expect(objects.map((o) => o.identifier)).toEqual(["rct2.surface.grass"]);
	});

	it("forwards getObject to the objectManager global", () => {
		const scenery = gameObjects().getObject("small_scenery", 4);
		expect(scenery.identifier).toBe("rct2.scenery.flower");
		expect(scenery.flags & 1).toBe(1);
	});
});

describe("real GameMap delegate", () => {
	// The globals are always populated in beforeEach; grab a non-null local
	// reference so the delegating bodies can be stubbed without `!`.
	const stubMap = function stubMap(): NonNullable<TestGlobal["map"]> {
		return testGlobal.map as NonNullable<TestGlobal["map"]>;
	};

	it("forwards size to the map global", () => {
		expect(gameMap().size).toEqual({ x: 8, y: 8 });
	});

	it("forwards rides to the map global", () => {
		expect(gameMap().rides).toEqual([]);
	});

	it("forwards getTile to the map global", () => {
		const map = stubMap();
		const tile = { x: 0, y: 0 } as Tile;
		map.getTile = () => tile;
		expect(gameMap().getTile(1, 2)).toBe(tile);
	});

	it("forwards getAllEntities to the map global", () => {
		const map = stubMap();
		const staff = [{ id: 1 } as unknown as Staff];
		map.getAllEntities = () => staff;
		expect(gameMap().getAllEntities("staff")).toBe(staff);
	});

	it("forwards getPathNavigator to the map global", () => {
		const map = stubMap();
		const navigator = { edges: 0 } as PathNavigator;
		map.getPathNavigator = () => navigator;
		expect(gameMap().getPathNavigator({ x: 1, y: 2, z: 3 })).toBe(navigator);
	});
});

describe("real GameContext delegate", () => {
	const stubContext = function stubContext(): NonNullable<TestGlobal["context"]> {
		return testGlobal.context as NonNullable<TestGlobal["context"]>;
	};

	it("forwards setTimeout/clearTimeout to the context global", () => {
		const callback = vi.fn();
		expect(gameContext().setTimeout(callback, 5)).toBe(1);
		gameContext().clearTimeout(1);
		// The stub's clearTimeout is a no-op; the delegate body is what's pinned.
		expect(callback).not.toHaveBeenCalled();
	});

	it("forwards executeAction to the context global", () => {
		const context = stubContext();
		const actions: unknown[] = [];
		context.executeAction = (action: string, args: object, cb) => {
			actions.push([action, args]);
			cb({});
		};
		let result: unknown = undefined;
		gameContext().executeAction("stafffire", { id: 3 }, (r) => {
			result = r;
		});
		expect(actions).toEqual([["stafffire", { id: 3 }]]);
		expect(result).toEqual({});
	});

	it("forwards subscribe to the context global and returns its disposable", () => {
		const context = stubContext();
		const disposable = { dispose: vi.fn() };
		context.subscribe = () => disposable;
		const got = gameContext().subscribe("action.execute", () => {
			/* noop */
		});
		expect(got).toBe(disposable);
	});

	it("forwards getSetting/setSetting to sharedStorage", () => {
		const context = stubContext();
		const calls: unknown[] = [];
		context.sharedStorage = {
			get: (key: string, fallback: unknown) => {
				calls.push(["get", key]);
				return fallback;
			},
			set: () => {
				/* noop */
			},
		};
		expect(gameContext().getSetting("k", 42)).toBe(42);
		context.sharedStorage = {
			get: () => {
				/* noop */
				return undefined;
			},
			set: (key: string) => {
				calls.push(["set", key]);
			},
		};
		gameContext().setSetting("k", 7);
		expect(calls).toEqual([
			["get", "k"],
			["set", "k"],
		]);
	});
});

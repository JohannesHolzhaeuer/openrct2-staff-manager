import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gameObjects, resetGameObjects } from "../src/game";

// The real GameObjects delegate forwards to the OpenRCT2 `objectManager`
// global. Every other test swaps in a fake via setGameObjects(), so the real
// delegate's forwarding bodies would otherwise never execute. Stub the global
// (as main.test.ts / ui.test.ts do for `map` / `context`) so the forwarding
// is exercised and the seam contract is pinned.
interface TestGlobal {
	objectManager?: {
		getAllObjects(type: "terrain_surface"): LoadedObject[];
		getObject(type: "small_scenery", index: number): SmallSceneryObject;
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
});

afterEach(() => {
	delete testGlobal.objectManager;
	resetGameObjects();
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

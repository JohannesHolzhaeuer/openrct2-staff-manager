/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setGameContext, resetGameContext, setGameMap, resetGameMap } from "../src/game";
import { FakeContext } from "./fake-context";
import { fakeMap } from "./fake-map";
import { handymenHiredStore, handymenAssignedStore, parkEntranceInfoStore } from "../src/store";

// ui.ts builds its window purely with openrct2-flexui widget factories. The
// real factories need a live OpenRCT2 `ui` global to actually render
// anything, which does not exist under test, so the module is stubbed with
// minimal passthroughs. `store`/`compute`/`isStore` are kept functionally
// real (not just stubs) because src/store.ts's actual stores - which
// openWindow() reads/writes via refreshHiredAndAssignedStaffCounts() etc. -
// are built from these same factories, and the mock applies to every importer
// of "openrct2-flexui" in this test's module graph, not just src/ui.ts.
// Only `window(...)` is asserted on (it is what openWindow() calls .open()
// on); every other widget factory just needs to not throw while
// staffManagerWindowTemplate() builds its widget tree.
const openedWindows: unknown[] = [];

// vi.mock factories are hoisted above the top of the file, so anything they
// close over must be defined via vi.hoisted rather than as a plain const.
const { STORE_MARKER, makeStore } = vi.hoisted(() => {
	const marker = Symbol("store");
	function make<T>(initial: T): { [k: symbol]: true; get(): T; set(value: T): void } {
		let value = initial;
		return {
			[marker]: true,
			get: (): T => value,
			set: (next: T): void => { value = next; }
		};
	}
	return { STORE_MARKER: marker, makeStore: make };
});

interface FakeStore<T> { [k: symbol]: true; get(): T; set(value: T): void }

vi.mock("openrct2-flexui", () => {
	const passthrough = (config: unknown): unknown => config;
	return {
		window: (config: unknown): { open: () => void } => ({
			open: (): void => {
				openedWindows.push(config);
			}
		}),
		box: passthrough,
		horizontal: passthrough,
		vertical: passthrough,
		label: passthrough,
		button: passthrough,
		spinner: passthrough,
		checkbox: passthrough,
		toggle: passthrough,
		graphics: passthrough,
		compute: (...args: unknown[]): unknown => {
			const stores = args.filter((a): a is FakeStore<unknown> => typeof a === "object" && a !== null && STORE_MARKER in a);
			const fn = args.find((a): a is (...values: unknown[]) => unknown => typeof a === "function");
			if (!fn) {
				throw new Error("compute() called without a combiner function");
			}
			return makeStore(fn(...stores.map(s => s.get())));
		},
		isStore: (value: unknown): boolean => typeof value === "object" && value !== null && STORE_MARKER in value,
		store: (value: unknown): FakeStore<unknown> => makeStore(value)
	};
});

interface TestGlobal { ui?: { width: number; height: number } }
const testGlobal = globalThis as unknown as TestGlobal;

let ctx: FakeContext;

beforeEach(() => {
	openedWindows.length = 0;
	testGlobal.ui = { width: 800, height: 600 };
	ctx = new FakeContext();
	setGameContext(ctx);
	setGameMap(fakeMap({ x: 1, y: 1 }));
});

afterEach(() => {
	delete testGlobal.ui;
	resetGameContext();
	resetGameMap();
	handymenHiredStore.set(0);
	handymenAssignedStore.set(0);
	parkEntranceInfoStore.set("");
});

describe("openWindow", () => {
	it("opens the staff manager window", async () => {
		const { openWindow } = await import("../src/ui");
		openWindow();
		expect(openedWindows.length).toBe(1);
	});

	it("refreshes hired/assigned staff counts", async () => {
		setGameMap(fakeMap({ x: 1, y: 1 }, {}, [], [
			{ id: 1, staffType: "handyman", patrolArea: { tiles: [{ x: 0, y: 0 }] } } as unknown as Staff
		]));

		const { openWindow } = await import("../src/ui");
		openWindow();

		expect(handymenHiredStore.get()).toBe(1);
		expect(handymenAssignedStore.get()).toBe(1);
	});

	it("reports the park entrance as not found when there is none on the map", async () => {
		const { openWindow } = await import("../src/ui");
		openWindow();

		expect(parkEntranceInfoStore.get()).not.toBe("");
	});
});

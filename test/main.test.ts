/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// main.ts registers the plugin as a side effect of being imported, and calls
// registerPlugin({ ... main: main }) at module scope. To exercise main()
// without a real game runtime, the OpenRCT2 globals it touches (registerPlugin,
// ui, initAuto's dependencies) are stubbed on globalThis before importing it.
interface TestGlobal {
	registerPlugin?: (metadata: { main: () => void }) => void;
	ui?: { registerMenuItem: (name: string, callback: () => void) => void };
	context?: {
		sharedStorage: { get: (key: string, fallback: unknown) => unknown; set: (key: string, value: unknown) => void };
		subscribe: (hook: string, callback: (event: unknown) => void) => { dispose: () => void };
		configuration: { get: (key: string, fallback: string) => string };
	};
}

const testGlobal = globalThis as unknown as TestGlobal;

let capturedMain: (() => void) | undefined;

beforeEach(() => {
	capturedMain = undefined;
	testGlobal.registerPlugin = (metadata: { main: () => void }): void => {
		capturedMain = metadata.main;
	};
	testGlobal.context = {
		sharedStorage: {
			get: (_key: string, fallback: unknown): unknown => fallback,
			set: (): void => { /* no-op */ }
		},
		subscribe: (): { dispose: () => void } => ({ dispose: (): void => { /* no-op */ } }),
		configuration: {
			get: (_key: string, fallback: string): string => fallback
		}
	};
});

afterEach(() => {
	delete testGlobal.registerPlugin;
	delete testGlobal.ui;
	delete testGlobal.context;
	vi.resetModules();
});

describe("main", () => {
	it("registers the plugin with a main entrypoint on import", async () => {
		await import("../src/main");
		expect(capturedMain).toBeTypeOf("function");
	});

	it("registers a menu item when the ui global is available", async () => {
		const registerMenuItem = vi.fn();
		testGlobal.ui = { registerMenuItem: registerMenuItem };

		await import("../src/main");
		capturedMain?.();

		expect(registerMenuItem).toHaveBeenCalledTimes(1);
		expect(registerMenuItem).toHaveBeenCalledWith("Staff Manager", expect.any(Function));
	});

	it("does not throw and skips menu registration when the ui global is unavailable", async () => {
		delete testGlobal.ui;

		await import("../src/main");
		expect(() => capturedMain?.()).not.toThrow();
	});
});

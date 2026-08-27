import { describe, it, expect } from "vitest";
import {
	DEFAULT_HANDYMEN_TILES_PER_STAFF,
	DEFAULT_HANDYMEN_MOWER_TILES_PER_STAFF,
	DEFAULT_GUARDS_TILES_PER_STAFF,
	DEFAULT_ENTERTAINERS_TILES_PER_STAFF,
	DEFAULT_ENTERTAINERS_PER_AREA,
	DEFAULT_ENTERTAINERS_INCLUDE_QUEUE,
	DEFAULT_HANDYMEN_ENABLED,
	DEFAULT_GUARDS_ENABLED,
	DEFAULT_ENTERTAINERS_ENABLED,
	DEFAULT_MECHANICS_ENABLED
} from "../src/config";

describe("config defaults", () => {
	it("handymen tiles per staff", () => { expect(DEFAULT_HANDYMEN_TILES_PER_STAFF).toBe(8); });
	it("handymen mower tiles per staff", () => { expect(DEFAULT_HANDYMEN_MOWER_TILES_PER_STAFF).toBe(256); });
	it("guards tiles per staff", () => { expect(DEFAULT_GUARDS_TILES_PER_STAFF).toBe(16); });
	it("entertainers tiles per staff", () => { expect(DEFAULT_ENTERTAINERS_TILES_PER_STAFF).toBe(16); });
	it("entertainers per area", () => { expect(DEFAULT_ENTERTAINERS_PER_AREA).toBe(2); });
	it("entertainers include queue", () => { expect(DEFAULT_ENTERTAINERS_INCLUDE_QUEUE).toBe(true); });
	it("all staff types enabled by default", () => {
		expect(DEFAULT_HANDYMEN_ENABLED).toBe(true);
		expect(DEFAULT_GUARDS_ENABLED).toBe(true);
		expect(DEFAULT_ENTERTAINERS_ENABLED).toBe(true);
		expect(DEFAULT_MECHANICS_ENABLED).toBe(true);
	});
});

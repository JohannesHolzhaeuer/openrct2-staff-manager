// Bundles the plugin into a single self-contained IIFE with esbuild, injecting
// the package.json `version` as STAFF_MANAGER_VERSION (declared in
// src/globals.d.ts) so the compiled plugin always reports the same version as
// the npm package instead of a value hardcoded in src/main.ts.
//
// Run with `node bundle.ts` for a one-off build, or `node bundle.ts --watch` for
// watch mode.
import * as fs from "node:fs";
import * as path from "node:path";
import { type BuildOptions, build, context } from "esbuild";

const root = import.meta.dirname;

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
	version: string;
};

const options: BuildOptions = {
	entryPoints: [path.join(root, "src", "main.ts")],
	bundle: true,
	outfile: path.join(root, "dist", "staff-manager.js"),
	format: "iife",
	target: "es2023",
	define: {
		STAFF_MANAGER_VERSION: JSON.stringify(pkg.version),
	},
};

if (process.argv.includes("--watch")) {
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
}

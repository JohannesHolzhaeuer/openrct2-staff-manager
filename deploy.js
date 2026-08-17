// Copies the compiled plugin into the local OpenRCT2 plugin folder so it can
// be picked up immediately (e.g. via OpenRCT2's plugin hot-reload).
//
// Override the destination with the OPENRCT2_PLUGIN_DIR environment variable
// if your OpenRCT2 user directory isn't in the default location.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SOURCE_FILE = path.join(__dirname, "dist", "staff-manager.js");

function defaultPluginDir() {
	const home = os.homedir();
	switch (process.platform) {
		case "win32":
			return path.join(home, "Documents", "OpenRCT2", "plugin");
		case "darwin":
			return path.join(home, "Library", "Application Support", "OpenRCT2", "plugin");
		default:
			return path.join(home, ".config", "OpenRCT2", "plugin");
	}
}

function main() {
	if (!fs.existsSync(SOURCE_FILE)) {
		console.error("Build output not found: " + SOURCE_FILE + " (run `tsc` first).");
		process.exit(1);
	}

	const pluginDir = process.env.OPENRCT2_PLUGIN_DIR || defaultPluginDir();
	const destFile = path.join(pluginDir, "staff-manager.js");

	fs.mkdirSync(pluginDir, { recursive: true });
	fs.copyFileSync(SOURCE_FILE, destFile);

	console.log("Deployed plugin to: " + destFile);
}

main();

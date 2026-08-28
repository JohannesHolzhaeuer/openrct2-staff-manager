// Copies the compiled plugin into the local OpenRCT2 plugin folder so it can
// be picked up immediately (e.g. via OpenRCT2's plugin hot-reload).
//
// Override the destination with the OPENRCT2_PLUGIN_DIR environment variable
// if your OpenRCT2 user directory isn't in the default location.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const SOURCE_FILE = path.join(import.meta.dirname, "dist", "staff-manager.js");

// On Windows, "Documents" can be redirected (e.g. by OneDrive) away from
// %USERPROFILE%\Documents. Ask the registry for the real "Personal" shell
// folder instead of assuming the default path.
function windowsDocumentsDir(): string {
	try {
		const output = execFileSync(
			"reg",
			["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "Personal"],
			{ encoding: "utf8" },
		);
		const match = /Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(output);
		if (match) {
			return path.normalize(match[1].trim().replace(/%USERPROFILE%/i, os.homedir()));
		}
	} catch {
		// Fall through to the default below.
	}
	return path.join(os.homedir(), "Documents");
}

function defaultPluginDir(): string {
	const home = os.homedir();
	switch (process.platform) {
		case "win32":
			return path.join(windowsDocumentsDir(), "OpenRCT2", "plugin");
		case "darwin":
			return path.join(home, "Library", "Application Support", "OpenRCT2", "plugin");
		default:
			return path.join(home, ".config", "OpenRCT2", "plugin");
	}
}

function main(): void {
	if (!fs.existsSync(SOURCE_FILE)) {
		console.error(`Build output not found: ${SOURCE_FILE} (run \`tsc\` first).`);
		process.exit(1);
	}

	const pluginDir = process.env.OPENRCT2_PLUGIN_DIR ?? defaultPluginDir();
	const destFile = path.join(pluginDir, "staff-manager.js");

	fs.mkdirSync(pluginDir, { recursive: true });
	fs.copyFileSync(SOURCE_FILE, destFile);

	console.log(`Deployed plugin to: ${destFile}`);
}

main();

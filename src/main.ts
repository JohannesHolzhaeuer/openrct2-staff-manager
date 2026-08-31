/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import { openWindow } from "./ui";

function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Manager", function () { openWindow(); });
	}
}

registerPlugin({
	name: "Staff Manager",
	version: "0.9.3",
	authors: ["Johannes Holzhäuer"],
	type: "local",
	licence: "MIT",
	minApiVersion: 34,
	targetApiVersion: 77,
	main: main
});

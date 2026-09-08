import { openWindow } from "./ui";
import { initAuto } from "./auto";

function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Manager", function () { openWindow(); });
	}
	initAuto();
}

registerPlugin({
	name: "Staff Manager",
	version: "0.10.0",
	authors: ["Johannes Holzhäuer"],
	type: "local",
	licence: "MIT",
	minApiVersion: 78,
	targetApiVersion: 78,
	main: main
});

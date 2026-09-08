import { initAuto } from "./auto";
import { openWindow } from "./ui";

function main(): void {
	if ("undefined" !== typeof ui) {
		ui.registerMenuItem("Staff Manager", function openStaffManagerWindow() {
			openWindow();
		});
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
	main: main,
});

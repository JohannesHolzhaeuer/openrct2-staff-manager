import { initAuto } from "./auto";
import { openWindow } from "./ui";

const main = function main(): void {
	if ("undefined" !== typeof ui) {
		ui.registerMenuItem("Staff Manager", function openStaffManagerWindow() {
			openWindow();
		});
	}
	initAuto();
};

registerPlugin({
	name: "Staff Manager",
	version: "0.14.2",
	authors: ["Johannes Holzhäuer"],
	type: "local",
	licence: "MIT",
	minApiVersion: 122,
	targetApiVersion: 124,
	main: main,
});

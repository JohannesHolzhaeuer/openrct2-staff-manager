/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle,
	store as flexStore, compute, isStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, Bindable,
	Scale
} from "openrct2-flexui";
/*****************************************************************************
 * Staff Assigner
 * ---------------------------------------------------------------------------
 * This is a from-scratch rebuild of the plugin's UI, based on the mockup in
 * ui-mockup.drawio. This version only lays out the window and widgets; it
 * does not implement any staff-management functionality yet.
 *
 * Author: Johannes
 * Licence: MIT
 *****************************************************************************/

// --- Staff calculation stores -------------------------------------------------
// The tile-counting/scanning logic and the patrol-area assignment logic have
// been removed and will be rebuilt from scratch. Needed is fixed at 0 for
// every staff type until that calculation is reintroduced.
const handymenNeededStore = flexStore<number>(0);
const guardsNeededStore = flexStore<number>(0);
const entertainersNeededStore = flexStore<number>(0);
const mechanicsNeededStore = flexStore<number>(0);

const handymenTilesPerStaffStore = flexStore<number>(8);
const handymenMowerTilesPerStaffStore = flexStore<number>(256);
const guardsTilesPerStaffStore = flexStore<number>(16);
const entertainersTilesPerStaffStore = flexStore<number>(16);
const entertainersPerAreaStore = flexStore<number>(1);
const entertainersIncludeQueueStore = flexStore<boolean>(true);

const handymenHiredStore = flexStore<number>(0);
const handymenAssignedStore = flexStore<number>(0);
const guardsHiredStore = flexStore<number>(0);
const guardsAssignedStore = flexStore<number>(0);
const entertainersHiredStore = flexStore<number>(0);
const entertainersAssignedStore = flexStore<number>(0);
const mechanicsHiredStore = flexStore<number>(0);
const mechanicsAssignedStore = flexStore<number>(0);

// Whether the tile counts have been calculated yet. Until this is true, all
// spinners and stat text within the staff group boxes are disabled.
const tilesCalculatedStore = flexStore<boolean>(false);
const staffControlsDisabledStore = compute(tilesCalculatedStore, function (calculated) { return !calculated; });

function computeNeeded(totalTiles: number, tilesPerStaff: number): number {
	if (tilesPerStaff <= 0 || totalTiles <= 0) {
		return 0;
	}
	return Math.ceil(totalTiles / tilesPerStaff);
}

// Refreshes the Hired/Assigned stores for Handymen, Guards and Mechanics from
// the current, real-time staff roster. Unlike Needed (which depends on the
// potentially slow tile scan), this is cheap and can be refreshed whenever
// Calculate is pressed.
function refreshHiredAndAssignedStaffCounts(): void {
	handymenHiredStore.set(countHiredStaff("handyman"));
	handymenAssignedStore.set(countAssignedStaff("handyman"));
	guardsHiredStore.set(countHiredStaff("security"));
	guardsAssignedStore.set(countAssignedStaff("security"));
	entertainersHiredStore.set(countHiredStaff("entertainer"));
	entertainersAssignedStore.set(countAssignedStaff("entertainer"));
	mechanicsHiredStore.set(countHiredStaff("mechanic"));
	mechanicsAssignedStore.set(countAssignedStaff("mechanic"));
}

// Counts the number of currently hired staff of a given type (e.g. handyman,
// security), and how many of those already have a non-empty patrol area
// (i.e. are already "assigned" to patrol a section of the park).
function countHiredStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (let i = 0; i < staff.length; i++) {
		if (staff[i].staffType === staffType) {
			count++;
		}
	}
	return count;
}

function countAssignedStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (let i = 0; i < staff.length; i++) {
		const member = staff[i];
		if (member.staffType === staffType && member.patrolArea.tiles.length > 0) {
			count++;
		}
	}
	return count;
}

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

function statRow(name: string, value: Bindable<number>, tooltip: string): WidgetCreator<FlexiblePosition> {
	const text = isStore(value) ? compute(value, String) : String(value);
	return horizontal({
		spacing: 4,
		height: STAT_ROW_HEIGHT,
		content: [
			label({ text: name, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip, disabled: staffControlsDisabledStore }),
			label({ text: text, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip, disabled: staffControlsDisabledStore })
		]
	});
}

function statTable(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>): Array<WidgetCreator<FlexiblePosition>> {
	const difference = (isStore(needed) || isStore(hired))
		? compute(
			isStore(needed) ? needed : flexStore(needed),
			isStore(hired) ? hired : flexStore(hired),
			function (n: number, h: number) { return n - h; })
		: (needed as number) - (hired as number);
	return [
		statRow("Needed", needed, "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each."),
		statRow("Hired", hired, "The number of staff of this type currently hired in the park."),
		statRow("Difference", difference, "Needed minus Hired: a positive number means staff of this type need to be hired, a negative number means staff can be fired.")
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: Store<number> | null, needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale, spinnerLabel?: string, mowerTilesPerStaff?: Store<number>, mowerSpinnerLabel?: string, spinnerTooltip?: string, onSettingsChanged?: () => void): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				...(tilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: spinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
						spinner({
							value: tilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: spinnerTooltip || "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed.",
							disabled: staffControlsDisabledStore,
							onChange: function (value) { tilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...(mowerTilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: mowerSpinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
						spinner({
							value: mowerTilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: "The number of gardening tiles (tiles that need mowing or watering) a single gardening-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many gardening handymen are Needed.",
							disabled: staffControlsDisabledStore,
							onChange: function (value) { mowerTilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...statTable(needed, hired, assigned)
			]
		})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(needed: Bindable<number>, hired: Bindable<number>, assigned: Bindable<number>, width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: "Entertainers",
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: "Tiles / Staff", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
							spinner({
								value: entertainersTilesPerStaffStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								disabled: staffControlsDisabledStore,
								onChange: function (value) { entertainersTilesPerStaffStore.set(value); }
							})
						]
					}),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: "Staff / Area", width: "2w", height: 14, padding: { top: 2 }, disabled: staffControlsDisabledStore }),
							spinner({
								value: entertainersPerAreaStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: "The number of entertainers to assign per patrol area.",
								disabled: staffControlsDisabledStore,
								onChange: function (value) { entertainersPerAreaStore.set(value); }
							})
						]
					}),
				toggle({ text: "Queue", width: "100%", height: 14, isPressed: entertainersIncludeQueueStore, disabled: staffControlsDisabledStore, onChange: function (isPressed) { entertainersIncludeQueueStore.set(isPressed); } }),
				...statTable(needed, hired, assigned)
			]
		})
	});
}

// --- Window ------------------------------------------------------------------
let windowTemplate: WindowTemplate | null = null;

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const BOX_TITLE_HEIGHT = 11; // height reserved for the box's own title label
const BOX_PADDING = 12; // 6px top + 6px bottom default box content padding
const GROUP_CONTENT_HEIGHT = 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // spinner row + spacing + 3 stat rows + spacing between them
const GROUP_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + GROUP_CONTENT_HEIGHT;
const MECHANICS_CONTENT_HEIGHT = (STAT_ROW_HEIGHT * 3) + (3 * 2); // no spinner row: just 3 stat rows + spacing between them
const MECHANICS_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + MECHANICS_CONTENT_HEIGHT;
const HANDYMEN_EXTRA_HEIGHT = 14 + 3; // extra "Mower" spinner row + spacing
const HANDYMEN_HEIGHT = GROUP_HEIGHT + HANDYMEN_EXTRA_HEIGHT;
const ENTERTAINERS_EXTRA_HEIGHT = 14 + 3 + 14 + 3; // extra "Entertainers per area" spinner row + "Queue" toggle row + spacing
const ENTERTAINERS_HEIGHT = GROUP_HEIGHT + ENTERTAINERS_EXTRA_HEIGHT;
const STACK_HEIGHT = HANDYMEN_HEIGHT + GROUP_HEIGHT + 4; // Handymen + Guards groups + spacing
const MECHANICS_ENTERTAINERS_STACK_HEIGHT = MECHANICS_HEIGHT + ENTERTAINERS_HEIGHT + 4;
const COLUMN_ROW_HEIGHT = Math.max(STACK_HEIGHT, MECHANICS_ENTERTAINERS_STACK_HEIGHT);

const TOP_ROW_HEIGHT = 14;
const APPLY_MESSAGE_ROW_HEIGHT = 14;
const APPLY_ROW_HEIGHT = 20;
const CONTENT_SPACING = 4; // spacing between the window's top-level content rows
const WINDOW_CHROME_HEIGHT = 29; // title bar + top/bottom window padding
const WINDOW_HEIGHT = TOP_ROW_HEIGHT + CONTENT_SPACING + COLUMN_ROW_HEIGHT + CONTENT_SPACING + APPLY_MESSAGE_ROW_HEIGHT + CONTENT_SPACING + APPLY_ROW_HEIGHT + WINDOW_CHROME_HEIGHT;

function staffAssignerWindowTemplate(): WindowTemplate {
	if (!windowTemplate) {
		const windowWidth = 400;
		windowTemplate = flexWindow({
			title: "Staff Assigner",
			width: windowWidth,
			height: WINDOW_HEIGHT,
			x: Math.round((ui.width - windowWidth) / 2),
			y: Math.round((ui.height - WINDOW_HEIGHT) / 2),
			spacing: 4,
			content: [
				label({ text: "Press Calculate to scan the park.", width: "100%", height: 14 }),
				horizontal({
					spacing: 6,
					height: COLUMN_ROW_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
									staffGroup("Handymen", handymenTilesPerStaffStore, handymenNeededStore, handymenHiredStore, handymenAssignedStore, "100%", HANDYMEN_HEIGHT, "Cleanup", handymenMowerTilesPerStaffStore, "Gardening", "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed."),
											staffGroup("Guards", guardsTilesPerStaffStore, guardsNeededStore, guardsHiredStore, guardsAssignedStore, "100%", GROUP_HEIGHT, "Tiles / Staff", undefined, undefined, "The number of plain pathway tiles (excluding queue tiles) a single guard is expected to patrol (tiles per staff). Used to calculate how many guards are Needed.")
										]
									}),
								vertical({
									spacing: 4,
									width: GROUP_WIDTH,
									height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
									content: [
											staffGroup("Mechanics", null, mechanicsNeededStore, mechanicsHiredStore, mechanicsAssignedStore, "100%", MECHANICS_HEIGHT),
											entertainersGroup(entertainersNeededStore, entertainersHiredStore, entertainersAssignedStore, "100%", ENTERTAINERS_HEIGHT)
								]
						})
					]
				}),
				label({ text: "", width: "100%", height: APPLY_MESSAGE_ROW_HEIGHT, alignment: "centred" }),
				button({
					text: "Apply", width: "100%", height: 20, disabled: true, onClick: function () { }
				})
			]
		});
	}
	return windowTemplate;
}

function openWindow(): void {
	staffAssignerWindowTemplate().open();
	refreshHiredAndAssignedStaffCounts();
}

// --- Main --------------------------------------------------------------------
function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Assigner", function () { openWindow(); });
	}
}

registerPlugin({
	name: "Staff Assigner",
	version: "1.0.0",
	authors: ["Johannes"],
	type: "local",
	licence: "MIT",
	minApiVersion: 34,
	targetApiVersion: 77,
	main: main
});

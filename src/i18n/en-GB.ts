import { Translations } from "./types";

// Canonical/fallback dictionary. Every other language must implement the
// exact same shape (Translations), so the compiler catches missing keys.
export const enGB: Translations = {
	"window.title": "Staff Manager",
	"menu.title": "Staff Manager",

	"parkEntrance.notFound": "Park entrance: not found.",
	"parkEntrance.summary": "Path tiles: {0}, Queue tiles: {1}, Garden tiles: {2}",
	"parkEntrance.tooltip": "Summary of the most recent map scan: reachable pathway, queue and garden tile counts, refreshed by Adjust staff count/Assign.",

	"applyMessage.tooltip": "Reserved for status messages after Adjust staff count/Assign.",

	"button.adjustStaffCount": "Adjust staff count",
	"button.adjustStaffCount.tooltip": "Hire or fire staff of every enabled type to match the calculated Needed counts (hires when understaffed, fires oldest-first when overstaffed).",
	"button.assign": "Assign",
	"button.assign.tooltip": "Rebuild patrol areas from the most recently scanned tiles and teleport each staff member to the start of their new area.",

	"staffGroup.enabled": "Enabled",
	"staffGroup.enabledTooltip": "Whether this staff type is managed by Adjust staff count and Assign. Unticking excludes it entirely from both actions.",
	"staffGroup.handymen.title": "Handymen",
	"staffGroup.guards.title": "Guards",
	"staffGroup.mechanics.title": "Mechanics",
	"staffGroup.entertainers.title": "Entertainers",
	"staffGroup.entertainers.enabledTooltip": "Whether entertainers are managed by Adjust staff count and Assign. Unticking excludes them entirely from both actions.",

	"spinnerLabel.cleanup": "Cleanup",
	"spinnerLabel.gardening": "Gardening",
	"spinnerLabel.tilesPerStaff": "Tiles / Staff",
	"spinnerLabel.staffPerArea": "Staff / Area",
	"checkbox.queue": "Queue",

	"tooltip.handymenCleanupSpinner": "The number of pathway/queue tiles a single cleanup-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many cleanup handymen are Needed.",
	"tooltip.handymenGardeningSpinner": "The number of gardening tiles (tiles that need mowing or watering) a single gardening-assigned handyman is expected to patrol (tiles per staff). Used to calculate how many gardening handymen are Needed.",
	"tooltip.guardsSpinner": "The number of plain pathway tiles (excluding queue tiles) a single guard is expected to patrol (tiles per staff). Used to calculate how many guards are Needed.",
	"tooltip.entertainersTilesSpinner": "The number of pathway (and, if the Queue checkbox is on, queue) tiles a single entertainer is expected to patrol (tiles per staff). Used to calculate how many entertainers are Needed.",
	"tooltip.entertainersPerAreaSpinner": "The number of entertainers to assign per patrol area; more than 1 makes areas overlap so the tiles-per-staff density is preserved.",
	"tooltip.entertainersQueueCheckbox": "Whether entertainers also patrol ride queue tiles, in addition to plain pathway tiles.",

	"statRow.hired": "Hired",
	"statRow.hired.tooltip": "The number of staff of this type currently hired in the park.",
	"statRow.needed": "Needed",
	"statRow.needed.tooltip": "The number of staff of this type needed to patrol the reachable pathway network, assuming the network is split into consecutive (contiguous) sections of \"tiles per staff\" tiles each.",
	"statRow.difference": "Difference",
	"statRow.difference.tooltip": "Needed minus Hired: a positive number means staff of this type need to be hired, a negative number means staff can be fired."
};

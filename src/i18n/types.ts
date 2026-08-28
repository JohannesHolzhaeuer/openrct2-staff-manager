// Shape of a single language's translation dictionary. Every language file
// (en-GB.ts, de-DE.ts, ...) must provide a value for every key here; the
// TypeScript compiler enforces completeness, so a missing/misspelled key in
// a translation file fails the build instead of silently falling back at
// runtime.
export interface Translations {
	"window.title": string;
	"menu.title": string;

	"parkEntrance.notFound": string;
	"parkEntrance.summary": string;
	"parkEntrance.tooltip": string;

	"applyMessage.tooltip": string;

	"status.assigningHandymen": string;
	"status.assigningGuards": string;
	"status.assigningEntertainers": string;
	"status.assigningMechanics": string;
	"status.adjusting": string;

	"button.adjustAndAssign": string;
	"button.adjustAndAssign.tooltip": string;

	"staffGroup.enabled": string;
	"staffGroup.enabledTooltip": string;
	"staffGroup.handymen.title": string;
	"staffGroup.guards.title": string;
	"staffGroup.mechanics.title": string;
	"staffGroup.entertainers.title": string;
	"staffGroup.entertainers.enabledTooltip": string;

	"spinnerLabel.cleanup": string;
	"spinnerLabel.gardening": string;
	"spinnerLabel.tilesPerStaff": string;
	"spinnerLabel.staffPerArea": string;
	"checkbox.queue": string;

	"tooltip.handymenCleanupSpinner": string;
	"tooltip.handymenGardeningSpinner": string;
	"tooltip.guardsSpinner": string;
	"tooltip.entertainersTilesSpinner": string;
	"tooltip.entertainersPerAreaSpinner": string;
	"tooltip.entertainersQueueCheckbox": string;

	"statRow.hired": string;
	"statRow.hired.tooltip": string;
	"statRow.needed": string;
	"statRow.needed.tooltip": string;
	"statRow.difference": string;
	"statRow.difference.tooltip": string;
}

export type TranslationKey = keyof Translations;

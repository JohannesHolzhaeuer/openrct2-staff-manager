/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, checkbox,
	store as flexStore, compute, isStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, WritableStore, Bindable,
	Scale
} from "openrct2-flexui";
import { t } from "./i18n";
import {
	parkEntranceInfoStore,
	handymenTilesPerStaffStore, handymenMowerTilesPerStaffStore,
	guardsTilesPerStaffStore, entertainersTilesPerStaffStore, entertainersPerAreaStore, entertainersIncludeQueueStore,
	handymenEnabledStore, guardsEnabledStore, entertainersEnabledStore, mechanicsEnabledStore,
	handymenNeededStore, handymenHiredStore,
	guardsNeededStore, guardsHiredStore,
	entertainersNeededStore, entertainersHiredStore,
	mechanicsNeededStore, mechanicsHiredStore,
	handymenControlsDisabledStore, guardsControlsDisabledStore, entertainersControlsDisabledStore, mechanicsControlsDisabledStore,
	staffControlsDisabledStore, adjustButtonDisabledStore
} from "./store";
import { scanFootpathNetwork, findAndReportParkEntrance } from "./scan";import { adjustStaffCounts, assignStaff, refreshHiredAndAssignedStaffCounts } from "./staff";

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

function statRow(name: string, value: Bindable<number>, tooltip: string, disabled: Bindable<boolean>, colorToken?: Bindable<string>): WidgetCreator<FlexiblePosition> {
	const text = isStore(value) ? compute(value, String) : String(value);
	const nameText = colorToken
		? (isStore(colorToken) ? compute(colorToken, function (token: string) { return token + name; }) : colorToken + name)
		: name;
	const valueText = colorToken
		? (isStore(colorToken) && isStore(text)
			? compute(colorToken, text, function (token: string, t: string) { return token + t; })
			: (isStore(text) ? compute(text, function (t: string) { return (colorToken as string) + t; }) : (colorToken as string) + text))
		: text;
	return horizontal({
		spacing: 4,
		height: STAT_ROW_HEIGHT,
		content: [
			label({ text: nameText, width: "1w", height: STAT_ROW_HEIGHT, tooltip: tooltip, disabled: disabled }),
			label({ text: valueText, width: "1w", height: STAT_ROW_HEIGHT, alignment: "centred", tooltip: tooltip, disabled: disabled })
		]
	});
}

function statTable(needed: Bindable<number>, hired: Bindable<number>, disabled: Bindable<boolean>): Array<WidgetCreator<FlexiblePosition>> {
	const difference = (isStore(needed) || isStore(hired))
		? compute(
			isStore(needed) ? needed : flexStore(needed),
			isStore(hired) ? hired : flexStore(hired),
			function (n: number, h: number) { return n - h; })
		: (needed as number) - (hired as number);
	// The colour token forces a text colour that would otherwise override the
	// greyed-out appearance a label gets from being disabled, so use no colour
	// override at all (empty prefix) whenever the row is disabled.
	const differenceColorToken: Bindable<string> = (isStore(difference) || isStore(disabled))
		? compute(
			isStore(difference) ? difference : flexStore(difference),
			isStore(disabled) ? disabled : flexStore(disabled),
			function (d: number, isDisabled: boolean) {
				return isDisabled ? "" : (d > 0 ? "{GREEN}" : d < 0 ? "{RED}" : "{BLACK}");
			})
		: (difference > 0 ? "{GREEN}" : difference < 0 ? "{RED}" : "{BLACK}");
	return [
		statRow(t("statRow.hired"), hired, t("statRow.hired.tooltip"), disabled),
		statRow(t("statRow.needed"), needed, t("statRow.needed.tooltip"), disabled),
		statRow(t("statRow.difference"), difference, t("statRow.difference.tooltip"), disabled, differenceColorToken)
	];
}

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, tilesPerStaff: WritableStore<number> | null, needed: Bindable<number>, hired: Bindable<number>, width: Scale, height: Scale, enabled: WritableStore<boolean>, controlsDisabled: Store<boolean>, spinnerLabel?: string, mowerTilesPerStaff?: WritableStore<number>, mowerSpinnerLabel?: string, spinnerTooltip?: string, onSettingsChanged?: () => void): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({ text: t("staffGroup.enabled"), width: "100%", height: 14, isChecked: enabled, disabled: staffControlsDisabledStore, tooltip: t("staffGroup.enabledTooltip"), onChange: function (isChecked) { enabled.set(isChecked); } }),
				...(tilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: spinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, tooltip: spinnerTooltip || t("tooltip.handymenCleanupSpinner"), disabled: controlsDisabled }),
						spinner({
							value: tilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: spinnerTooltip || t("tooltip.handymenCleanupSpinner"),
							disabled: controlsDisabled,
							onChange: function (value) { tilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
				})] : []),
				...(mowerTilesPerStaff ? [horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({ text: mowerSpinnerLabel || "", width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.handymenGardeningSpinner"), disabled: controlsDisabled }),
						spinner({
							value: mowerTilesPerStaff,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: t("tooltip.handymenGardeningSpinner"),
							disabled: controlsDisabled,
							onChange: function (value) { mowerTilesPerStaff.set(value); if (onSettingsChanged) { onSettingsChanged(); } }
						})
					]
						})] : []),
						...statTable(needed, hired, controlsDisabled)
					]
				})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(needed: Bindable<number>, hired: Bindable<number>, width: Scale, height: Scale, enabled: WritableStore<boolean>, controlsDisabled: Store<boolean>): WidgetCreator<FlexiblePosition> {
	return box({
		text: t("staffGroup.entertainers.title"),
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({ text: t("staffGroup.enabled"), width: "100%", height: 14, isChecked: enabled, disabled: staffControlsDisabledStore, tooltip: t("staffGroup.entertainers.enabledTooltip"), onChange: function (isChecked) { enabled.set(isChecked); } }),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: t("spinnerLabel.tilesPerStaff"), width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.entertainersTilesSpinner"), disabled: controlsDisabled }),
							spinner({
								value: entertainersTilesPerStaffStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: t("tooltip.entertainersTilesSpinner"),
								disabled: controlsDisabled,
								onChange: function (value) { entertainersTilesPerStaffStore.set(value); }
							})
						]
					}),
				horizontal({
						spacing: 4,
						height: 14,
						content: [
							label({ text: t("spinnerLabel.staffPerArea"), width: "2w", height: 14, padding: { top: 2 }, tooltip: t("tooltip.entertainersPerAreaSpinner"), disabled: controlsDisabled }),
							spinner({
								value: entertainersPerAreaStore,
								minimum: 0,
								maximum: 999,
								width: "3w",
								height: 14,
								tooltip: t("tooltip.entertainersPerAreaSpinner"),
								disabled: controlsDisabled,
								onChange: function (value) { entertainersPerAreaStore.set(value); }
							})
						]
					}),
				checkbox({ text: t("checkbox.queue"), width: "100%", height: 14, isChecked: entertainersIncludeQueueStore, disabled: controlsDisabled, tooltip: t("tooltip.entertainersQueueCheckbox"), onChange: function (isChecked) { entertainersIncludeQueueStore.set(isChecked); } }),
						...statTable(needed, hired, controlsDisabled)
					]
				})
	});
}

// --- Window ------------------------------------------------------------------
// Not cached: the template embeds plain (non-reactive) translated strings
// for titles/labels/tooltips, so it must be rebuilt on every call in order
// to pick up an in-game UI language change the next time the window opens.

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const BOX_TITLE_HEIGHT = 11; // height reserved for the box's own title label
const BOX_PADDING = 12; // 6px top + 6px bottom default box content padding
const GROUP_CONTENT_HEIGHT = 14 + 3 + 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // enabled toggle row + spacing + spinner row + spacing + 3 stat rows + spacing between them
const GROUP_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + GROUP_CONTENT_HEIGHT;
const MECHANICS_CONTENT_HEIGHT = 14 + 3 + (STAT_ROW_HEIGHT * 3) + (3 * 2); // enabled toggle row + spacing + 3 stat rows + spacing between them
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

function staffManagerWindowTemplate(): WindowTemplate {
	const windowWidth = 400;
	return flexWindow({
			title: t("window.title"),
			width: windowWidth,
			height: WINDOW_HEIGHT,
			position: { x: Math.round((ui.width - windowWidth) / 2), y: Math.round((ui.height - WINDOW_HEIGHT) / 2) },
			spacing: 4,
			content: [
				label({ text: parkEntranceInfoStore, width: "100%", height: 14, tooltip: t("parkEntrance.tooltip") }),
				horizontal({
					spacing: 6,
					height: COLUMN_ROW_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
									staffGroup(t("staffGroup.handymen.title"), handymenTilesPerStaffStore, handymenNeededStore, handymenHiredStore, "100%", HANDYMEN_HEIGHT, handymenEnabledStore, handymenControlsDisabledStore, t("spinnerLabel.cleanup"), handymenMowerTilesPerStaffStore, t("spinnerLabel.gardening"), t("tooltip.handymenCleanupSpinner")),
											staffGroup(t("staffGroup.guards.title"), guardsTilesPerStaffStore, guardsNeededStore, guardsHiredStore, "100%", GROUP_HEIGHT, guardsEnabledStore, guardsControlsDisabledStore, t("spinnerLabel.tilesPerStaff"), undefined, undefined, t("tooltip.guardsSpinner"))
										]
									}),
								vertical({
									spacing: 4,
									width: GROUP_WIDTH,
									height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
									content: [
											staffGroup(t("staffGroup.mechanics.title"), null, mechanicsNeededStore, mechanicsHiredStore, "100%", MECHANICS_HEIGHT, mechanicsEnabledStore, mechanicsControlsDisabledStore),
											entertainersGroup(entertainersNeededStore, entertainersHiredStore, "100%", ENTERTAINERS_HEIGHT, entertainersEnabledStore, entertainersControlsDisabledStore)
								]
						})
					]
				}),
				label({ text: "", width: "100%", height: APPLY_MESSAGE_ROW_HEIGHT, alignment: "centred", tooltip: t("applyMessage.tooltip") }),
				horizontal({
					spacing: 4,
					width: "100%",
					height: APPLY_ROW_HEIGHT,
					content: [
						button({
							text: t("button.adjustStaffCount"), width: "50%", height: APPLY_ROW_HEIGHT, tooltip: t("button.adjustStaffCount.tooltip"), disabled: adjustButtonDisabledStore, onClick: function () { adjustStaffCounts(); }
						}),
						button({
							text: t("button.assign"), width: "50%", height: APPLY_ROW_HEIGHT, tooltip: t("button.assign.tooltip"), disabled: staffControlsDisabledStore, onClick: function () { assignStaff(); }
						})
					]
				})
			]
	});
}

export function openWindow(): void {
	staffManagerWindowTemplate().open();
	refreshHiredAndAssignedStaffCounts();
	findAndReportParkEntrance();
	scanFootpathNetwork();
}

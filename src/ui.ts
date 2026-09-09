import {
	type Bindable,
	Colour,
	type FlexiblePosition,
	type Scale,
	type Store,
	type WidgetCreator,
	type WindowTemplate,
	type WritableStore,
	box,
	button,
	checkbox,
	compute,
	store as flexStore,
	window as flexWindow,
	graphics,
	horizontal,
	isStore,
	label,
	spinner,
	toggle,
	vertical,
} from "openrct2-flexui";
import { adjustStaffCounts, assignStaff, refreshHiredAndAssignedStaffCounts } from "./staff";
import {
	autoEnabledStore,
	entertainersControlsDisabledStore,
	entertainersEnabledStore,
	entertainersHiredStore,
	entertainersIncludeQueueStore,
	entertainersNeededStore,
	entertainersPerAreaStore,
	entertainersTilesPerStaffStore,
	gardenTilesCountStore,
	guardsControlsDisabledStore,
	guardsEnabledStore,
	guardsHiredStore,
	guardsNeededStore,
	guardsTilesPerStaffStore,
	handymenControlsDisabledStore,
	handymenEnabledStore,
	handymenHiredStore,
	handymenMowerTilesPerStaffStore,
	handymenNeededStore,
	handymenTilesPerStaffStore,
	hasRanAdjustAndAssignStore,
	mechanicsControlsDisabledStore,
	mechanicsEnabledStore,
	mechanicsHiredStore,
	mechanicsNeededStore,
	ownedTilesCountStore,
	parkEntranceInfoStore,
	pathTilesCountStore,
	progressStore,
	queueTilesCountStore,
	rideExitCountStore,
	staffControlsDisabledStore,
	statusTextStore,
} from "./store";
import { findAndReportParkEntrance, scanFootpathNetwork } from "./scan";
import { setAutoEnabled } from "./auto";
import { t } from "./i18n";

// --- Staff stat table ---------------------------------------------------------
// A single row of the per-staff-type table: a left-aligned name and a
// right-aligned value, e.g. "Needed        nnn".
const STAT_ROW_HEIGHT = 12;

const coloredText = function coloredText(
	colorToken: Bindable<string> | undefined,
	text: Bindable<string>,
): Bindable<string> {
	if (!colorToken) {
		return text;
	}
	if (isStore(colorToken) && isStore(text)) {
		return compute(colorToken, text, function combineTokenAndText(token: string, t: string) {
			return token + t;
		});
	}
	if (isStore(colorToken)) {
		return compute(colorToken, function prependToken(token: string) {
			return token + (text as string);
		});
	}
	if (isStore(text)) {
		return compute(text, function appendToToken(t: string) {
			return colorToken + t;
		});
	}
	return colorToken + text;
};

const textOf = function textOf(value: Bindable<number>): Bindable<string> {
	if (isStore(value)) {
		return compute(value, String);
	}
	return String(value);
};

const statRow = function statRow(options: {
	name: string;
	value: Bindable<number>;
	tooltip: string;
	disabled: Bindable<boolean>;
	colorToken?: Bindable<string>;
}): WidgetCreator<FlexiblePosition> {
	const { name, value, tooltip, disabled, colorToken } = options;
	const text = textOf(value);
	const nameText = coloredText(colorToken, name);
	const valueText = coloredText(colorToken, text);
	return horizontal({
		spacing: 4,
		height: STAT_ROW_HEIGHT,
		content: [
			label({
				text: nameText,
				width: "1w",
				height: STAT_ROW_HEIGHT,
				tooltip: tooltip,
				disabled: disabled,
			}),
			label({
				text: valueText,
				width: "1w",
				height: STAT_ROW_HEIGHT,
				alignment: "centred",
				tooltip: tooltip,
				disabled: disabled,
			}),
		],
	});
};

const differenceColor = function differenceColor(d: number): string {
	if (0 < d) {
		return "{GREEN}";
	}
	if (0 > d) {
		return "{RED}";
	}
	return "{BLACK}";
};

const toStore = function toStore<T>(value: Bindable<T>): Store<T> {
	if (isStore(value)) {
		return value;
	}
	return flexStore(value);
};

const computeDifference = function computeDifference(
	needed: Bindable<number>,
	hired: Bindable<number>,
): Bindable<number> {
	if (isStore(needed) || isStore(hired)) {
		return compute(
			toStore(needed),
			toStore(hired),
			function subtractHiredFromNeeded(n: number, h: number) {
				return n - h;
			},
		);
	}
	return needed - hired;
};

const computeDifferenceColorToken = function computeDifferenceColorToken(
	difference: Bindable<number>,
	disabled: Bindable<boolean>,
): Bindable<string> {
	if (isStore(difference) || isStore(disabled)) {
		return compute(
			toStore(difference),
			toStore(disabled),
			function differenceColorTokenFor(d: number, isDisabled: boolean) {
				if (isDisabled) {
					return "";
				}
				return differenceColor(d);
			},
		);
	}
	return differenceColor(difference);
};

const statTable = function statTable(
	needed: Bindable<number>,
	hired: Bindable<number>,
	disabled: Bindable<boolean>,
): WidgetCreator<FlexiblePosition>[] {
	const difference = computeDifference(needed, hired);
	// The colour token forces a text colour that would otherwise override the
	// greyed-out appearance a label gets from being disabled, so use no colour
	// override at all (empty prefix) whenever the row is disabled.
	const differenceColorToken = computeDifferenceColorToken(difference, disabled);
	return [
		statRow({
			name: t("statRow.hired"),
			value: hired,
			tooltip: t("statRow.hired.tooltip"),
			disabled: disabled,
		}),
		statRow({
			name: t("statRow.needed"),
			value: needed,
			tooltip: t("statRow.needed.tooltip"),
			disabled: disabled,
		}),
		statRow({
			name: t("statRow.difference"),
			value: difference,
			tooltip: t("statRow.difference.tooltip"),
			disabled: disabled,
			colorToken: differenceColorToken,
		}),
	];
};

// --- Park entrance tile-count table -------------------------------------------
// One cell of the top status table: a left-aligned name and a right-aligned
// count, stacked vertically, e.g. "Paths" over "12". Three cells make up each
// of the two rows so all six values (path/queue/garden/ride exits/owned
// tiles) line up into a compact aligned table instead of one free-form string.
const PARK_ENTRANCE_CELL_HEIGHT = 24;

const parkEntranceStatCell = function parkEntranceStatCell(
	name: string,
	value: Bindable<number>,
): WidgetCreator<FlexiblePosition> {
	const valueText = textOf(value);
	return vertical({
		spacing: 0,
		width: "1w",
		height: PARK_ENTRANCE_CELL_HEIGHT,
		content: [
			label({ text: name, width: "100%", height: 12, tooltip: t("parkEntrance.tooltip") }),
			label({
				text: valueText,
				width: "100%",
				height: 12,
				alignment: "centred",
				tooltip: t("parkEntrance.tooltip"),
			}),
		],
	});
};

// A small decorative icon shown to the left of a section. It is a border-less
// button without a click handler, because that is the only widget that can
// render one of the game's named icon sprites.
const SECTION_ICON_SIZE = 24;

const sectionIcon = function sectionIcon(
	image: IconName,
	tooltip: string,
	rowHeight: number,
): WidgetCreator<FlexiblePosition> {
	return vertical({
		spacing: 0,
		width: SECTION_ICON_SIZE,
		height: rowHeight,
		content: [
			button({
				image: image,
				width: SECTION_ICON_SIZE,
				height: SECTION_ICON_SIZE,
				border: false,
				tooltip: tooltip,
			}),
		],
	});
};

const parkEntranceStatTable = function parkEntranceStatTable(): WidgetCreator<FlexiblePosition> {
	return horizontal({
		spacing: 4,
		width: "100%",
		height: TOP_ROW_HEIGHT,
		content: [
			sectionIcon("map", t("parkEntrance.tooltip"), TOP_ROW_HEIGHT),
			vertical({
				spacing: 2,
				width: "1w",
				height: TOP_ROW_HEIGHT,
				content: [
					horizontal({
						spacing: 6,
						height: PARK_ENTRANCE_CELL_HEIGHT,
						content: [
							parkEntranceStatCell(t("parkEntrance.paths"), pathTilesCountStore),
							parkEntranceStatCell(t("parkEntrance.queues"), queueTilesCountStore),
							parkEntranceStatCell(t("parkEntrance.garden"), gardenTilesCountStore),
						],
					}),
					horizontal({
						spacing: 6,
						height: PARK_ENTRANCE_CELL_HEIGHT,
						content: [
							parkEntranceStatCell(t("parkEntrance.rideExits"), rideExitCountStore),
							parkEntranceStatCell(t("parkEntrance.ownedTiles"), ownedTilesCountStore),
							label({
								text: parkEntranceInfoStore,
								width: "1w",
								height: PARK_ENTRANCE_CELL_HEIGHT,
								tooltip: t("parkEntrance.tooltip"),
							}),
						],
					}),
				],
			}),
		],
	});
};

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, a Needed/Hired/
// Assigned/Difference stat table, apply and reset buttons. Mirrors the
// marginRect groups in the mockup (Handymen, Guards, Mechanics).
const tilesPerStaffRow = function tilesPerStaffRow(options: {
	tilesPerStaff: WritableStore<number> | undefined;
	spinnerLabel: string | undefined;
	spinnerTooltip: string | undefined;
	controlsDisabled: Store<boolean>;
	onSettingsChanged: (() => void) | undefined;
}): WidgetCreator<FlexiblePosition>[] {
	const { tilesPerStaff, spinnerLabel, spinnerTooltip, controlsDisabled, onSettingsChanged } =
		options;
	if (!tilesPerStaff) {
		return [];
	}
	return [
		horizontal({
			spacing: 4,
			height: 14,
			content: [
				label({
					text: spinnerLabel ?? "",
					width: "2w",
					height: 14,
					padding: { top: 2 },
					tooltip: spinnerTooltip ?? t("tooltip.handymenCleanupSpinner"),
					disabled: controlsDisabled,
				}),
				spinner({
					value: tilesPerStaff,
					minimum: 0,
					maximum: 999,
					width: "3w",
					height: 14,
					tooltip: spinnerTooltip ?? t("tooltip.handymenCleanupSpinner"),
					disabled: controlsDisabled,
					onChange: function onChange(value) {
						tilesPerStaff.set(value);
						if (onSettingsChanged) {
							onSettingsChanged();
						}
					},
				}),
			],
		}),
	];
};

const mowerTilesPerStaffRow = function mowerTilesPerStaffRow(options: {
	mowerTilesPerStaff: WritableStore<number> | undefined;
	mowerSpinnerLabel: string | undefined;
	controlsDisabled: Store<boolean>;
	onSettingsChanged: (() => void) | undefined;
}): WidgetCreator<FlexiblePosition>[] {
	const { mowerTilesPerStaff, mowerSpinnerLabel, controlsDisabled, onSettingsChanged } = options;
	if (!mowerTilesPerStaff) {
		return [];
	}
	return [
		horizontal({
			spacing: 4,
			height: 14,
			content: [
				label({
					text: mowerSpinnerLabel ?? "",
					width: "2w",
					height: 14,
					padding: { top: 2 },
					tooltip: t("tooltip.handymenGardeningSpinner"),
					disabled: controlsDisabled,
				}),
				spinner({
					value: mowerTilesPerStaff,
					minimum: 0,
					maximum: 999,
					width: "3w",
					height: 14,
					tooltip: t("tooltip.handymenGardeningSpinner"),
					disabled: controlsDisabled,
					onChange: function onChange(value) {
						mowerTilesPerStaff.set(value);
						if (onSettingsChanged) {
							onSettingsChanged();
						}
					},
				}),
			],
		}),
	];
};

const staffGroup = function staffGroup(options: {
	title: string;
	tilesPerStaff: WritableStore<number> | undefined;
	needed: Bindable<number>;
	hired: Bindable<number>;
	width: Scale;
	height: Scale;
	enabled: WritableStore<boolean>;
	controlsDisabled: Store<boolean>;
	spinnerLabel?: string;
	mowerTilesPerStaff?: WritableStore<number>;
	mowerSpinnerLabel?: string;
	spinnerTooltip?: string;
	onSettingsChanged?: () => void;
}): WidgetCreator<FlexiblePosition> {
	const {
		title,
		tilesPerStaff,
		needed,
		hired,
		width,
		height,
		enabled,
		controlsDisabled,
		spinnerLabel,
		mowerTilesPerStaff,
		mowerSpinnerLabel,
		spinnerTooltip,
		onSettingsChanged,
	} = options;
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({
					text: t("staffGroup.enabled"),
					width: "100%",
					height: 14,
					isChecked: enabled,
					disabled: staffControlsDisabledStore,
					tooltip: t("staffGroup.enabledTooltip"),
					onChange: function onChange(isChecked) {
						enabled.set(isChecked);
					},
				}),
				...tilesPerStaffRow({
					tilesPerStaff,
					spinnerLabel,
					spinnerTooltip,
					controlsDisabled,
					onSettingsChanged,
				}),
				...mowerTilesPerStaffRow({
					mowerTilesPerStaff,
					mowerSpinnerLabel,
					controlsDisabled,
					onSettingsChanged,
				}),
				...statTable(needed, hired, controlsDisabled),
			],
		}),
	});
};

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
const entertainersGroup = function entertainersGroup(options: {
	needed: Bindable<number>;
	hired: Bindable<number>;
	width: Scale;
	height: Scale;
	enabled: WritableStore<boolean>;
	controlsDisabled: Store<boolean>;
}): WidgetCreator<FlexiblePosition> {
	const { needed, hired, width, height, enabled, controlsDisabled } = options;
	return box({
		text: t("staffGroup.entertainers.title"),
		width: width,
		height: height,
		content: vertical({
			spacing: 3,
			content: [
				checkbox({
					text: t("staffGroup.enabled"),
					width: "100%",
					height: 14,
					isChecked: enabled,
					disabled: staffControlsDisabledStore,
					tooltip: t("staffGroup.entertainers.enabledTooltip"),
					onChange: function onChange(isChecked) {
						enabled.set(isChecked);
					},
				}),
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({
							text: t("spinnerLabel.tilesPerStaff"),
							width: "2w",
							height: 14,
							padding: { top: 2 },
							tooltip: t("tooltip.entertainersTilesSpinner"),
							disabled: controlsDisabled,
						}),
						spinner({
							value: entertainersTilesPerStaffStore,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: t("tooltip.entertainersTilesSpinner"),
							disabled: controlsDisabled,
							onChange: function onChange(value) {
								entertainersTilesPerStaffStore.set(value);
							},
						}),
					],
				}),
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						label({
							text: t("spinnerLabel.staffPerArea"),
							width: "2w",
							height: 14,
							padding: { top: 2 },
							tooltip: t("tooltip.entertainersPerAreaSpinner"),
							disabled: controlsDisabled,
						}),
						spinner({
							value: entertainersPerAreaStore,
							minimum: 0,
							maximum: 999,
							width: "3w",
							height: 14,
							tooltip: t("tooltip.entertainersPerAreaSpinner"),
							disabled: controlsDisabled,
							onChange: function onChange(value) {
								entertainersPerAreaStore.set(value);
							},
						}),
					],
				}),
				checkbox({
					text: t("checkbox.queue"),
					width: "100%",
					height: 14,
					isChecked: entertainersIncludeQueueStore,
					disabled: controlsDisabled,
					tooltip: t("tooltip.entertainersQueueCheckbox"),
					onChange: function onChange(isChecked) {
						entertainersIncludeQueueStore.set(isChecked);
					},
				}),
				...statTable(needed, hired, controlsDisabled),
			],
		}),
	});
};

// --- Window ------------------------------------------------------------------
// Not cached: the template embeds plain (non-reactive) translated strings
// for titles/labels/tooltips, so it must be rebuilt on every call in order
// to pick up an in-game UI language change the next time the window opens.

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const BOX_TITLE_HEIGHT = 11; // height reserved for the box's own title label
const BOX_PADDING = 12; // 6px top + 6px bottom default box content padding
const GROUP_CONTENT_HEIGHT = 14 + 3 + 14 + 3 + STAT_ROW_HEIGHT * 3 + 3 * 2; // enabled toggle row + spacing + spinner row + spacing + 3 stat rows + spacing between them
const GROUP_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + GROUP_CONTENT_HEIGHT;
const MECHANICS_CONTENT_HEIGHT = 14 + 3 + STAT_ROW_HEIGHT * 3 + 3 * 2; // enabled toggle row + spacing + 3 stat rows + spacing between them
const MECHANICS_HEIGHT = BOX_TITLE_HEIGHT + BOX_PADDING + MECHANICS_CONTENT_HEIGHT;
const HANDYMEN_EXTRA_HEIGHT = 14 + 3; // extra "Mower" spinner row + spacing
const HANDYMEN_HEIGHT = GROUP_HEIGHT + HANDYMEN_EXTRA_HEIGHT;
const ENTERTAINERS_EXTRA_HEIGHT = 14 + 3 + 14 + 3; // extra "Entertainers per area" spinner row + "Queue" toggle row + spacing
const ENTERTAINERS_HEIGHT = GROUP_HEIGHT + ENTERTAINERS_EXTRA_HEIGHT;
const STACK_HEIGHT = HANDYMEN_HEIGHT + GROUP_HEIGHT + 4; // Handymen + Guards groups + spacing
const MECHANICS_ENTERTAINERS_STACK_HEIGHT = MECHANICS_HEIGHT + ENTERTAINERS_HEIGHT + 4;
const COLUMN_ROW_HEIGHT = Math.max(STACK_HEIGHT, MECHANICS_ENTERTAINERS_STACK_HEIGHT);

const TOP_ROW_HEIGHT = 50;
const AUTO_ROW_HEIGHT = 20;
const PROGRESS_ROW_HEIGHT = 10;
const APPLY_MESSAGE_ROW_HEIGHT = 14;
const APPLY_ROW_HEIGHT = 20;
const CONTENT_SPACING = 4; // spacing between the window's top-level content rows
const SEPARATOR_ROW_HEIGHT = 4; // horizontal divider between the window's sections
const SEPARATOR_COUNT = 2; // statistics | configuration | progress and buttons
const ACTIONS_ROW_HEIGHT =
	PROGRESS_ROW_HEIGHT +
	CONTENT_SPACING +
	APPLY_MESSAGE_ROW_HEIGHT +
	CONTENT_SPACING +
	APPLY_ROW_HEIGHT +
	CONTENT_SPACING +
	AUTO_ROW_HEIGHT;
const WINDOW_CHROME_HEIGHT = 29; // title bar + top/bottom window padding
const WINDOW_HEIGHT =
	TOP_ROW_HEIGHT +
	CONTENT_SPACING +
	AUTO_ROW_HEIGHT +
	CONTENT_SPACING +
	COLUMN_ROW_HEIGHT +
	CONTENT_SPACING +
	PROGRESS_ROW_HEIGHT +
	CONTENT_SPACING +
	APPLY_MESSAGE_ROW_HEIGHT +
	CONTENT_SPACING +
	APPLY_ROW_HEIGHT +
	SEPARATOR_COUNT * (SEPARATOR_ROW_HEIGHT + CONTENT_SPACING) +
	WINDOW_CHROME_HEIGHT;

// A thin engraved divider drawn across the full window width.
const separator = function separator(): WidgetCreator<FlexiblePosition> {
	return graphics({
		width: "100%",
		height: SEPARATOR_ROW_HEIGHT,
		onDraw: function onDraw(g) {
			g.well(0, 1, g.width, 2);
		},
	});
};

// Tooltip shared by both halves of the progress bar, so hovering anywhere over
// the bar shows the same percentage.
const progressTooltipStore = compute(progressStore, function progressTooltip(fraction: number) {
	return `${t("progress.tooltip")} (${Math.round(Math.max(0, Math.min(1, fraction)) * 100).toString()}%)`;
});

// The progress bar is drawn as a row of equally sized segments. Each segment
// has its own store telling it whether it is part of the completed portion, so
// segments never resize - they only switch between "filled" and "empty".
const PROGRESS_SEGMENT_COUNT = 40;
const progressSegmentStores: Store<boolean>[] = [];
for (let i = 0; i < PROGRESS_SEGMENT_COUNT; i++) {
	const threshold = (i + 1) / PROGRESS_SEGMENT_COUNT;
	progressSegmentStores.push(
		compute(progressStore, function isSegmentFilled(fraction: number) {
			return fraction >= threshold;
		}),
	);
}

const staffManagerWindowTemplate = function staffManagerWindowTemplate(): WindowTemplate {
	const windowWidth = 430; // 400 + room for the section icon column on the left
	return flexWindow({
		title: t("window.title"),
		width: windowWidth,
		height: WINDOW_HEIGHT,
		position: {
			x: Math.round((ui.width - windowWidth) / 2),
			y: Math.round((ui.height - WINDOW_HEIGHT) / 2),
		},
		spacing: 4,
		content: [
			parkEntranceStatTable(),
			separator(),
			horizontal({
				spacing: 6,
				height: COLUMN_ROW_HEIGHT,
				content: [
					sectionIcon("patrol", t("window.title"), COLUMN_ROW_HEIGHT),
					vertical({
						spacing: 4,
						width: GROUP_WIDTH,
						height: STACK_HEIGHT,
						content: [
							staffGroup({
								title: t("staffGroup.handymen.title"),
								tilesPerStaff: handymenTilesPerStaffStore,
								needed: handymenNeededStore,
								hired: handymenHiredStore,
								width: "100%",
								height: HANDYMEN_HEIGHT,
								enabled: handymenEnabledStore,
								controlsDisabled: handymenControlsDisabledStore,
								spinnerLabel: t("spinnerLabel.cleanup"),
								mowerTilesPerStaff: handymenMowerTilesPerStaffStore,
								mowerSpinnerLabel: t("spinnerLabel.gardening"),
								spinnerTooltip: t("tooltip.handymenCleanupSpinner"),
							}),
							staffGroup({
								title: t("staffGroup.guards.title"),
								tilesPerStaff: guardsTilesPerStaffStore,
								needed: guardsNeededStore,
								hired: guardsHiredStore,
								width: "100%",
								height: GROUP_HEIGHT,
								enabled: guardsEnabledStore,
								controlsDisabled: guardsControlsDisabledStore,
								spinnerLabel: t("spinnerLabel.tilesPerStaff"),
								spinnerTooltip: t("tooltip.guardsSpinner"),
							}),
						],
					}),
					vertical({
						spacing: 4,
						width: GROUP_WIDTH,
						height: MECHANICS_ENTERTAINERS_STACK_HEIGHT,
						content: [
							staffGroup({
								title: t("staffGroup.mechanics.title"),
								tilesPerStaff: undefined,
								needed: mechanicsNeededStore,
								hired: mechanicsHiredStore,
								width: "100%",
								height: MECHANICS_HEIGHT,
								enabled: mechanicsEnabledStore,
								controlsDisabled: mechanicsControlsDisabledStore,
							}),
							entertainersGroup({
								needed: entertainersNeededStore,
								hired: entertainersHiredStore,
								width: "100%",
								height: ENTERTAINERS_HEIGHT,
								enabled: entertainersEnabledStore,
								controlsDisabled: entertainersControlsDisabledStore,
							}),
						],
					}),
				],
			}),
			separator(),
			// Progress bar. Variable-width widgets did not work: neither a single
			// custom-drawn widget nor two weight-bound halves were reliably
			// re-laid out / repainted when the progress store changed, so the
			// bar kept showing a stale width. Instead the bar is a fixed grid of
			// equally sized segments; each segment never changes size and is
			// either completely filled or completely empty, driven by its own
			// bound store. That keeps every repaint correct regardless of how
			// the engine batches invalidations.
			horizontal({
				spacing: 4,
				width: "100%",
				height: ACTIONS_ROW_HEIGHT,
				content: [
					sectionIcon("cheats", t("button.adjustAndAssign.tooltip"), ACTIONS_ROW_HEIGHT),
					vertical({
						spacing: CONTENT_SPACING,
						width: "1w",
						height: ACTIONS_ROW_HEIGHT,
						content: [
							horizontal({
								spacing: 0,
								width: "100%",
								height: PROGRESS_ROW_HEIGHT,
								content: progressSegmentStores.map(function progressSegment(segmentFilledStore) {
									// The tooltip is bound per segment on purpose: it is what makes
									// flexui refresh this widget (and therefore call onDraw) when
									// the segment flips between filled and empty.
									return graphics({
										width: "1w",
										height: PROGRESS_ROW_HEIGHT,
										tooltip: compute(
											progressTooltipStore,
											segmentFilledStore,
											function identityTooltip(tooltip: string) {
												return tooltip;
											},
										),
										onDraw: function onDraw(g) {
											if (segmentFilledStore.get()) {
												g.colour = Colour.BrightGreen;
												g.box(0, 0, g.width, g.height);
											} else {
												g.well(0, 0, g.width, g.height);
											}
										},
									});
								}),
							}),
							label({
								text: statusTextStore,
								width: "100%",
								height: APPLY_MESSAGE_ROW_HEIGHT,
								alignment: "centred",
								tooltip: t("applyMessage.tooltip"),
							}),
							horizontal({
								spacing: 4,
								width: "100%",
								height: APPLY_ROW_HEIGHT,
								content: [
									button({
										text: t("button.adjustAndAssign"),
										width: "100%",
										height: APPLY_ROW_HEIGHT,
										tooltip: t("button.adjustAndAssign.tooltip"),
										onClick: function onClick() {
											hasRanAdjustAndAssignStore.set(true);
											progressStore.set(0);
											statusTextStore.set("");
											adjustStaffCounts(assignStaff);
										},
									}),
								],
							}),
							horizontal({
								spacing: 4,
								width: "100%",
								height: AUTO_ROW_HEIGHT,
								content: [
									graphics({
										width: AUTO_ROW_HEIGHT,
										height: AUTO_ROW_HEIGHT,
										onDraw: function onDraw(g) {
											if (autoEnabledStore.get()) {
												g.colour = Colour.BrightGreen;
											} else {
												g.colour = Colour.SaturatedRed;
											}
											g.box(2, 2, AUTO_ROW_HEIGHT - 4, AUTO_ROW_HEIGHT - 4);
										},
									}),
									toggle({
										text: compute(autoEnabledStore, function autoToggleText(on) {
											if (on) {
												return t("auto.on");
											}
											return t("auto.off");
										}),
										width: "1w",
										height: AUTO_ROW_HEIGHT,
										isPressed: autoEnabledStore,
										tooltip: t("auto.tooltip"),
										disabled: compute(
											hasRanAdjustAndAssignStore,
											function autoToggleDisabled(hasRun) {
												return !hasRun;
											},
										),
										onChange: function onChange(pressed) {
											setAutoEnabled(pressed);
										},
									}),
								],
							}),
						],
					}),
				],
			}),
		],
	});
};

export const openWindow = function openWindow(): void {
	staffManagerWindowTemplate().open();
	refreshHiredAndAssignedStaffCounts();
	findAndReportParkEntrance();
	scanFootpathNetwork();
};

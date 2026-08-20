/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle,
	store as flexStore, WindowTemplate, WidgetCreator, FlexiblePosition, Store, ElementVisibility,
	BuildOutput, Layoutable, WidgetMap, Rectangle, ElementParams, Scale
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

// --- Custom progress bar widget ---------------------------------------------
// A filled-rectangle progress bar drawn with a "custom" widget's onDraw
// callback (see GraphicsContext in @openrct2/types). This renders an actual
// bar instead of simulating one with text characters.
const PROGRESS_BAR_BORDER_COLOUR = 12; // dark grey well border
const PROGRESS_BAR_FILL_COLOUR = 30;   // bright blue fill
let progressBarNameCounter = 0;

function progressBar(percentStore: Store<number>, width: Scale, height: Scale, visibility?: Store<ElementVisibility>): WidgetCreator<FlexiblePosition> {
	let pct = Math.max(0, Math.min(100, percentStore.get()));
	const name = "progressbar" + (progressBarNameCounter++);
	const params: ElementParams & FlexiblePosition = { visibility: visibility, width: width, height: height };
	return {
		params: params,
		create: function (output: BuildOutput): Layoutable {
			const widget = {
				type: "custom",
				name: name,
				x: 0, y: 0, width: 0, height: 0,
				onDraw: function (g: GraphicsContext): void {
					const w = g.width, h = g.height;
					g.colour = PROGRESS_BAR_BORDER_COLOUR;
					g.well(0, 0, w, h);
					const inset = 1;
					const innerW = Math.max(0, w - inset * 2);
					const innerH = Math.max(0, h - inset * 2);
					const filledW = Math.round((innerW * pct) / 100);
					if (filledW > 0) {
						g.colour = PROGRESS_BAR_FILL_COLOUR;
						g.rect(inset, inset, filledW, innerH);
					}
				}
			} as unknown as Widget;
			output.add(widget);
			output.binder.add(widget, "isVisible", visibility, function (v) { return v === "visible"; });
			output.binder.on(percentStore, function (value: number) {
				pct = Math.max(0, Math.min(100, value));
			});
			return {
				layout: function (widgets: WidgetMap, area: Rectangle): void {
					const w = widgets[name];
					w.x = Math.round(area.x);
					w.y = Math.round(area.y);
					w.width = Math.round(area.width);
					w.height = Math.round(area.height);
				}
			};
		}
	};
}

// --- Static placeholder stores (mockup values, no functionality yet) -------
const capacityProgressStore = flexStore<number>(80);

// --- Staff group widget ------------------------------------------------------
// One bordered box per staff type: title, count spinner, "current/target"
// text, apply and reset buttons. Mirrors the marginRect groups in the
// mockup (Handymen, Guards, Mechanics).
function staffGroup(title: string, count: number, ratioText: string, width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: title,
		width: width,
		height: height,
		content: vertical({
			spacing: 4,
			content: [
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						spinner({ value: count, minimum: 0, maximum: 999, width: "5w", height: 14 }),
						label({ text: ratioText, width: "8w", height: 14, alignment: "centred" })
					]
				}),
				horizontal({
					spacing: 4,
					height: 16,
					content: [
						button({ text: "apply", width: "11w", height: 16 }),
						button({ text: "reset", width: "10w", height: 16 })
					]
				})
			]
		})
	});
}

// One bordered box for entertainers: same as staffGroup plus a "Queue"
// toggle underneath, laid out vertically like in the mockup.
function entertainersGroup(width: Scale, height: Scale): WidgetCreator<FlexiblePosition> {
	return box({
		text: "Entertainers",
		width: width,
		height: height,
		content: vertical({
			spacing: 4,
			content: [
				horizontal({
					spacing: 4,
					height: 14,
					content: [
						spinner({ value: 16, minimum: 0, maximum: 999, width: "5w", height: 14 }),
						label({ text: "160 / 150", width: "8w", height: 14, alignment: "centred" })
					]
				}),
				toggle({ text: "Queue", width: "100%", height: 12 }),
				horizontal({
					spacing: 4,
					height: 16,
					content: [
						button({ text: "apply", width: "11w", height: 16 }),
						button({ text: "reset", width: "10w", height: 16 })
					]
				})
			]
		})
	});
}

// --- Window ------------------------------------------------------------------
let windowTemplate: WindowTemplate | null = null;

const GROUP_WIDTH: Scale = "1w"; // each column takes an equal share of the available width
const GROUP_HEIGHT = 48;
const STACK_HEIGHT = GROUP_HEIGHT * 2 + 4; // two stacked groups + spacing

function staffAssignerWindowTemplate(): WindowTemplate {
	if (!windowTemplate) {
		windowTemplate = flexWindow({
			title: "Staff Assigner",
			width: 420,
			height: 180,
			minWidth: 420,
			minHeight: 180,
			spacing: 4,
			content: [
				horizontal({
					spacing: 6,
					height: 30,
					content: [
						button({ text: "Calculate", width: 70, height: 30 }),
							vertical({
								spacing: 2,
								width: "1w",
								height: 30,
								content: [
									progressBar(capacityProgressStore, "100%", 14),
									label({ text: "500 path / 100 queue / 80 exits", width: "100%", height: 12 })
								]
							})
					]
				}),
				horizontal({
					spacing: 6,
					height: STACK_HEIGHT,
					content: [
						vertical({
							spacing: 4,
							width: GROUP_WIDTH,
							height: STACK_HEIGHT,
							content: [
								staffGroup("Handymen", 8, "160 / 150", "100%", GROUP_HEIGHT),
								staffGroup("Guards", 16, "160 / 150", "100%", GROUP_HEIGHT)
							]
						}),
						entertainersGroup(GROUP_WIDTH, STACK_HEIGHT),
						staffGroup("Mechanics", 4, "160 / 150", GROUP_WIDTH, STACK_HEIGHT)
					]
				})
			]
		});
	}
	return windowTemplate;
}

function openWindow(): void {
	staffAssignerWindowTemplate().open();
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

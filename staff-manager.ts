/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle, dropdown,
	store as flexStore, compute as flexCompute, WindowTemplate, WidgetCreator, FlexiblePosition, Store, ElementVisibility,
	BuildOutput, Layoutable, WidgetMap, Rectangle, ElementParams
} from "openrct2-flexui";
/*****************************************************************************
 * Staff Manager
 * ---------------------------------------------------------------------------
 * Manages park staff by patrol area:
 *   - HANDYMEN, SECURITY, MASCOTS (entertainers): split the park's paths into
 *     equal contiguous areas (mascots optionally into overlapping areas with
 *     several mascots each).
 *   - MECHANICS: assign to ride exits (one per exit, patrolling the 3 paths before the exit) + inspection.
 *
 * If an assignment needs more staff than are available, a dialog offers to
 * hire the missing staff. Path counting only considers footpaths reachable
 * from the park entrance AND on owned land. One shared, chunked (non-blocking)
 * map scan feeds all path staff.
 *
 * Author: Johannes
 * Licence: MIT
 *****************************************************************************/

const TILE = 32;
const RIDE_SETTING_INSPECTION_INTERVAL = 5;

const INSPECTION_LABELS = ["10 min", "20 min", "30 min", "45 min",
							"60 min", "2 hours", "Never"];

const NS = "AutoMechanic";
const HANDYMAN_ORDER_MOWING = 8;
const OWNERSHIP_OWNED = 0x20;

type StaffKind = "handyman" | "mechanic" | "security" | "entertainer";

// staffhire staffType numbers and default orders per type.
const STAFF_TYPE_NUM: { [kind in StaffKind]: number } = { handyman: 0, mechanic: 1, security: 2, entertainer: 3 };

// Singular/plural display names per staff type (correct grammar in dialogs).
const STAFF_WORD: { [kind in StaffKind]: { one: string, many: string } } = {
	handyman:    { one: "handyman",  many: "handymen"  },
	mechanic:    { one: "mechanic",  many: "mechanics" },
	security:    { one: "guard",     many: "guards"    },
	entertainer: { one: "entertainer", many: "entertainers" }
};
// Grammatically correct "<n> handyman/handymen" etc.
function staffWord(kind: StaffKind, n: number): string {
	const w = STAFF_WORD[kind];
	return n + " " + (n === 1 ? w.one : w.many);
}

interface AssignCounts {
	fresh: number;
	moved: number;
}

// Track a peep's assigned spot. Returns "new" (first time we assign it),
// "moved" (assigned somewhere different than before) or "same".
// `counts` (optional) accumulates { fresh, moved } for a summary message.
function recordAssignment(lastArea: { [peepId: number]: string }, peepId: number, cx: number, cy: number, counts?: AssignCounts): string {
	const keyNow = cx + ":" + cy;
	const prev = lastArea[peepId];
	lastArea[peepId] = keyNow;
	let res: string;
	if (prev === undefined) { res = "new"; }
	else if (prev !== keyNow) { res = "moved"; }
	else { res = "same"; }
	if (counts) {
		if (res === "new") { counts.fresh++; }
		else if (res === "moved") { counts.moved++; }
	}
	return res;
}

// Build a human summary fragment like "4 assigned, 2 reassigned".
function assignSummary(counts: AssignCounts): string {
	const parts: string[] = [];
	parts.push(counts.fresh + " assigned");
	if (counts.moved > 0) { parts.push(counts.moved + " reassigned"); }
	return parts.join(", ");
}
// handyman 7 = sweep(1)+water(2)+bins(4), no mowing(8) -> stays "assignable".
// mechanic 3 = inspect(2)+fix(1).
const STAFF_ORDERS: { [kind in StaffKind]: number } = { handyman: 7, mechanic: 3, security: 0, entertainer: 0 };

// Staff-type icon, resolved via the official named-icon API (context.getIcon)
// instead of a hardcoded raw sprite index, which was unreliable and showed up
// as a broken/incorrect icon in the GUI. Resolved lazily (not at module load
// time) since `context` is only guaranteed to be ready once the plugin's
// main() has been invoked by the host.
//
// NOTE: The plugin scripting API only exposes a small, fixed set of named
// icons (see `IconName` in @openrct2/types) and does not expose the native
// game's staff-tab sprites (handyman/security/entertainer/mechanic mascots).
// "patrol" (footprints) is therefore not usable to distinguish staff types;
// the closest thematically-distinct icons available are used instead.
let staffSpriteCache: { [kind in StaffKind]: number } | null = null;
function staffSprite(kind: StaffKind): number {
	if (!staffSpriteCache) {
		staffSpriteCache = {
			handyman: context.getIcon("paintbrush"), security: context.getIcon("no_entry"),
			entertainer: context.getIcon("music"), mechanic: context.getIcon("mechanic")
		};
	}
	return staffSpriteCache[kind];
}

// Draws a sprite directly (no button chrome) centred within the given area.
function makeIconWidget(width: number, height: number, sprite: number, tooltip: string, visibility?: Store<ElementVisibility>): WidgetCreator<FlexiblePosition> {
	return button({ image: sprite, border: false, width: width, height: height, tooltip: tooltip, visibility: visibility });
}

const DIR_DELTA = [
	{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }
];

const SCAN_ROWS_PER_TICK = 6;
const ACTIONS_PER_TICK = 20;

// --- Storage ---------------------------------------------------------------
function store(): Configuration { return context.getParkStorage(NS); }
function getInspection(): number { return store().get("inspection", 2); }
function setInspection(v: number): void { store().set("inspection", v); }
// Assign every staff type now (mechanics + all path-staff kinds), each
// offering to hire/fire as needed via their usual confirmation dialogs.
function assignAllNow(): void {
	const steps: ((next: () => void) => void)[] = [];
	PATH_KINDS.forEach(function (pk) {
		steps.push(function (next) { assignPathStaff(pk.kind, pk.nice, next); });
	});
	steps.push(function (next) { assignMechanicsWithHire(next); });
	runStepsWithProgress(steps);
}

// Reset every staff type's assignments (mechanics + all path-staff kinds).
function resetAllStaffWithProgress(): void {
	const steps: ((next: () => void) => void)[] = [];
	PATH_KINDS.forEach(function (pk) {
		steps.push(function (next) { resetStaffType(pk.kind); next(); });
	});
	steps.push(function (next) { resetStaffType("mechanic"); next(); });
	runStepsWithProgress(steps);
}

// Assign/Reset for whichever tab is currently active.
function assignActiveTab(): void {
	const kind = tabIndexToKind(activeTabStore.get());
	if (kind === null) {
		// Mechanics tab.
		runStepsWithProgress([function (next) { assignMechanicsWithHire(next); }]);
		return;
	}
	const pk = PATH_KINDS.filter(function (p) { return p.kind === kind; })[0];
	runStepsWithProgress([function (next) { assignPathStaff(pk.kind, pk.nice, next); }]);
}

function resetActiveTab(): void {
	const kind = tabIndexToKind(activeTabStore.get()) || "mechanic";
	const nice = kind === "mechanic" ? "mechanics" : STAFF_WORD[kind].many;
	confirm2Dialog([
		"Clear all patrol area assignments for " + nice + "?",
		"No staff will be hired or fired."
	], "Reset " + nice, function () {
		runStepsWithProgress([function (next) { resetStaffType(kind); next(); }]);
	});
}

function resetAllStaffConfirm(): void {
	confirm2Dialog([
		"Clear all patrol area assignments for every staff type?",
		"No staff will be hired or fired."
	], "Reset all", function () {
		resetAllStaffWithProgress();
	});
}
function getAssignments(): { [key: string]: number } { return store().get("assignments", {}); }
function setAssignments(v: { [key: string]: number }): void { store().set("assignments", v); }
function getPer(kind: StaffKind): number { return store().get("per_" + kind, defaultPer(kind)); }
function setPer(kind: StaffKind, v: number): void { store().set("per_" + kind, v); }
// Default path tiles per staff, by kind (used the first time a setting is read).
function defaultPer(kind: StaffKind): number {
	switch (kind) {
		case "handyman": return 8;
		case "security": return 16;
		default: return 25;
	}
}
// Last-assigned area centre per peep id, to detect reassignment ("moved").
function getLastArea(): { [peepId: number]: string } { return store().get("lastArea", {}); }
function setLastArea(v: { [peepId: number]: string }): void { store().set("lastArea", v); }
// Mascot options:
//  - queue tiles per mascot (max) : density when assigning to queue lines
//  - path tiles per mascot        : density when assigning to general paths
//  - mascots per area             : how many mascots share each area (>1 = overlap)
function getMascotQueuePer(): number { return store().get("mascotQueuePer", 4); }
function setMascotQueuePer(v: number): void { store().set("mascotQueuePer", v); }
function getMascotPathPer(): number { return store().get("mascotPathPer", 16); }
function setMascotPathPer(v: number): void { store().set("mascotPathPer", v); }
function getMascotPerArea(): number { return store().get("mascotPerArea", 2); }
function setMascotPerArea(v: number): void { store().set("mascotPerArea", v); }
// Assign mascots to QUEUE lines instead of general paths.
function getMascotQueues(): boolean { return store().get("mascotQueues", false); }
function setMascotQueues(v: boolean): void { store().set("mascotQueues", v); }

// Active "tiles per mascot" for the current mascot mode (queue vs path).
function mascotTilesPer(): number {
	return Math.max(1, getMascotQueues() ? getMascotQueuePer() : getMascotPathPer());
}

// --- Async helper ----------------------------------------------------------
let busy = false;

function forEachAsync<T>(items: T[], perTick: number, doItem: (item: T, index: number) => void, onDone?: () => void): void {
	if (!items.length) { if (onDone) { onDone(); } return; }
	let i = 0;
	function step(): void {
		const end = Math.min(i + perTick, items.length);
		for (; i < end; i++) { doItem(items[i], i); }
		if (i < items.length) { context.setTimeout(step, 1); }
		else if (onDone) { onDone(); }
	}
	step();
}

// --- Staff helpers ---------------------------------------------------------
function isRide(ride: Ride): boolean { return !!ride && ride.classification === "ride"; }

function stationExit(ride: Ride | null, i: number): CoordsXY | null {
	if (!ride || !ride.stations || i < 0 || i >= ride.stations.length) { return null; }
	const st = ride.stations[i];
	if (st && st.exit && st.exit.x !== null && st.exit.x >= 0) {
		return { x: st.exit.x, y: st.exit.y };
	}
	return null;
}

function exitKey(rideId: number, s: number): string { return rideId + ":" + s; }
function keyRideId(k: string): number { return Number(k.split(":")[0]); }
function keyStation(k: string): number { return Number(k.split(":")[1]); }

interface ExitInfo {
	key: string;
	exit: CoordsXY;
}

function allExits(): ExitInfo[] {
	const out: ExitInfo[] = [];
	map.rides.forEach(function (ride) {
		if (!isRide(ride) || !ride.stations) { return; }
		for (let i = 0; i < ride.stations.length; i++) {
			const exit = stationExit(ride, i);
			if (exit) { out.push({ key: exitKey(ride.id, i), exit: exit }); }
		}
	});
	return out;
}

function allStaffOfType(kind: StaffKind): Staff[] {
	const list: Staff[] = [];
	const scan = function (arr: Entity[]): void {
		for (let i = 0; i < arr.length; i++) {
			const s = arr[i] as Staff;
			if (s && s.type === "staff" && s.staffType === kind) { list.push(s); }
		}
	};
	try { scan(map.getAllEntities("staff")); }
	catch (e) { try { scan(map.getAllEntities("peep") as unknown as Entity[]); } catch (e2) { /* ignore */ } }
	return list;
}
function allMechanics(): Staff[] { return allStaffOfType("mechanic"); }

function handymanMows(s: Staff): boolean {
	return (typeof s.orders === "number") && ((s.orders & HANDYMAN_ORDER_MOWING) !== 0);
}

// Path staff we may manage. Handymen exclude grass-mowers.
function assignableOfKind(kind: StaffKind): Staff[] {
	const all = allStaffOfType(kind);
	if (kind === "handyman") {
		return all.filter(function (s) { return !handymanMows(s); });
	}
	return all;
}

// Heuristic: a mechanic actively inspecting/fixing stands on a ride tile.
function mechanicIsBusy(mech: Staff | null): boolean {
	if (!mech) { return false; }
	try {
		const tx = Math.floor(mech.x / TILE);
		const ty = Math.floor(mech.y / TILE);
		const tile = map.getTile(tx, ty);
		if (!tile) { return false; }
		for (let i = 0; i < tile.numElements; i++) {
			const el = tile.getElement(i);
			if (!el) { continue; }
			if (el.type === "track") { return true; }
			if (el.type === "entrance") {
				const ee = el as EntranceElement;
				if (ee.ride !== null && ee.ride !== undefined) { return true; }
			}
		}
	} catch (e) { /* ignore */ }
	return false;
}

function mechanicById(id: number): Staff | null {
	const e = map.getEntity(id);
	return (e && e.type === "staff" && (e as Staff).staffType === "mechanic") ? (e as Staff) : null;
}

// Footpath edges (bitmask) of the tile at the given coordinate, or 0 if none.
function tileEdges(tx: number, ty: number): { edges: number; z: number } | null {
	const tile = map.getTile(tx, ty);
	for (let i = 0; i < tile.numElements; i++) {
		const el = tile.getElement(i);
		if (el && el.type === "footpath" && !el.isGhost) {
			const fp = el as FootpathElement;
			return { edges: (typeof fp.edges === "number") ? fp.edges : 15, z: fp.baseZ };
		}
	}
	return null;
}

// Mechanics patrol the exit tile plus the 3 connected footpath tiles leading
// up to it (a short line of path `before` the exit), instead of a 4x4 block
// right next to the exit.
function patrolExitPath(exit: CoordsXY): CoordsXY[] {
	const tiles: CoordsXY[] = [];
	const tx0 = Math.floor(exit.x / TILE), ty0 = Math.floor(exit.y / TILE);
	tiles.push({ x: tx0 * TILE, y: ty0 * TILE });
	const startInfo = tileEdges(tx0, ty0);
	if (!startInfo) { return tiles; }
	const visited: { [key: string]: boolean } = {};
	visited[tx0 + ":" + ty0] = true;
	let layer: { tx: number; ty: number }[] = [{ tx: tx0, ty: ty0 }];
	let collected = 0;
	while (collected < 3 && layer.length > 0) {
		const nextLayer: { tx: number; ty: number }[] = [];
		for (let li = 0; li < layer.length; li++) {
			const c = layer[li];
			const info = tileEdges(c.tx, c.ty);
			if (!info) { continue; }
			for (let d = 0; d < 4; d++) {
				if ((info.edges & (1 << d)) === 0) { continue; }
				const ntx = c.tx + DIR_DELTA[d].dx, nty = c.ty + DIR_DELTA[d].dy;
				const k = ntx + ":" + nty;
				if (visited[k]) { continue; }
				const ni = tileEdges(ntx, nty);
				if (!ni || ni.z !== info.z) { continue; }
				if ((ni.edges & (1 << ((d + 2) % 4))) === 0) { continue; }
				visited[k] = true;
				tiles.push({ x: ntx * TILE, y: nty * TILE });
				collected++;
				if (collected >= 3) { break; }
				nextLayer.push({ tx: ntx, ty: nty });
			}
			if (collected >= 3) { break; }
		}
		layer = nextLayer;
	}
	return tiles;
}

function setPatrol(mechanic: Staff | null, exit: CoordsXY): void {
	if (!mechanic || !mechanic.patrolArea) { return; }
	mechanic.patrolArea.clear();
	mechanic.patrolArea.add(patrolExitPath(exit));
}

// --- Hiring ----------------------------------------------------------------
// Hire `count` staff of a kind (chunked). Calls onDone() after all attempts.
function hireStaff(kind: StaffKind, count: number, onDone?: (hired?: number) => void): void {
	if (count <= 0) { if (onDone) { onDone(); } return; }
	const items: number[] = [];
	for (let i = 0; i < count; i++) { items.push(i); }
	let remaining = count, hired = 0;
	forEachAsync(items, 5, function () {
		context.executeAction("staffhire", {
			autoPosition: true,
			staffType: STAFF_TYPE_NUM[kind],
			costumeIndex: 0,
			entityType: 0,
			staffOrders: STAFF_ORDERS[kind]
		} as StaffHireArgs, function (res) {
			if (res && res.error === 0) { hired++; }
			remaining--;
			if (remaining === 0) {
				park.postMessage({ type: "blank",
					text: "Hired " + staffWord(kind, hired) + "." });
				// Let new entities register before the follow-up assign.
				context.setTimeout(function () { if (onDone) { onDone(hired); } }, 10);
			}
		});
	});
}

// Fire `count` staff of a kind, NEWEST first (highest entity id = most
// recently hired). Only fires "assignable" staff (e.g. never a mowing
// handyman). Chunked; calls onDone(firedCount) when finished.
function fireStaff(kind: StaffKind, count: number, onDone?: (fired: number) => void): void {
	if (count <= 0) { if (onDone) { onDone(0); } return; }
	let pool = assignableOfKind(kind).slice();
	// Never fire a mechanic that is currently inspecting/fixing a ride.
	if (kind === "mechanic") {
		pool = pool.filter(function (m) { return !mechanicIsBusy(m); });
	}
	pool.sort(function (a, b) { return (b.id as number) - (a.id as number); });   // newest first
	const victims = pool.slice(0, count);
	if (victims.length === 0) { if (onDone) { onDone(0); } return; }

	// Forget fired peeps' remembered spots so ids can't go stale.
	const lastArea = getLastArea();
	victims.forEach(function (v) { delete lastArea[v.id as number]; });
	setLastArea(lastArea);

	let remaining = victims.length, fired = 0;
	forEachAsync(victims, 5, function (staff) {
		context.executeAction("stafffire", { id: staff.id as number }, function (res) {
			if (res && res.error === 0) { fired++; }
			remaining--;
			if (remaining === 0) {
				park.postMessage({ type: "blank",
					text: "Fired " + staffWord(kind, fired) + "." });
				context.setTimeout(function () { if (onDone) { onDone(fired); } }, 10);
			}
		});
	});
}

// --- Confirm dialog (small Yes/No/Cancel window) ---------------------------
let confirmTemplate: WindowTemplate | null = null;

function closeConfirm(): void {
	if (confirmTemplate) { confirmTemplate.close(); }
}

// Three-way confirmation dialog:
// - yesLabel  (e.g. "Hire 3 handymen" / "Fire 2 mechanics")  -> onYes
// - noLabel   (e.g. "Assign without hiring/firing") -> onNo
// - "Cancel"  -> onCancel (does nothing further)
function confirmDialog(lines: string[], yesLabel: string, onYes: () => void, noLabel: string,
	onNo: () => void, onCancel?: () => void): void {
	closeConfirm();
	const content: WidgetCreator<FlexiblePosition>[] = lines.map(function (line) {
		return label({ text: line, height: 12 });
	});
	content.push(button({
		text: yesLabel || "Yes", height: 18,
		onClick: function () { closeConfirm(); onYes(); }
	}));
	content.push(button({
		text: noLabel || "No", height: 18,
		onClick: function () { closeConfirm(); onNo(); }
	}));
	content.push(button({
		text: "Cancel", height: 18,
		onClick: function () { closeConfirm(); if (onCancel) { onCancel(); } }
	}));
	const dialogHeight = 30 + lines.length * 16 + 3 * 22;
	confirmTemplate = flexWindow({
		title: "Staff Manager",
		width: 320, height: dialogHeight,
		colours: [24, 24],
		spacing: 4,
		content: content
	});
	confirmTemplate.open();
}

// Simple two-way confirm/cancel dialog (e.g. for "Reset" actions).
function confirm2Dialog(lines: string[], confirmLabel: string, onConfirm: () => void, cancelLabel?: string): void {
	closeConfirm();
	const content: WidgetCreator<FlexiblePosition>[] = lines.map(function (line) {
		return label({ text: line, height: 12 });
	});
	content.push(button({
		text: confirmLabel || "Confirm", height: 18,
		onClick: function () { closeConfirm(); onConfirm(); }
	}));
	content.push(button({
		text: cancelLabel || "Cancel", height: 18,
		onClick: function () { closeConfirm(); }
	}));
	const dialogHeight = 30 + lines.length * 16 + 2 * 22;
	confirmTemplate = flexWindow({
		title: "Staff Manager",
		width: 320, height: dialogHeight,
		colours: [24, 24],
		spacing: 4,
		content: content
	});
	confirmTemplate.open();
}

// --- Inspection interval (chunked) -----------------------------------------
function applyInspectionAll(): void {
	const value = getInspection();
	const rides = map.rides.filter(isRide);
	forEachAsync(rides, ACTIONS_PER_TICK, function (ride) {
		context.executeAction("ridesetsetting", {
			ride: ride.id,
			setting: RIDE_SETTING_INSPECTION_INTERVAL,
			value: value
		}, function () { /* no-op */ });
	}, function () {
		park.postMessage({
			type: "blank",
			text: "Inspection set to '" + INSPECTION_LABELS[value] +
				  "' for " + rides.length + " ride(s)."
		});
	});
}

// --- Mechanics: assign to exits --------------------------------------------
interface CleanAssignmentsState {
	assignments: { [key: string]: number };
	usedMech: { [id: number]: boolean };
}

function cleanAssignments(): CleanAssignmentsState {
	const assignments = getAssignments();
	const cleaned: { [key: string]: number } = {};
	const usedMech: { [id: number]: boolean } = {};
	const validExitKeys: { [key: string]: boolean } = {};
	allExits().forEach(function (e) { validExitKeys[e.key] = true; });
	for (const key in assignments) {
		const mid = assignments[key];
		if (validExitKeys[key] && mechanicById(mid) && !usedMech[mid]) {
			cleaned[key] = mid;
			usedMech[mid] = true;
		}
	}
	setAssignments(cleaned);
	return { assignments: cleaned, usedMech: usedMech };
}

interface AssignMechanicsResult {
	assigned: number;
	reassigned: number;
	inspected: number;
	covered: number;
	totalExits: number;
}

// Matching pairs handled per tick when greedily pairing uncovered exits with
// free mechanics. Keeps the O(exits * mechanics) search from blocking the
// game loop on parks with many rides/mechanics.
const MECH_MATCH_PAIRS_PER_TICK = 40;

function assignMechanicsAsync(onDone: (result: AssignMechanicsResult) => void): void {
	const state = cleanAssignments();
	const assignments = state.assignments;
	const usedMech = state.usedMech;

	for (const key in assignments) {
		const ride = map.getRide(keyRideId(key));
		const exit = stationExit(ride, keyStation(key));
		if (!exit) { continue; }
		const m = mechanicById(assignments[key]);
		if (!m || mechanicIsBusy(m)) { continue; }
		setPatrol(m, exit);
	}

	const free = allMechanics().filter(function (m) {
		return !usedMech[m.id as number] && !mechanicIsBusy(m);
	});
	let assigned = 0;
	const newRideIds: { [rideId: string]: boolean } = {};
	const lastArea = getLastArea();
	const counts: AssignCounts = { fresh: 0, moved: 0 };
	const exits = allExits();

	// Uncovered exits get their NEAREST free mechanic (minimise walking).
	const uncovered: ExitInfo[] = [];
	for (let i = 0; i < exits.length; i++) {
		if (!assignments[exits[i].key]) { uncovered.push(exits[i]); }
	}
	const pairs = Math.min(uncovered.length, free.length);
	const usedFree: boolean[] = [];
	for (let f = 0; f < free.length; f++) { usedFree[f] = false; }
	const doneExit: { [index: number]: boolean } = {};

	function finish(): void {
		setAssignments(assignments);
		setLastArea(lastArea);

		let inspected = 0;
		const value = getInspection();
		for (const rid in newRideIds) {
			context.executeAction("ridesetsetting", {
				ride: Number(rid),
				setting: RIDE_SETTING_INSPECTION_INTERVAL,
				value: value
			}, function () { /* no-op */ });
			inspected++;
		}

		let covered = 0;
		for (const k in assignments) { covered++; }
		onDone({ assigned: assigned, reassigned: counts.moved, inspected: inspected,
				 covered: covered, totalExits: exits.length });
	}

	let n = 0;
	function step(): void {
		let processed = 0;
		while (n < pairs && processed < MECH_MATCH_PAIRS_PER_TICK) {
			let bestE = -1, bestF = -1, bestD = Infinity;
			for (let ei = 0; ei < uncovered.length; ei++) {
				if (doneExit[ei]) { continue; }
				const ex = uncovered[ei].exit;
				for (let fi = 0; fi < free.length; fi++) {
					if (usedFree[fi]) { continue; }
					const dx = free[fi].x - (ex.x + 16), dy = free[fi].y - (ex.y + 16);
					const d = dx * dx + dy * dy;
					if (d < bestD) { bestD = d; bestE = ei; bestF = fi; }
				}
			}
			if (bestE < 0) { n = pairs; break; }
			const e = uncovered[bestE];
			const mech = free[bestF];
			doneExit[bestE] = true;
			usedFree[bestF] = true;
			assignments[e.key] = mech.id as number;
			setPatrol(mech, e.exit);
			recordAssignment(lastArea, mech.id as number, e.exit.x, e.exit.y, counts);
			newRideIds[keyRideId(e.key)] = true;
			assigned++;
			n++;
			processed++;
		}
		setWorkProgress(Math.floor((n / Math.max(1, pairs)) * 100));
		if (n < pairs) { context.setTimeout(step, 1); }
		else { setWorkProgress(100); finish(); }
	}
	step();
}

function assignMechanicsReport(onDone?: () => void): void {
	assignMechanicsAsync(function (r) {
		const reassignTxt = r.reassigned > 0 ? (" (" + r.reassigned + " reassigned)") : "";
		park.postMessage({
			type: "blank",
			text: "Mechanics: " + r.assigned + " assigned" + reassignTxt +
				  ", inspection on " + r.inspected + " ride(s). Covered " +
				  r.covered + "/" + r.totalExits + " exits."
		});
		refreshWindow();
		if (onDone) { onDone(); }
	});
}

// Button entry: offer to hire mechanics if there aren't enough for all exits.
function assignMechanicsWithHire(onDone?: () => void): void {
	const exits = allExits().length;
	const have = allMechanics().length;
	function finish(): void { if (onDone) { onDone(); } }
	if (exits > have) {
		const deficit = exits - have;
		confirmDialog([
			"Covering all ride exits needs " + staffWord("mechanic", exits) + ",",
			"but only " + have + " exist.",
			"Hire " + staffWord("mechanic", deficit) + "?"
		], "Hire " + staffWord("mechanic", deficit),
		function () {
			hireStaff("mechanic", deficit, function () { assignMechanicsReport(finish); });
		}, "Use only existing",
		function () { assignMechanicsReport(finish); }, finish);
	} else if (exits < have) {
		// Only non-busy mechanics can actually be fired.
		const fireable = allMechanics().filter(function (m) { return !mechanicIsBusy(m); }).length;
		const surplus = Math.min(have - exits, fireable);
		if (surplus <= 0) {
			assignMechanicsReport(finish);
		} else {
			confirmDialog([
				"Only " + staffWord("mechanic", exits) + " needed for the exits,",
				"but " + have + " exist.",
				"Fire " + staffWord("mechanic", surplus) + " (newest, non-busy first)?"
			], "Fire " + staffWord("mechanic", surplus),
			function () {
				fireStaff("mechanic", surplus, function () { assignMechanicsReport(finish); });
			}, "Use only existing",
			function () { assignMechanicsReport(finish); }, finish);
		}
	} else {
		assignMechanicsReport(finish);
	}
}

// --- Shared path scan (chunked) --------------------------------------------
interface PathTileInfo {
	z: number;
	edges: number;
	isQueue: boolean;
	owned: boolean;
}

interface ScanSeed {
	tx: number;
	ty: number;
}

function scanMapAsync(onProgress: (pct: number) => void, onComplete: (pathInfo: { [key: string]: PathTileInfo }, seeds: ScanSeed[]) => void): void {
	const size = map.size;
	const pathInfo: { [key: string]: PathTileInfo } = {};
	const seeds: ScanSeed[] = [];
	let tx = 1;
	const maxX = size.x - 1;

	function step(): void {
		const endTx = Math.min(tx + SCAN_ROWS_PER_TICK, maxX);
		for (; tx < endTx; tx++) {
			for (let ty = 1; ty < size.y - 1; ty++) {
				const tile = map.getTile(tx, ty);
				let fp: FootpathElement | null = null, owned = false;
				for (let i = 0; i < tile.numElements; i++) {
					const el = tile.getElement(i);
					if (!el) { continue; }
					if (el.type === "footpath" && !el.isGhost && fp === null) {
						fp = el as FootpathElement;
					} else if (el.type === "surface") {
						const se = el as SurfaceElement;
						owned = (typeof se.ownership === "number") &&
								((se.ownership & OWNERSHIP_OWNED) !== 0);
					} else if (el.type === "entrance") {
						const ee = el as EntranceElement;
						if (ee.ride === null || ee.ride === undefined) {
							seeds.push({ tx: tx, ty: ty });
							for (let d = 0; d < 4; d++) {
								seeds.push({ tx: tx + DIR_DELTA[d].dx,
											 ty: ty + DIR_DELTA[d].dy });
							}
						}
					}
				}
				if (fp !== null) {
					pathInfo[tx + ":" + ty] = {
						z: fp.baseZ,
						edges: (typeof fp.edges === "number") ? fp.edges : 15,
						isQueue: !!fp.isQueue,
						owned: owned
					};
				}
			}
		}
		if (tx < maxX) {
			if (onProgress) { onProgress(Math.floor(((tx - 1) / (maxX - 1)) * 100)); }
			context.setTimeout(step, 1);
		} else {
			onComplete(pathInfo, seeds);
		}
	}
	step();
}

interface ScanTile {
	x: number;
	y: number;
	z: number;
}

interface ReachableTiles {
	paths: ScanTile[];
	queues: ScanTile[];
}

// How many BFS nodes to expand per tick. Keeps the O(tiles) breadth-first
// traversal from blocking the game on large parks (this runs right after the
// row-scan phase, so it must be chunked too or progress appears to "freeze"
// near 100% while this step still runs synchronously).
const BFS_NODES_PER_TICK = 400;

// BFS from the entrance over connected footpaths. Returns reachable, owned
// tiles split into { paths: [...], queues: [...] } (queues are traversed so
// paths beyond a queue are still reached). Chunked across game ticks via
// context.setTimeout so it never blocks the game loop; onProgress reports
// 0..100 while nodes are being expanded.
function reachableOwnedTilesAsync(pathInfo: { [key: string]: PathTileInfo }, seeds: ScanSeed[],
	onProgress: (pct: number) => void, onDone: (result: ReachableTiles) => void): void {
	const visited: { [key: string]: boolean } = {};
	const q: string[] = [];
	const paths: ScanTile[] = [];
	const queues: ScanTile[] = [];
	function enq(tx: number, ty: number): void {
		const k = tx + ":" + ty;
		if (visited[k] || !pathInfo[k]) { return; }
		visited[k] = true;
		q.push(k);
	}
	seeds.forEach(function (s) { enq(s.tx, s.ty); });
	if (q.length === 0) {
		for (const kk in pathInfo) {
			if (pathInfo[kk].owned && !visited[kk]) { visited[kk] = true; q.push(kk); }
		}
	}
	let head = 0;
	function step(): void {
		let processed = 0;
		while (head < q.length && processed < BFS_NODES_PER_TICK) {
			const k = q[head++];
			const info = pathInfo[k];
			const parts = k.split(":");
			const tx = +parts[0], ty = +parts[1];
			if (info.owned) {
				const tile = { x: tx * TILE, y: ty * TILE, z: info.z };
				if (info.isQueue) { queues.push(tile); }
				else { paths.push(tile); }
			}
			for (let d = 0; d < 4; d++) {
				if ((info.edges & (1 << d)) === 0) { continue; }
				enq(tx + DIR_DELTA[d].dx, ty + DIR_DELTA[d].dy);
			}
			processed++;
		}
		if (head < q.length) {
			if (onProgress) { onProgress(Math.floor((head / Math.max(1, q.length)) * 100)); }
			context.setTimeout(step, 1);
		} else {
			onDone({ paths: paths, queues: queues });
		}
	}
	step();
}

function tileKey(t: ScanTile): string { return (t.x / TILE) + ":" + (t.y / TILE); }

// How many farthest-point-sampling seed picks to do per game tick. Keeps the
// O(seeds * tiles) seed-selection work from blocking the game on large parks.
const SEEDS_PER_TICK = 4;

// Splits a connected tile set into up to n connected, contiguous regions of
// roughly equal size via multi-source BFS growth from spread-out seeds. Each
// resulting region is guaranteed connected because it is built by expanding
// only into unclaimed grid-adjacent neighbours of its own seed.
// Runs the (potentially expensive) seed-selection phase in small chunks
// across game ticks via context.setTimeout so it never blocks the game loop;
// onProgress reports 0..100 while seeds are being chosen.
function growPartitionAsync(tiles: ScanTile[], n: number,
	onProgress: (pct: number) => void, onDone: (regions: ScanTile[][]) => void): void {
	if (tiles.length === 0 || n <= 0) { onDone([]); return; }
	n = Math.min(n, tiles.length);

	const byKey: { [key: string]: ScanTile } = {};
	tiles.forEach(function (t) { byKey[tileKey(t)] = t; });

	// Farthest-point sampling with an incrementally-maintained distance array:
	// each new seed only requires one O(tiles) pass (not one per existing seed).
	const seeds: ScanTile[] = [tiles[0]];
	const minDist: number[] = new Array(tiles.length);
	for (let i = 0; i < tiles.length; i++) {
		const dx = tiles[i].x - seeds[0].x, dy = tiles[i].y - seeds[0].y;
		minDist[i] = dx * dx + dy * dy;
	}

	function growFromSeeds(): void {
		const result: ScanTile[][] = [];
		const regionOf: { [key: string]: number } = {};
		const queue: string[] = [];
		const queueRegion: number[] = [];
		seeds.forEach(function (s, i) {
			const k = tileKey(s);
			regionOf[k] = i;
			queue.push(k);
			queueRegion.push(i);
			result[i] = [];
		});
		let head = 0;
		while (head < queue.length) {
			const k = queue[head];
			const region = queueRegion[head];
			head++;
			result[region].push(byKey[k]);
			const parts = k.split(":");
			const tx = +parts[0], ty = +parts[1];
			for (let d = 0; d < 4; d++) {
				const nk = (tx + DIR_DELTA[d].dx) + ":" + (ty + DIR_DELTA[d].dy);
				if (byKey[nk] && regionOf[nk] === undefined) {
					regionOf[nk] = region;
					queue.push(nk);
					queueRegion.push(region);
				}
			}
		}
		onDone(result.filter(function (r) { return r.length > 0; }));
	}

	function stepSeeds(): void {
		let processed = 0;
		while (seeds.length < n && processed < SEEDS_PER_TICK) {
			let bestIdx = -1, bestD = -1;
			for (let i = 0; i < tiles.length; i++) {
				if (minDist[i] > bestD) { bestD = minDist[i]; bestIdx = i; }
			}
			if (bestIdx < 0) { break; }
			const s = tiles[bestIdx];
			seeds.push(s);
			for (let i = 0; i < tiles.length; i++) {
				const dx = tiles[i].x - s.x, dy = tiles[i].y - s.y;
				const d = dx * dx + dy * dy;
				if (d < minDist[i]) { minDist[i] = d; }
			}
			processed++;
		}
		if (onProgress) { onProgress(Math.floor((seeds.length / n) * 100)); }
		if (seeds.length < n) { context.setTimeout(stepSeeds, 1); }
		else { growFromSeeds(); }
	}
	stepSeeds();
}

// Splits a tile set into its grid-adjacency connected components (4-neighbour).
function connectedComponents(tiles: ScanTile[]): ScanTile[][] {
	const byKey: { [key: string]: ScanTile } = {};
	tiles.forEach(function (t) { byKey[tileKey(t)] = t; });
	const visited: { [key: string]: boolean } = {};
	const components: ScanTile[][] = [];
	tiles.forEach(function (start) {
		const startKey = tileKey(start);
		if (visited[startKey]) { return; }
		const comp: ScanTile[] = [];
		const queue: string[] = [startKey];
		visited[startKey] = true;
		let head = 0;
		while (head < queue.length) {
			const k = queue[head++];
			comp.push(byKey[k]);
			const parts = k.split(":");
			const tx = +parts[0], ty = +parts[1];
			for (let d = 0; d < 4; d++) {
				const nk = (tx + DIR_DELTA[d].dx) + ":" + (ty + DIR_DELTA[d].dy);
				if (byKey[nk] && !visited[nk]) { visited[nk] = true; queue.push(nk); }
			}
		}
		components.push(comp);
	});
	return components;
}

// Partition a (possibly disconnected) tile set into n reachable, connected,
// contiguous zones. Zones are allocated across components proportional to
// their size (each component keeps at least one zone), then grown within
// each component via BFS so every resulting zone stays a single connected
// region rather than an arbitrary slice of the sorted tile array.
// Async: components are processed one at a time (each itself chunked across
// ticks by growPartitionAsync) so large parks never block the game loop.
function partitionAsync(tiles: ScanTile[], n: number,
	onProgress: (pct: number) => void, onDone: (chunks: ScanTile[][]) => void): void {
	if (tiles.length === 0 || n <= 0) { onDone([]); return; }
	const components = connectedComponents(tiles);

	const totalTiles = tiles.length;
	const zonesPer: number[] = components.map(function (c) {
		return Math.max(1, Math.round((c.length / totalTiles) * n));
	});
	let allocated = zonesPer.reduce(function (a, b) { return a + b; }, 0);
	let guard = 0;
	while (allocated > n && guard < n * 4 + components.length + 10) {
		const idx = guard % zonesPer.length;
		if (zonesPer[idx] > 1) { zonesPer[idx]--; allocated--; }
		guard++;
	}
	guard = 0;
	while (allocated < n) {
		zonesPer[guard % zonesPer.length]++;
		allocated++;
		guard++;
	}

	const chunks: ScanTile[][] = [];
	function processComponent(ci: number): void {
		if (ci >= components.length) { onDone(chunks); return; }
		const c = components[ci];
		growPartitionAsync(c, Math.min(zonesPer[ci], c.length), function (pct) {
			if (onProgress) {
				const overall = Math.floor(((ci + pct / 100) / components.length) * 100);
				onProgress(overall);
			}
		}, function (regions) {
			regions.forEach(function (r) { chunks.push(r); });
			processComponent(ci + 1);
		});
	}
	processComponent(0);
}

// Centre tile of a zone: the tile nearest the region's centroid, so it stays
// spatially meaningful even for irregularly-shaped contiguous zones.
function zoneCentre(chunk: ScanTile[]): ScanTile {
	if (chunk.length === 0) { return { x: 0, y: 0, z: 0 }; }
	let sumX = 0, sumY = 0;
	for (let i = 0; i < chunk.length; i++) { sumX += chunk[i].x; sumY += chunk[i].y; }
	const cx = sumX / chunk.length, cy = sumY / chunk.length;
	let best = chunk[0], bestD = Infinity;
	for (let i = 0; i < chunk.length; i++) {
		const dx = chunk[i].x - cx, dy = chunk[i].y - cy;
		const d = dx * dx + dy * dy;
		if (d < bestD) { bestD = d; best = chunk[i]; }
	}
	return best;
}

// Greedily match staff to their NEAREST free zone, minimising walking.
// Repeatedly picks the globally-closest (staff, zone) pair until one side runs
// out. Returns an array `assign` where assign[staffIndex] = zoneIndex (or -1).
// `staff` are entities with x/y; `chunks` is an array of tile arrays.
// Async: pairs are matched a few at a time per tick so large staff/zone
// counts (each pairing pass is O(staff*zones)) never block the game loop.
const MATCH_PAIRS_PER_TICK = 60;
function matchNearestZonesAsync(staff: Staff[], chunks: ScanTile[][],
	onDone: (assign: number[]) => void): void {
	const assign: number[] = [];
	for (let s = 0; s < staff.length; s++) { assign[s] = -1; }
	const zoneTaken: boolean[] = [];
	const staffTaken: boolean[] = [];
	const centres: ScanTile[] = [];
	for (let z = 0; z < chunks.length; z++) {
		zoneTaken[z] = false;
		centres[z] = zoneCentre(chunks[z]);
	}
	for (let s2 = 0; s2 < staff.length; s2++) { staffTaken[s2] = false; }

	const pairs = Math.min(staff.length, chunks.length);
	let n = 0;
	function step(): void {
		let processed = 0;
		while (n < pairs && processed < MATCH_PAIRS_PER_TICK) {
			let bestS = -1, bestZ = -1, bestD = Infinity;
			for (let si = 0; si < staff.length; si++) {
				if (staffTaken[si]) { continue; }
				const px = staff[si].x, py = staff[si].y;
				for (let zi = 0; zi < chunks.length; zi++) {
					if (zoneTaken[zi]) { continue; }
					const c = centres[zi];
					const dx = px - (c.x + 16), dy = py - (c.y + 16);
					const d = dx * dx + dy * dy;   // squared distance is fine
					if (d < bestD) { bestD = d; bestS = si; bestZ = zi; }
				}
			}
			if (bestS < 0) { n = pairs; break; }
			assign[bestS] = bestZ;
			staffTaken[bestS] = true;
			zoneTaken[bestZ] = true;
			n++;
			processed++;
		}
		if (n < pairs) { context.setTimeout(step, 1); }
		else { onDone(assign); }
	}
	step();
}

// Cached scan result (shared by all path staff).
let cachedTiles: ScanTile[] | null = null;        // reachable, owned, non-queue path tiles
let cachedQueues: ScanTile[] | null = null;       // reachable, owned queue tiles
let pathsScanned = false;
let scanProgress = -1;
let assignProgress = -1;   // -1 = idle; 0..100 while partitioning/assigning is running

function sortTiles(a: ScanTile, b: ScanTile): number { return (a.x - b.x) || (a.y - b.y); }

function ensureScan(force: boolean, onDone: (tiles: ScanTile[] | null) => void): void {
	if (!force && cachedTiles) { onDone(cachedTiles); return; }
	if (busy) { return; }
	busy = true;
	scanProgress = 0;
	scanMapAsync(function (pct) {
		// Only the lightweight percentage store is touched per tick here;
		// refreshWindow() recomputes ~10 stores across every staff kind and
		// must not run on every tick or it dominates the whole scan's cost.
		// This phase covers the first 70% of the overall scan progress; the
		// BFS phase below covers the remaining 30%.
		scanProgress = pct; setWorkProgress(Math.floor(pct * 0.7));
	}, function (pathInfo, seeds) {
		reachableOwnedTilesAsync(pathInfo, seeds, function (pct) {
			setWorkProgress(70 + Math.floor(pct * 0.3));
		}, function (res) {
			cachedTiles = res.paths.sort(sortTiles);
			cachedQueues = res.queues.sort(sortTiles);
			pathsScanned = true;
			scanProgress = -1;
			busy = false;
			refreshWindow();
			onDone(cachedTiles);
		});
	});
}

// The tile set a given kind should be assigned to. Mascots use QUEUE tiles when
// the "assign to queues" option is on (and any queues exist).
function tilesForKind(kind: StaffKind): ScanTile[] {
	if (kind === "entertainer" && getMascotQueues() &&
		cachedQueues && cachedQueues.length > 0) {
		return cachedQueues;
	}
	return cachedTiles || [];
}

// How many staff of a kind a full assignment needs for the given tile count.
function neededForKind(kind: StaffKind, tileCount: number): number {
	if (kind === "entertainer") {
		// Mascots: density = tiles-per-mascot (queue or path mode), with
		// `mascotsPerArea` mascots sharing/overlapping each area of that size.
		// Areas are sized by tilesPer alone; mascotsPerArea then multiplies the
		// mascot count per area (it must NOT also inflate the area size, or the
		// multiplier cancels itself out). Must mirror assignMascots() so the
		// displayed "Needed" count matches what actually gets assigned.
		const tilesPer = mascotTilesPer();
		const perArea = Math.max(1, getMascotPerArea());
		const numAreas = Math.ceil(tileCount / tilesPer);
		return numAreas * perArea;
	}
	return Math.ceil(tileCount / Math.max(1, getPer(kind)));
}

// Mascot placement. Each area holds `mascotsPerArea` mascots and spans
// tilesPerMascot * mascotsPerArea tiles (so density stays tiles-per-mascot).
// When mascotsPerArea > 1 the mascots in an area overlap.
// Async: partitioning and the greedy placement loop are both chunked across
// ticks (via partitionAsync / setTimeout) so large parks never block the game.
const MASCOT_PLACEMENTS_PER_TICK = 40;
function assignMascots(tiles: ScanTile[], onDone?: () => void): void {
	const mascots = assignableOfKind("entertainer");
	if (mascots.length === 0) {
		park.postMessage({ type: "blank", text: "No entertainers available." });
		refreshWindow();
		if (onDone) { onDone(); }
		return;
	}
	const tilesPer = mascotTilesPer();
	const perArea = Math.max(1, getMascotPerArea());
	const areaSize = Math.max(1, tilesPer);
	const numAreas = Math.ceil(tiles.length / areaSize);

	assignProgress = 0;
	setWorkProgress(0);
	partitionAsync(tiles, numAreas, function (pct) {
		assignProgress = Math.floor(pct * 0.7); setWorkProgress(assignProgress);
	}, function (areas) {
		// Nearest matching with capacity: each mascot takes the closest area that
		// still has a free slot (perArea slots each). Minimises walking.
		const cap: number[] = [];
		const centres: ScanTile[] = [];
		for (let a = 0; a < areas.length; a++) {
			cap[a] = perArea;
			centres[a] = zoneCentre(areas[a]);
		}
		const used: boolean[] = [];
		for (let s = 0; s < mascots.length; s++) { used[s] = false; }

		const areaUsed: { [index: number]: boolean } = {};
		const lastArea = getLastArea();
		const counts: AssignCounts = { fresh: 0, moved: 0 };
		// Use the ACTUAL area count, not the pre-partition estimate: partitioning
		// guarantees at least one area per disconnected queue/component, which can
		// produce more areas than `numAreas` when several small queues exist. Using
		// the stale estimate here would cut placements short and leave those small
		// queues without any mascot.
		const placements = Math.min(mascots.length, areas.length * perArea);

		let n = 0;
		function step(): void {
			let processed = 0;
			while (n < placements && processed < MASCOT_PLACEMENTS_PER_TICK) {
				let bestS = -1, bestA = -1, bestD = Infinity;
				for (let si = 0; si < mascots.length; si++) {
					if (used[si]) { continue; }
					const px = mascots[si].x, py = mascots[si].y;
					for (let ai = 0; ai < areas.length; ai++) {
						if (cap[ai] <= 0) { continue; }
						const c = centres[ai];
						const dx = px - (c.x + 16), dy = py - (c.y + 16);
						const d = dx * dx + dy * dy;
						if (d < bestD) { bestD = d; bestS = si; bestA = ai; }
					}
				}
				if (bestS < 0) { n = placements; break; }
				const p = mascots[bestS];
				used[bestS] = true;
				cap[bestA]--;
				areaUsed[bestA] = true;
				if (p.patrolArea) {
					const area = areas[bestA];
					const t = centres[bestA];
					p.patrolArea.clear();
					p.patrolArea.add(area);
					recordAssignment(lastArea, p.id as number, t.x, t.y, counts);
					try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) { /* ignore */ }
				}
				n++;
				processed++;
			}
			const pct = 70 + Math.floor((n / Math.max(1, placements)) * 30);
			updateProgressWindow(pct, "Moving mascots (" + n + "/" + placements + ")");
			assignProgress = pct;
			setWorkProgress(pct);
			if (n < placements) {
				// Pause after every 10 so the game settles between moves.
				context.setTimeout(step, 25);
				return;
			}

			closeProgressWindow();
			let areasUsed = 0;
			for (const k in areaUsed) { areasUsed++; }
			setLastArea(lastArea);
			const tileWord = getMascotQueues() ? "queue" : "path";
			const overlapTxt = perArea > 1 ? (" (" + perArea + " per area, overlapping)") : "";
			park.postMessage({ type: "blank",
				text: "Mascots: " + assignSummary(counts) + " across " +
					  areasUsed + " " + tileWord + " area(s)" + overlapTxt + "." });
			assignProgress = -1;
			setWorkProgress(100);
			refreshWindow();
			if (onDone) { onDone(); }
		}
		if (placements > 0) { openProgressWindow(); }
		step();
	});
}

function doPathAssign(kind: StaffKind, niceName: string, tiles: ScanTile[], onDone?: () => void): void {
	if (kind === "entertainer") {
		assignMascots(tiles, onDone);
		return;
	}
	const staff = assignableOfKind(kind);
	if (staff.length === 0) {
		park.postMessage({ type: "blank",
			text: "No assignable " + niceName + " available." });
		refreshWindow();
		if (onDone) { onDone(); }
		return;
	}
	assignProgress = 0;
	setWorkProgress(0);
	partitionAsync(tiles, staff.length, function (pct) {
		assignProgress = Math.floor(pct * 0.5); setWorkProgress(assignProgress);
	}, function (chunks) {
		// Match each staff member to its NEAREST zone (minimise walking).
		matchNearestZonesAsync(staff, chunks, function (assign) {
			// Set all patrol areas first (instant), then teleport staff in
			// small batches with a pause after every 10, showing progress in a
			// dedicated small window. Slowing the teleport down seems to avoid
			// the game dropping some staff from moving after assignment.
			const targets: { p: Staff; t: ScanTile }[] = [];
			for (let i = 0; i < staff.length; i++) {
				const p = staff[i];
				if (!p.patrolArea) { continue; }
				const zi = assign[i];
				if (zi < 0) { continue; }
				const chunk = chunks[zi];
				p.patrolArea.clear();
				if (chunk && chunk.length > 0) {
					p.patrolArea.add(chunk);
					targets.push({ p: p, t: zoneCentre(chunk) });
				}
			}
			setLastArea(getLastArea());

			if (targets.length === 0) {
				assignProgress = -1;
				park.postMessage({ type: "blank",
					text: niceName + ": nothing to move." });
				refreshWindow();
				if (onDone) { onDone(); }
				return;
			}
			teleportTotal = targets.length;
			teleportActive = true;
			assignProgress = 90;
			setWorkProgress(90);
			openProgressWindow();
			updateProgressWindow(90, "Moving " + niceName + " (" + 0 + "/" + teleportTotal + ")");
			const lastArea = getLastArea();
			const counts: AssignCounts = { fresh: 0, moved: 0 };
			let cursor = 0;
			function teleportStep(): void {
				let processed = 0;
				while (cursor < targets.length && processed < 10) {
					const tp = targets[cursor];
					const p = tp.p, t = tp.t;
					recordAssignment(lastArea, p.id as number, t.x, t.y, counts);
					try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) { /* ignore */ }
					cursor++;
					processed++;
				}
				const pct = 90 + Math.floor((cursor / Math.max(1, teleportTotal)) * 10);
				updateProgressWindow(pct, "Moving " + niceName + " (" + cursor + "/" + teleportTotal + ")");
				setWorkProgress(pct);
				if (cursor < targets.length) {
					// Pause after every 10 so the game settles and no staff
					// are dropped from moving. The pause is the timeout delay.
					context.setTimeout(teleportStep, 25);
				} else {
					closeProgressWindow();
					setLastArea(lastArea);
					const tileWord = "path tiles";
					park.postMessage({ type: "blank",
						text: niceName + ": " + assignSummary(counts) + " over " +
							  tiles.length + " " + tileWord + "." });
					assignProgress = -1;
					refreshWindow();
					if (onDone) { onDone(); }
				}
			}
			teleportStep();
		});
	});
}

// Button entry for path staff: scan, then offer to hire if short, then assign.
function assignPathStaff(kind: StaffKind, niceName: string, onDone?: () => void): void {
	if (busy) {
		park.postMessage({ type: "blank", text: "Staff Manager is busy scanning..." });
		if (onDone) { onDone(); }
		return;
	}
	ensureScan(true, function () {
		const tiles = tilesForKind(kind);
		const usingQueues = (kind === "entertainer" && getMascotQueues());
		if (!tiles || tiles.length === 0) {
			park.postMessage({ type: "blank",
				text: usingQueues
					? "No reachable queue tiles found."
					: "No reachable owned path tiles found." });
			refreshWindow();
			if (onDone) { onDone(); }
			return;
		}
		const have = assignableOfKind(kind).length;
		const need = neededForKind(kind, tiles.length);
		busy = true;
		function finishAssign(): void { busy = false; refreshWindow(); if (onDone) { onDone(); } }
		if (need > have) {
			const deficit = need - have;
			confirmDialog([
				"Full coverage needs " + staffWord(kind, need) + ",",
				"but only " + have + " available.",
				"Hire " + staffWord(kind, deficit) + "?"
			], "Hire " + staffWord(kind, deficit),
			function () {
				hireStaff(kind, deficit, function () { doPathAssign(kind, niceName, tiles, finishAssign); });
			}, "Use only existing",
			function () {
				doPathAssign(kind, niceName, tiles, finishAssign);
			}, finishAssign);
		} else if (need < have) {
			const surplus = have - need;
			confirmDialog([
				"Coverage needs only " + staffWord(kind, need) + ",",
				"but " + have + " are available.",
				"Fire " + staffWord(kind, surplus) + " (newest first)?"
			], "Fire " + staffWord(kind, surplus),
			function () {
				fireStaff(kind, surplus, function () { doPathAssign(kind, niceName, tiles, finishAssign); });
			}, "Use only existing",
			function () {
				doPathAssign(kind, niceName, tiles, finishAssign);
			}, finishAssign);
		} else {
			doPathAssign(kind, niceName, tiles, finishAssign);
		}
	});
}

// Remove every given peep's last-area record from the store.
function forgetLastArea(peepIds: number[]): void {
	const lastArea = getLastArea();
	peepIds.forEach(function (id) { delete lastArea[id as number]; });
	setLastArea(lastArea);
}

function clearMechanicAssignments(peepIds: number[]): void {
	setAssignments({});
	forgetLastArea(peepIds);
}

// Remove all assignments for a single staff type: clear each staff member's
// patrol area (and, for mechanics, the persisted exit->mechanic map).
function resetStaffType(kind: StaffKind): void {
	const ids: number[] = [];
	allStaffOfType(kind).forEach(function (s) {
		if (s.patrolArea) { s.patrolArea.clear(); }
		ids.push(s.id as number);
	});
	if (kind === "mechanic") { clearMechanicAssignments(ids); }
	else { forgetLastArea(ids); }
	park.postMessage({ type: "blank", text: "Cleared " + kind + " assignments." });
	refreshWindow();
}

// Remove all assignments for every staff type at once.
// Button entry: just rescan and refresh the Needed/Hired counts, without
// hiring, firing or (re)assigning anyone.
function recalcPathNeeded(kind: StaffKind, niceName: string): void {
	if (busy) {
		park.postMessage({ type: "blank", text: "Staff Manager is busy scanning..." });
		return;
	}
	ensureScan(true, function () {
		refreshWindow();
	});
}

// --- GUI -------------------------------------------------------------------
let teleportProgress = 0;   // 0..100 for the teleport progress window
let teleportTotal = 0;
let teleportLabel = "";
let teleportActive = false;

const progressLabelStore: Store<string> = flexStore("");
const progressPercentStore: Store<number> = flexStore(0);
const progressPctTextStore: Store<string> = flexCompute(progressPercentStore, function (pct) { return pct + "%"; });

// --- Overall "work done" progress bar (bottom of the main window) ---------
// Shared across all buttons (Assign/Reset/Assign all/Reset all) so the user
// always sees a single, consistent non-blocking progress indicator.
// Rendered as a single text label (RCT2's bitmap font does not include the
// solid/shade block characters, so those showed up as "?????"); "=" / "-"
// are part of the game's normal character set and render correctly.
const workPercentStore: Store<number> = flexStore(0);
const workPctTextStore: Store<string> = flexCompute(workPercentStore, function (pct) { return pct + "%"; });
const WORK_BAR_WIDTH = 40;
const workBarTextStore: Store<string> = flexCompute(workPercentStore, function (pct) {
	const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * WORK_BAR_WIDTH);
	let s = "";
	for (let i = 0; i < WORK_BAR_WIDTH; i++) { s += (i < filled ? "=" : "-"); }
	return s;
});

// Only push a store update when the percentage actually changes, since each
// store write triggers a flexui re-bind of every widget bound to it; calling
// this every single tick during a fine-grained scan is a major source of
// perceived freezing.
let lastWorkPercent = -1;
function setWorkProgress(pct: number): void {
	const clamped = Math.max(0, Math.min(100, Math.round(pct)));
	if (clamped === lastWorkPercent) { return; }
	lastWorkPercent = clamped;
	workPercentStore.set(clamped);
}

// Real filled-rectangle progress bar, drawn with a "custom" widget's onDraw
// callback (see GraphicsContext in @openrct2/types), the same technique used
// by openrct2-dynamicdashboard's progress_bar.ts. This renders an actual bar
// instead of simulating one with text characters, and only repaints when the
// bound percent store changes, so it does not add any per-tick overhead.
const PROGRESS_BAR_BORDER_COLOUR = 12; // dark grey well border
const PROGRESS_BAR_FILL_COLOUR = 30;   // bright green fill
let progressBarNameCounter = 0;

function makeMiniProgressBar(percentStore: Store<number>, visibility?: Store<ElementVisibility>): WidgetCreator<FlexiblePosition> {
	let pct = Math.max(0, Math.min(100, percentStore.get()));
	const name = "progressbar" + (progressBarNameCounter++);
	const params: ElementParams & FlexiblePosition = { visibility: visibility, height: 14 };
	return {
		params: params,
		create: function (output: BuildOutput): Layoutable {
			const widget = {
				type: "custom",
				name: name,
				x: 0, y: 0, width: 0, height: 14,
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
				const win = (widget as unknown as { window?: Window }).window;
				if (win) { try { win.findWidget<Widget>(name); } catch (e) { /* ignore */ } }
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

// Runs a list of independently-async steps one after another, reporting
// combined progress (0..100) via setWorkProgress as each step completes.
// Each step function receives a "next" callback it must call when done.
function runStepsWithProgress(steps: ((next: () => void) => void)[], onAllDone?: () => void): void {
	if (steps.length === 0) { setWorkProgress(0); if (onAllDone) { onAllDone(); } return; }
	let i = 0;
	setWorkProgress(0);
	function runNext(): void {
		if (i >= steps.length) {
			setWorkProgress(100);
			context.setTimeout(function () { setWorkProgress(0); }, 600);
			if (onAllDone) { onAllDone(); }
			return;
		}
		const step = steps[i];
		step(function () {
			i++;
			setWorkProgress(Math.floor((i / steps.length) * 100));
			runNext();
		});
	}
	runNext();
}

let progressTemplate: WindowTemplate | null = null;

function progressWindowTemplate(): WindowTemplate {
	if (!progressTemplate) {
		progressTemplate = flexWindow({
			title: "Moving staff",
			width: 260, height: 76,
			minWidth: 260, maxWidth: 260, minHeight: 76, maxHeight: 76,
			colours: [24, 24],
			spacing: 4,
			content: [
				label({ text: progressLabelStore, height: 12, alignment: "centred" }),
				makeMiniProgressBar(progressPercentStore),
				label({ text: progressPctTextStore, height: 12, alignment: "centred" })
			]
		});
	}
	return progressTemplate;
}

function openProgressWindow(): void {
	progressWindowTemplate().open();
}

function updateProgressWindow(pct: number, label: string): void {
	teleportProgress = pct;
	teleportLabel = label;
	progressPercentStore.set(pct);
	progressLabelStore.set(label);
}

function closeProgressWindow(): void {
	teleportActive = false;
	if (progressTemplate) { progressTemplate.close(); }
}


interface PathKindDef {
	kind: StaffKind;
	nice: string;
	title: string;
}

const PATH_KINDS: PathKindDef[] = [
	{ kind: "handyman",    nice: "handymen",  title: "Handymen" },
	{ kind: "security",    nice: "security",  title: "Security" },
	{ kind: "entertainer", nice: "entertainers", title: "Entertainers" }
];

function pathStatusText(kind: StaffKind, nice: string): string {
	if (scanProgress >= 0) { return "Scanning map... " + scanProgress + "%"; }
	if (assignProgress >= 0) { return "Assigning... " + assignProgress + "%"; }
	// Mascots in queue mode count queue tiles; otherwise path tiles.
	const useQueues = (kind === "entertainer" && getMascotQueues());
	const srcLen = useQueues
		? (pathsScanned && cachedQueues ? cachedQueues.length : null)
		: (pathsScanned && cachedTiles ? cachedTiles.length : null);
	const label = useQueues ? "Queues" : "Paths";
	const srcTxt = srcLen === null ? "?" : String(srcLen);
	const hired = allStaffOfType(kind).length;

	if (kind === "entertainer") {
		const needed = srcLen === null ? "?" : String(neededForKind(kind, srcLen));
		const perArea = Math.max(1, getMascotPerArea());
		const extra = perArea > 1 ? (" | " + perArea + "/area") : "";
		return label + ": " + srcTxt + " | Needed: " + needed +
			   " | Hired: " + hired + extra;
	}

	const assignable = assignableOfKind(kind).length;
	const per = Math.max(1, getPer(kind));
	const need2 = srcLen === null ? "?" : String(Math.ceil(srcLen / per));
	return label + ": " + srcTxt + " | Needed: " + need2 +
		   " | Hired: " + hired + " | Assignable: " + assignable;
}

function mechStatusText(): string {
	const assignments = getAssignments();
	let covered = 0;
	for (const k in assignments) { covered++; }
	return "Mechanics: " + allMechanics().length +
		   "  |  Exits covered: " + covered;
}

const statusStore: { [kind in StaffKind]: Store<string> } = {
	handyman: flexStore(""), security: flexStore(""), entertainer: flexStore(""), mechanic: flexStore("")
};
// Needed-count text, e.g. "Needed: 5" (shown separately from the full status line).
const neededTextStore: { [kind in StaffKind]: Store<string> } = {
	handyman: flexStore(""), security: flexStore(""), entertainer: flexStore(""), mechanic: flexStore("")
};
// 0..100, percentage of needed staff of this kind already hired/available.
const availPercentStore: { [kind in StaffKind]: Store<number> } = {
	handyman: flexStore(0), security: flexStore(0), entertainer: flexStore(0), mechanic: flexStore(0)
};
// Text describing how many more (or fewer) staff of this kind are needed,
// e.g. "Need 3 more handymen" / "3 handymen surplus" / "Fully staffed".
const deltaTextStore: { [kind in StaffKind]: Store<string> } = {
	handyman: flexStore(""), security: flexStore(""), entertainer: flexStore(""), mechanic: flexStore("")
};
const perStore: { handyman: Store<number>; security: Store<number> } = {
	handyman: flexStore(getPer("handyman")),
	security: flexStore(getPer("security"))
};
const mascotQueuesStore: Store<boolean> = flexStore(getMascotQueues());
const mascotQueuePerStore: Store<number> = flexStore(getMascotQueuePer());
const mascotPathPerStore: Store<number> = flexStore(getMascotPathPer());
const mascotPerAreaStore: Store<number> = flexStore(getMascotPerArea());
const inspectIndexStore: Store<number> = flexStore(getInspection());
const mechStatusStore: Store<string> = flexStore("");

// Needed count for a path-staff kind, based on the currently cached scan.
function pathNeededCount(kind: StaffKind): number | null {
	const useQueues = (kind === "entertainer" && getMascotQueues());
	const srcLen = useQueues
		? (pathsScanned && cachedQueues ? cachedQueues.length : null)
		: (pathsScanned && cachedTiles ? cachedTiles.length : null);
	if (srcLen === null) { return null; }
	return neededForKind(kind, srcLen);
}

// Builds a "Need N more X" / "N X surplus" / "Fully staffed" delta message.
function deltaText(kind: StaffKind, have: number, needed: number | null): string {
	if (needed === null) { return "Needed: ?"; }
	const diff = needed - have;
	if (diff > 0) { return "Need " + staffWord(kind, diff) + " more"; }
	if (diff < 0) { return staffWord(kind, -diff) + " surplus"; }
	return "Fully staffed";
}

function refreshPathKindStores(pk: PathKindDef): void {
	const kind = pk.kind;
	statusStore[kind].set(pathStatusText(kind, pk.nice));
	const needed = pathNeededCount(kind);
	const have = allStaffOfType(kind).length;
	neededTextStore[kind].set(needed === null ? "Needed: ?" : "Needed: " + needed);
	availPercentStore[kind].set(needed === null || needed === 0 ? (have > 0 ? 100 : 0) : Math.max(0, Math.min(100, Math.round((have / needed) * 100))));
	deltaTextStore[kind].set(deltaText(kind, have, needed));
}

function refreshMechanicStores(): void {
	const needed = allExits().length;
	const have = allMechanics().length;
	neededTextStore.mechanic.set("Needed: " + needed);
	availPercentStore.mechanic.set(needed === 0 ? (have > 0 ? 100 : 0) : Math.max(0, Math.min(100, Math.round((have / needed) * 100))));
	deltaTextStore.mechanic.set(deltaText("mechanic", have, needed));
}

function refreshWindow(): void {
	PATH_KINDS.forEach(function (pk) {
		refreshPathKindStores(pk);
	});
	refreshMechanicStores();
	perStore.handyman.set(getPer("handyman"));
	perStore.security.set(getPer("security"));
	mascotQueuesStore.set(getMascotQueues());
	mascotQueuePerStore.set(getMascotQueuePer());
	mascotPathPerStore.set(getMascotPathPer());
	mascotPerAreaStore.set(getMascotPerArea());
	inspectIndexStore.set(getInspection());
	mechStatusStore.set(mechStatusText());
}

// --- Tabbed main window ------------------------------------------------
// This flexui prerelease's built-in `tabs` window param is a no-op, and
// binding a box's `visibility` to "none" does not remove it from layout at
// runtime (widgets still overlap/render on top of each other). Instead, tabs
// are implemented by only ever including the *active* tab's content box in
// the window's `content` array, and rebuilding + reopening the window
// whenever the user switches tabs.
const TAB_HANDYMAN = 0;
const TAB_MECHANIC = 1;
const TAB_GUARD = 2;
const TAB_MASCOT = 3;

interface TabDef {
	index: number;
	label: string;
	kind: StaffKind;
}

const TABS: TabDef[] = [
	{ index: TAB_HANDYMAN, label: "Handymen", kind: "handyman" },
	{ index: TAB_MECHANIC, label: "Mechanics", kind: "mechanic" },
	{ index: TAB_GUARD, label: "Guards", kind: "security" },
	{ index: TAB_MASCOT, label: "Entertainers", kind: "entertainer" }
];

const activeTabStore: Store<number> = flexStore(TAB_HANDYMAN);

// --- Calculate gate ----------------------------------------------------
// The main window opens showing only a big "Calculate" button + progress
// bar. Tabs and action buttons are revealed only after the (potentially
// expensive) map scan/needed-count calculation has finished, so the window
// never shows stale/zeroed numbers and the heavy scan is always an explicit,
// user-initiated, chunked (non-blocking) action.
// Plain boolean (not a store): toggling a top-level weighted ("1w") box's
// visibility does not reliably relayout in this flexui prerelease, so the
// gate->main transition rebuilds and reopens the window instead (same
// approach already used for tab switching).
let calculated = false;

function runCalculation(): void {
	if (busy) { return; }
	setWorkProgress(0);
	ensureScan(true, function () {
		refreshWindow();
		setWorkProgress(100);
		calculated = true;
		context.setTimeout(function () { setWorkProgress(0); openWindow(); }, 400);
	});
}

function kindToTabIndex(kind: StaffKind): number {
	if (kind === "handyman") { return TAB_HANDYMAN; }
	if (kind === "security") { return TAB_GUARD; }
	return TAB_MASCOT;
}

function tabIndexToKind(tabIndex: number): StaffKind | null {
	if (tabIndex === TAB_HANDYMAN) { return "handyman"; }
	if (tabIndex === TAB_GUARD) { return "security"; }
	if (tabIndex === TAB_MASCOT) { return "entertainer"; }
	return null;
}

function tabVisibility(tabIndex: number): Store<ElementVisibility> {
	return flexCompute(activeTabStore, function (active) { return active === tabIndex ? "visible" : "none"; });
}

function makePathSection(pk: PathKindDef): WidgetCreator<FlexiblePosition> {
	const kind = pk.kind;
	const nice = pk.nice;
	const vis: Store<ElementVisibility> = tabVisibility(kindToTabIndex(kind));
	const icon = makeIconWidget(30, 30, staffSprite(kind), pk.title, vis);
	const controls: WidgetCreator<FlexiblePosition>[] = [];

	if (kind === "entertainer") {
		// Entertainers: tiles-per-entertainer spinner, mascots-per-area spinner,
		// and a queueline-areas checkbox (toggle).
		controls.push(spinner({
			value: mascotPathPerStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Path tiles each entertainer covers", visibility: vis,
			format: function (v) { return "Tiles per entertainer: " + v; },
			onChange: function (v) { setMascotPathPer(Math.max(1, v)); refreshWindow(); }
		}));
		controls.push(spinner({
			value: mascotPerAreaStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "How many entertainers share each area (>1 = overlapping)", visibility: vis,
			format: function (v) { return "Entertainers per area: " + v; },
			onChange: function (v) { setMascotPerArea(Math.max(1, v)); refreshWindow(); }
		}));
		controls.push(toggle({
			text: "Assign to queueline areas", height: 14,
			tooltip: "Place entertainers along ride queues instead of general paths",
			isPressed: mascotQueuesStore, visibility: vis,
			onChange: function (checked) { setMascotQueues(checked); refreshWindow(); }
		}));
		controls.push(spinner({
			value: mascotQueuePerStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Maximum queue tiles each entertainer covers (queueline mode)", visibility: vis,
			format: function (v) { return "Queue tiles per entertainer: " + v; },
			onChange: function (v) { setMascotQueuePer(Math.max(1, v)); refreshWindow(); }
		}));
	} else {
		// Handymen / security: single "tiles per staff" spinner.
		const perS: Store<number> = kind === "handyman" ? perStore.handyman : perStore.security;
		controls.push(spinner({
			value: perS, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Path tiles each " + nice + " member covers", visibility: vis,
			format: function (v) { return "Tiles per " + STAFF_WORD[kind].one + ": " + v; },
			onChange: function (v) { setPer(kind, Math.max(1, v)); refreshWindow(); }
		}));
	}

	controls.push(label({ text: neededTextStore[kind], height: 12, visibility: vis }));
	controls.push(makeMiniProgressBar(availPercentStore[kind], vis));
	controls.push(label({ text: deltaTextStore[kind], height: 12, visibility: vis }));

	return box({
		text: pk.title,
		visibility: vis,
		content: horizontal({
			spacing: 6,
			content: [icon, vertical({ spacing: 2, content: controls })]
		})
	});
}

let mainWindowTemplate: WindowTemplate | null = null;

function buildMechanicsBox(): WidgetCreator<FlexiblePosition> {
	const vis: Store<ElementVisibility> = tabVisibility(TAB_MECHANIC);
	const mechanicIcon = makeIconWidget(30, 30, staffSprite("mechanic"), "Mechanics", vis);
	const mechanicControls: WidgetCreator<FlexiblePosition>[] = [
		horizontal({
			spacing: 4,
			content: [
				label({ text: "Inspect:", width: 60, height: 12, visibility: vis }),
				dropdown({
					items: INSPECTION_LABELS, selectedIndex: inspectIndexStore, visibility: vis,
					tooltip: "Applies to all rides, independent of ride type",
					onChange: function (index) { setInspection(index); applyInspectionAll(); }
				})
			]
		}),
		button({ text: "Apply inspection interval to all rides", height: 16, visibility: vis, onClick: function () { applyInspectionAll(); } }),
		makeMiniProgressBar(availPercentStore.mechanic, vis),
		label({ text: deltaTextStore.mechanic, height: 12, visibility: vis })
	];
	return box({
		text: "Mechanics",
		visibility: vis,
		content: horizontal({ spacing: 6, content: [mechanicIcon, vertical({ spacing: 2, content: mechanicControls })] })
	});
}

function switchTab(tabIndex: number): void {
	activeTabStore.set(tabIndex);
}

function buildMainWindowTemplate(calculated: boolean): WindowTemplate {
	// Icon-style tab strip (mirrors the native ride/staff window tabs): each
	// tab is an image button showing that staff type's icon, with a pressed/
	// border state indicating the active tab.
	const tabButtons: WidgetCreator<FlexiblePosition>[] = TABS.map(function (tab) {
		return button({
			image: staffSprite(tab.kind), width: 31, height: 27,
			tooltip: tab.label,
			isPressed: flexCompute(activeTabStore, function (active) { return active === tab.index; }),
			onClick: function () { switchTab(tab.index); }
		});
	});

	// All tab boxes are always present in the layout; only the active one is
	// visible (visibility: "none" removes it from layout entirely), so
	// switching tabs never needs to close/rebuild/reopen the native window -
	// avoiding duplicate/stacked windows.
	const handymanBox = makePathSection(PATH_KINDS.filter(function (p) { return p.kind === "handyman"; })[0]);
	const guardBox = makePathSection(PATH_KINDS.filter(function (p) { return p.kind === "security"; })[0]);
	const mascotBox = makePathSection(PATH_KINDS.filter(function (p) { return p.kind === "entertainer"; })[0]);

	// Bordered group: tab strip + active tab's content + Assign/Reset buttons
	// that act on whichever tab is currently selected. Hidden until the
	// calculation has been run at least once.
	const tabsAndActionsBox: WidgetCreator<FlexiblePosition> = box({
		text: "Selected staff type",
		height: 220,
		content: vertical({
			spacing: 4,
			content: [
				horizontal({ spacing: 2, content: tabButtons }),
				handymanBox, buildMechanicsBox(), guardBox, mascotBox,
				horizontal({
					spacing: 4,
					content: [
						button({
							text: "Assign", height: 18,
							tooltip: "Assign the selected staff type now (offers to hire, fire, or use only existing staff)",
							onClick: function () { assignActiveTab(); }
						}),
						button({
							text: "Reset", height: 18,
							tooltip: "Clear the patrol area assignments of the selected staff type (after confirming)",
							onClick: function () { resetActiveTab(); }
						})
					]
				})
			]
		})
	});

	// Gate shown before the first calculation: a big "Calculate" button
	// plus a progress bar, filling the entire window content area and
	// completely replacing (not just dimming) the tabs/buttons until the scan
	// finishes. Wrapped in a single box with one visibility toggle so it acts
	// as one overlay unit instead of many individually-gated widgets.
	const gateBox: WidgetCreator<FlexiblePosition> = box({
		width: "1w", height: "1w",
		content: vertical({
			spacing: 6,
			content: [
				button({
					text: "Calculate",
					border: true,
					width: "1w", height: 64,
					tooltip: "Scan the park and calculate staff needs (non-blocking, runs in the background)",
					onClick: function () { runCalculation(); }
				}),
							vertical({
								spacing: 2,
								content: [
									label({ text: workBarTextStore, height: 14, alignment: "centred" }),
									label({ text: workPctTextStore, height: 12, alignment: "centred" })
								]
							})
						]
						})
					});

					// Main content shown once calculation has completed at least once.
					const mainBox: WidgetCreator<FlexiblePosition> = vertical({
						spacing: 6,
						content: [
								tabsAndActionsBox,
									horizontal({
										height: 18,
										spacing: 4,
										content: [
											button({
												text: "Assign all", height: 18,
												tooltip: "Assign mechanics and all path-staff types now (offers to hire/fire as needed)",
												onClick: function () { assignAllNow(); }
											}),
											button({
												text: "Reset all", height: 18,
												tooltip: "Clear the patrol areas and persisted assignments of every staff type (mechanics included), after confirming",
												onClick: function () { resetAllStaffConfirm(); }
											})
										]
									}),
									vertical({
										height: 30,
										spacing: 2,
										content: [
											label({ text: workBarTextStore, height: 14, alignment: "centred" }),
											label({ text: workPctTextStore, height: 12, alignment: "centred" })
										]
									})
								]
							});

					// Only the relevant top-level section is ever included in the window's
					// content array (rather than including both and toggling visibility),
					// since toggling visibility on top-level weighted ("1w") boxes does not
					// reliably relayout in this flexui prerelease - the same reason tabs are
					// implemented by rebuilding/reopening the window instead of hiding boxes.
					const sections: WidgetCreator<FlexiblePosition>[] = calculated ? [mainBox] : [gateBox];

					return flexWindow({
						title: "Staff Manager",
						width: 300, height: 300,
						minWidth: 280, maxWidth: 620, minHeight: 300, maxHeight: 900,
						colours: [24, 24],
						spacing: 6,
						content: sections
					});
				}

function openWindow(): void {
	if (mainWindowTemplate) { mainWindowTemplate.close(); }
	mainWindowTemplate = buildMainWindowTemplate(calculated);
	mainWindowTemplate.open();
	mainWindowTemplate.focus();
	// flexui only updates a widget's "skip" (layout-exclusion) flag inside a
	// store's change subscription, never on initial creation - so every tab
	// box starts included in the layout (all stacked on top of each other)
	// until its visibility store fires at least one change. Re-emitting the
	// active tab here forces all tab boxes to apply their correct skip state
	// before the user sees the window.
	activeTabStore.set(activeTabStore.get());
}

// --- Main ------------------------------------------------------------------
function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Manager", function () { openWindow(); });
	}
}

registerPlugin({
	name: "Staff Manager",
	version: "1.0.0",
	authors: ["Johannes"],
	type: "local",
	licence: "MIT",
	minApiVersion: 34,
	targetApiVersion: 77,
	main: main
});

/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
import {
	window as flexWindow, box, horizontal, vertical, label, button, spinner, toggle, dropdown,
	store as flexStore, compute as flexCompute, WindowTemplate, WidgetCreator, FlexiblePosition, Store
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

const TRIGGER_ACTIONS: { [action: string]: boolean } = {
	staffhire: true, stafffire: true,
	rideentranceexitplace: true, rideentranceexitremove: true,
	ridedemolish: true
};

// Actions that change the park's path layout / ownership -> re-run path staff.
const PATH_TRIGGER_ACTIONS: { [action: string]: boolean } = {
	footpathplace: true, footpathremove: true,
	landsetrights: true, landbuyrights: true,
	staffhire: true, stafffire: true
};

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
	entertainer: { one: "mascot",    many: "mascots"   }
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
function makeIconWidget(width: number, height: number, sprite: number, tooltip: string): WidgetCreator<FlexiblePosition> {
	return button({ image: sprite, border: false, width: width, height: height, tooltip: tooltip });
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
function getAuto(): boolean { return store().get("auto", false); }
function setAuto(v: boolean): void { store().set("auto", v); }
// Auto hire/fire + assign per path-staff type (handyman/security/entertainer).
function getAutoKind(kind: StaffKind): boolean { return store().get("auto_" + kind, false); }
function setAutoKind(kind: StaffKind, v: boolean): void { store().set("auto_" + kind, v); }
// True if ANY path-staff type has auto enabled.
function anyAutoPath(): boolean {
	return getAutoKind("handyman") || getAutoKind("security") || getAutoKind("entertainer");
}
// True if EVERY staff type (all path-staff kinds + mechanics) has auto enabled.
function allAutoEnabled(): boolean {
	return getAutoKind("handyman") && getAutoKind("security") && getAutoKind("entertainer") && getAuto();
}
// Enable/disable auto mode for all staff types (path-staff kinds + mechanics) at once.
function setAllAuto(v: boolean): void {
	PATH_KINDS.forEach(function (pk) { setAutoKind(pk.kind, v); });
	setAuto(v);
	if (v) {
		scheduleAutoPath();
		scheduleAutoMech();
	}
}
// Assign every staff type now (mechanics + all path-staff kinds), each
// offering to hire/fire as needed via their usual confirmation dialogs.
function assignAllNow(): void {
	PATH_KINDS.forEach(function (pk) { assignPathStaff(pk.kind, pk.nice); });
	assignMechanicsWithHire();
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

function assignMechanics(): AssignMechanicsResult {
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

	for (let n = 0; n < pairs; n++) {
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
		if (bestE < 0) { break; }
		const e = uncovered[bestE];
		const mech = free[bestF];
		doneExit[bestE] = true;
		usedFree[bestF] = true;
		assignments[e.key] = mech.id as number;
		setPatrol(mech, e.exit);
		recordAssignment(lastArea, mech.id as number, e.exit.x, e.exit.y, counts);
		newRideIds[keyRideId(e.key)] = true;
		assigned++;
	}
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
	return { assigned: assigned, reassigned: counts.moved, inspected: inspected,
			 covered: covered, totalExits: exits.length };
}

function assignMechanicsReport(): void {
	const r = assignMechanics();
	const reassignTxt = r.reassigned > 0 ? (" (" + r.reassigned + " reassigned)") : "";
	park.postMessage({
		type: "blank",
		text: "Mechanics: " + r.assigned + " assigned" + reassignTxt +
			  ", inspection on " + r.inspected + " ride(s). Covered " +
			  r.covered + "/" + r.totalExits + " exits."
	});
	refreshWindow();
}

// Button entry: offer to hire mechanics if there aren't enough for all exits.
function assignMechanicsWithHire(): void {
	const exits = allExits().length;
	const have = allMechanics().length;
	if (exits > have) {
		const deficit = exits - have;
		confirmDialog([
			"Covering all ride exits needs " + staffWord("mechanic", exits) + ",",
			"but only " + have + " exist.",
			"Hire " + staffWord("mechanic", deficit) + "?"
		], "Hire " + staffWord("mechanic", deficit),
		function () {
			hireStaff("mechanic", deficit, function () { assignMechanicsReport(); });
		}, "Assign without hiring/firing",
		function () { assignMechanicsReport(); });
	} else if (exits < have) {
		// Only non-busy mechanics can actually be fired.
		const fireable = allMechanics().filter(function (m) { return !mechanicIsBusy(m); }).length;
		const surplus = Math.min(have - exits, fireable);
		if (surplus <= 0) {
			assignMechanicsReport();
		} else {
			confirmDialog([
				"Only " + staffWord("mechanic", exits) + " needed for the exits,",
				"but " + have + " exist.",
				"Fire " + staffWord("mechanic", surplus) + " (newest, non-busy first)?"
			], "Fire " + staffWord("mechanic", surplus),
			function () {
				fireStaff("mechanic", surplus, function () { assignMechanicsReport(); });
			}, "Assign without hiring/firing",
			function () { assignMechanicsReport(); });
		}
	} else {
		assignMechanicsReport();
	}
}

// --- Automatic mechanic assignment (event-driven) --------------------------
// Silently right-sizes the mechanic workforce (hire missing / fire surplus,
// newest & non-busy first) then assigns. No dialogs on the auto path.
let autoBusy = false;   // re-entrancy guard: our own hire/fire retrigger this
// Debounce token for mechanics-auto, mirroring the path-auto debounce below.
// This coalesces bursts of trigger actions into a single run instead of
// stacking overlapping autoRightSizeAndAssign() calls.
let autoMechToken = 0;
const AUTO_MECH_DEBOUNCE_MS = 250;

function scheduleAutoMech(): void {
	autoMechToken++;
	const myToken = autoMechToken;
	context.setTimeout(function () {
		if (myToken !== autoMechToken) { return; }   // superseded by a newer trigger
		autoRightSizeAndAssign();
	}, AUTO_MECH_DEBOUNCE_MS);
}

function autoRightSizeAndAssign(): void {
	// Guard against both our own mechanics hire/fire AND the path-staff auto's
	// hire/fire (staffhire/stafffire actions are shared triggers for both
	// subsystems; without checking autoPathBusy too, the two auto systems can
	// endlessly re-trigger each other and freeze the game).
	if (autoBusy || autoPathBusy) { return; }
	const exits = allExits().length;
	const have = allMechanics().length;

	if (exits > have) {
		autoBusy = true;
		hireStaff("mechanic", exits - have, function () {
			autoBusy = false;
			assignMechanics();
			refreshWindow();
		});
	} else if (exits < have) {
		const fireable = allMechanics().filter(function (m) { return !mechanicIsBusy(m); }).length;
		const surplus = Math.min(have - exits, fireable);
		if (surplus > 0) {
			autoBusy = true;
			fireStaff("mechanic", surplus, function () {
				autoBusy = false;
				assignMechanics();
				refreshWindow();
			});
		} else {
			assignMechanics();
			refreshWindow();
		}
	} else {
		assignMechanics();
		refreshWindow();
	}
}

// --- Auto path staff (handymen/security/mascots): hire/fire + assign --------
// Path staff need a full map scan, and path-dragging fires MANY footpathplace
// actions, so runs are COALESCED (debounced) into a single pass.
let autoPathBusy = false;      // re-entrancy guard for our own hire/fire
let autoPathToken = 0;         // debounce token
const AUTO_PATH_DEBOUNCE_MS = 1500;

function scheduleAutoPath(): void {
	autoPathToken++;
	const myToken = autoPathToken;
	context.setTimeout(function () {
		if (myToken !== autoPathToken) { return; }   // superseded by a newer trigger
		autoPathRun();
	}, AUTO_PATH_DEBOUNCE_MS);
}

function autoPathRun(): void {
	if (autoPathBusy || autoBusy || busy) {
		// Something is scanning/working; try again shortly.
		scheduleAutoPath();
		return;
	}
	ensureScan(true, function (tiles) {
		if (!tiles || tiles.length === 0) { refreshWindow(); return; }
		autoPathBusy = true;
		rightSizePathKindsSequential(0, tiles, function () {
			autoPathBusy = false;
			refreshWindow();
		});
	});
}

// Process PATH_KINDS one at a time (hire/fire then assign), chaining callbacks.
// Only kinds whose per-type auto toggle is enabled are processed.
function rightSizePathKindsSequential(i: number, ignored: ScanTile[], done: () => void): void {
	if (i >= PATH_KINDS.length) { done(); return; }
	const pk = PATH_KINDS[i];
	const next = function () { rightSizePathKindsSequential(i + 1, ignored, done); };

	if (!getAutoKind(pk.kind)) { next(); return; }   // this type's auto is off

	// Each kind may target a different tile set (mascots -> queues).
	const tiles = tilesForKind(pk.kind);
	if (!tiles || tiles.length === 0) { next(); return; }

	const have = assignableOfKind(pk.kind).length;
	const need = neededForKind(pk.kind, tiles.length);

	if (need > have) {
		hireStaff(pk.kind, need - have, function () {
			doPathAssign(pk.kind, pk.nice, tiles, next);
		});
	} else if (need < have) {
		fireStaff(pk.kind, have - need, function () {
			doPathAssign(pk.kind, pk.nice, tiles, next);
		});
	} else {
		doPathAssign(pk.kind, pk.nice, tiles, next);
	}
}

let autoSub: IDisposable | null = null;
function startAuto(): void {
	if (autoSub !== null) { return; }
	autoSub = context.subscribe("action.execute", function (e) {
		if (network.mode === "client") { return; }

		// --- Mechanics auto (debounced) ---
		if (getAuto() && TRIGGER_ACTIONS[e.action]) {
			// Ignore our own hire/fire AND the path-staff auto's hire/fire, to
			// avoid the two auto systems endlessly re-triggering each other.
			if (!((autoBusy || autoPathBusy) && (e.action === "staffhire" || e.action === "stafffire"))) {
				scheduleAutoMech();
			}
		}

		// --- Path staff auto (debounced) ---
		if (anyAutoPath() && PATH_TRIGGER_ACTIONS[e.action]) {
			// Ignore our own hire/fire AND the mechanics auto's hire/fire, to
			// avoid the two auto systems endlessly re-triggering each other.
			if ((autoPathBusy || autoBusy) && (e.action === "staffhire" || e.action === "stafffire")) { return; }
			scheduleAutoPath();
		}
	});
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

// BFS from the entrance over connected footpaths. Returns reachable, owned
// tiles split into { paths: [...], queues: [...] } (queues are traversed so
// paths beyond a queue are still reached).
function reachableOwnedTiles(pathInfo: { [key: string]: PathTileInfo }, seeds: ScanSeed[]): ReachableTiles {
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
	while (head < q.length) {
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
	}
	return { paths: paths, queues: queues };
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
const MATCH_PAIRS_PER_TICK = 25;
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
	refreshWindow();
	scanMapAsync(function (pct) {
		scanProgress = pct; refreshWindow();
	}, function (pathInfo, seeds) {
		const res = reachableOwnedTiles(pathInfo, seeds);
		cachedTiles = res.paths.sort(sortTiles);
		cachedQueues = res.queues.sort(sortTiles);
		pathsScanned = true;
		scanProgress = -1;
		busy = false;
		refreshWindow();
		onDone(cachedTiles);
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
const MASCOT_PLACEMENTS_PER_TICK = 10;
function assignMascots(tiles: ScanTile[], onDone?: () => void): void {
	const mascots = assignableOfKind("entertainer");
	if (mascots.length === 0) {
		park.postMessage({ type: "blank", text: "No mascots available." });
		refreshWindow();
		if (onDone) { onDone(); }
		return;
	}
	const tilesPer = mascotTilesPer();
	const perArea = Math.max(1, getMascotPerArea());
	const areaSize = Math.max(1, tilesPer);
	const numAreas = Math.ceil(tiles.length / areaSize);

	assignProgress = 0;
	refreshWindow();
	partitionAsync(tiles, numAreas, function (pct) {
		assignProgress = Math.floor(pct * 0.7); refreshWindow();
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
			refreshWindow();
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
	refreshWindow();
	partitionAsync(tiles, staff.length, function (pct) {
		assignProgress = Math.floor(pct * 0.5); refreshWindow();
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
			refreshWindow();
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
function assignPathStaff(kind: StaffKind, niceName: string): void {
	if (busy) {
		park.postMessage({ type: "blank", text: "Staff Manager is busy scanning..." });
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
			return;
		}
		const have = assignableOfKind(kind).length;
		const need = neededForKind(kind, tiles.length);
		busy = true;
		function finishAssign(): void { busy = false; refreshWindow(); }
		if (need > have) {
			const deficit = need - have;
			confirmDialog([
				"Full coverage needs " + staffWord(kind, need) + ",",
				"but only " + have + " available.",
				"Hire " + staffWord(kind, deficit) + "?"
			], "Hire " + staffWord(kind, deficit),
			function () {
				hireStaff(kind, deficit, function () { doPathAssign(kind, niceName, tiles, finishAssign); });
			}, "Assign without hiring/firing",
			function () {
				doPathAssign(kind, niceName, tiles, finishAssign);
			});
		} else if (need < have) {
			const surplus = have - need;
			confirmDialog([
				"Coverage needs only " + staffWord(kind, need) + ",",
				"but " + have + " are available.",
				"Fire " + staffWord(kind, surplus) + " (newest first)?"
			], "Fire " + staffWord(kind, surplus),
			function () {
				fireStaff(kind, surplus, function () { doPathAssign(kind, niceName, tiles, finishAssign); });
			}, "Assign without hiring/firing",
			function () {
				doPathAssign(kind, niceName, tiles, finishAssign);
			});
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
function resetAllStaff(): void {
	const ids: number[] = [];
	PATH_KINDS.forEach(function (pk) {
		allStaffOfType(pk.kind).forEach(function (s) {
			if (s.patrolArea) { s.patrolArea.clear(); }
			ids.push(s.id as number);
		});
	});
	allStaffOfType("mechanic").forEach(function (s) {
		if (s.patrolArea) { s.patrolArea.clear(); }
		ids.push(s.id as number);
	});
	setAssignments({});
	forgetLastArea(ids);
	park.postMessage({ type: "blank", text: "Cleared all assignments." });
	refreshWindow();
}

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
const progressBarTextStore: Store<string> = flexCompute(progressPercentStore, function (pct) {
	const totalTicks = 24;
	const filled = Math.max(0, Math.min(totalTicks, Math.round((pct / 100) * totalTicks)));
	return "[" + repeatChar("=", filled) + repeatChar(".", totalTicks - filled) + "] " + pct + "%";
});

function repeatChar(ch: string, count: number): string {
	let s = "";
	for (let i = 0; i < count; i++) { s += ch; }
	return s;
}

let progressTemplate: WindowTemplate | null = null;

function progressWindowTemplate(): WindowTemplate {
	if (!progressTemplate) {
		progressTemplate = flexWindow({
			title: "Moving staff",
			width: 260, height: 70,
			minWidth: 260, maxWidth: 260, minHeight: 70, maxHeight: 70,
			colours: [24, 24],
			spacing: 4,
			content: [
				label({ text: progressLabelStore, height: 12, alignment: "centred" }),
				label({ text: progressBarTextStore, height: 16, alignment: "centred" })
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
	{ kind: "entertainer", nice: "mascots",   title: "Mascots (entertainers)" }
];

function autoAllLabel(): string {
	return allAutoEnabled() ? "Deactivate automatic mode for all" : "Activate automatic mode for all";
}

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
		   "  |  Exits covered: " + covered +
		   "  |  Auto: " + (getAuto() ? "ON" : "OFF");
}

const statusStore: { [kind in StaffKind]: Store<string> } = {
	handyman: flexStore(""), security: flexStore(""), entertainer: flexStore(""), mechanic: flexStore("")
};
const perStore: { handyman: Store<number>; security: Store<number> } = {
	handyman: flexStore(getPer("handyman")),
	security: flexStore(getPer("security"))
};
const autoKindStore: { [kind in StaffKind]: Store<boolean> } = {
	handyman: flexStore(false), security: flexStore(false), entertainer: flexStore(false), mechanic: flexStore(false)
};
const mascotQueuesStore: Store<boolean> = flexStore(getMascotQueues());
const mascotQueuePerStore: Store<number> = flexStore(getMascotQueuePer());
const mascotPathPerStore: Store<number> = flexStore(getMascotPathPer());
const mascotPerAreaStore: Store<number> = flexStore(getMascotPerArea());
const inspectIndexStore: Store<number> = flexStore(getInspection());
const mechStatusStore: Store<string> = flexStore("");
const autoAllLabelStore: Store<string> = flexStore(autoAllLabel());

function refreshWindow(): void {
	PATH_KINDS.forEach(function (pk) {
		statusStore[pk.kind].set(pathStatusText(pk.kind, pk.nice));
		autoKindStore[pk.kind].set(getAutoKind(pk.kind));
	});
	perStore.handyman.set(getPer("handyman"));
	perStore.security.set(getPer("security"));
	mascotQueuesStore.set(getMascotQueues());
	mascotQueuePerStore.set(getMascotQueuePer());
	mascotPathPerStore.set(getMascotPathPer());
	mascotPerAreaStore.set(getMascotPerArea());
	inspectIndexStore.set(getInspection());
	mechStatusStore.set(mechStatusText());
	autoKindStore.mechanic.set(getAuto());
	autoAllLabelStore.set(autoAllLabel());
}

function makePathSection(pk: PathKindDef): WidgetCreator<FlexiblePosition> {
	const kind = pk.kind;
	const nice = pk.nice;
	const icon = makeIconWidget(30, 30, staffSprite(kind), pk.title);
	const controls: WidgetCreator<FlexiblePosition>[] = [];

	if (kind === "entertainer") {
		// Mascots: queue toggle + three dedicated density options.
		controls.push(toggle({
			text: "Assign to queue lines (not paths)", height: 14,
			tooltip: "Place mascots along ride queues to keep queuing guests happy",
			isPressed: mascotQueuesStore,
			onChange: function (checked) { setMascotQueues(checked); refreshWindow(); }
		}));
		controls.push(spinner({
			value: mascotQueuePerStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Maximum queue tiles each mascot covers (queue mode)",
			format: function (v) { return "Queue tiles/mascot: " + v; },
			onChange: function (v) { setMascotQueuePer(Math.max(1, v)); refreshWindow(); }
		}));
		controls.push(spinner({
			value: mascotPathPerStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Path tiles each mascot covers (path mode)",
			format: function (v) { return "Path tiles/mascot: " + v; },
			onChange: function (v) { setMascotPathPer(Math.max(1, v)); refreshWindow(); }
		}));
		controls.push(spinner({
			value: mascotPerAreaStore, minimum: 1, maximum: 9999, height: 14,
			tooltip: "How many mascots share each area (>1 = overlapping)",
			format: function (v) { return "Mascots per area: " + v; },
			onChange: function (v) { setMascotPerArea(Math.max(1, v)); refreshWindow(); }
		}));
	} else {
		// Handymen / security: single density spinner.
		const perS: Store<number> = kind === "handyman" ? perStore.handyman : perStore.security;
		controls.push(spinner({
			value: perS, minimum: 1, maximum: 9999, height: 14,
			tooltip: "Path tiles each " + nice + " member covers",
			format: function (v) { return "Path tiles per staff: " + v; },
			onChange: function (v) { setPer(kind, Math.max(1, v)); refreshWindow(); }
		}));
	}

	controls.push(label({ text: statusStore[kind], height: 12 }));
	controls.push(button({
		text: "Calculate & assign " + nice + " areas", height: 16,
		tooltip: "Scan (non-blocking) and split reachable/owned paths among " + nice,
		onClick: function () { assignPathStaff(kind, nice); }
	}));
	controls.push(button({
		text: "Recalculate needed " + nice, height: 16,
		tooltip: "Rescan and refresh the Needed/Hired counts, without hiring, firing or (re)assigning anyone",
		onClick: function () { recalcPathNeeded(kind, nice); }
	}));
	controls.push(toggle({
		text: "Auto: hire/fire + assign on path changes", height: 12,
		tooltip: "Automatically keep " + nice + " right-sized and assigned when paths, land rights or staff change (newest first)",
		isPressed: autoKindStore[kind],
		onChange: function (checked) {
			setAutoKind(kind, checked);
			if (checked) { scheduleAutoPath(); }
			refreshWindow();
		}
	}));
	controls.push(button({
		text: "Reset " + nice + " assignments", height: 14,
		tooltip: "Clear the patrol areas (and persisted assignments) of all " + nice + " without hiring or firing anyone",
		onClick: function () { resetStaffType(kind); }
	}));

	return box({
		text: pk.title,
		content: horizontal({
			spacing: 6,
			content: [icon, vertical({ spacing: 2, content: controls })]
		})
	});
}

let mainWindowTemplate: WindowTemplate | null = null;

function buildMainWindowTemplate(): WindowTemplate {
	const sections: WidgetCreator<FlexiblePosition>[] = [
		button({
			text: "Assign all", height: 18,
			tooltip: "Assign mechanics and all path-staff types now (offers to hire/fire as needed)",
			onClick: function () { assignAllNow(); }
		}),
		button({
			text: autoAllLabelStore, height: 18,
			tooltip: "Toggle automatic hire/fire + assign for mechanics and all path-staff types",
			onClick: function () { setAllAuto(!allAutoEnabled()); refreshWindow(); }
		}),
		button({
			text: "Reset all assignments", height: 18,
			tooltip: "Clear the patrol areas and persisted assignments of every staff type (mechanics included) without hiring or firing anyone",
			onClick: function () { resetAllStaff(); }
		})
	];

	PATH_KINDS.forEach(function (pk) { sections.push(makePathSection(pk)); });

	const mechanicIcon = makeIconWidget(30, 30, staffSprite("mechanic"), "Mechanics");
	const mechanicControls: WidgetCreator<FlexiblePosition>[] = [
		horizontal({
			spacing: 4,
			content: [
				label({ text: "Inspect:", width: 60, height: 12 }),
				dropdown({
					items: INSPECTION_LABELS, selectedIndex: inspectIndexStore,
					tooltip: "Applies to all rides, independent of ride type",
					onChange: function (index) { setInspection(index); applyInspectionAll(); }
				})
			]
		}),
		button({ text: "Apply inspection interval to all rides", height: 16, onClick: function () { applyInspectionAll(); } }),
		button({
			text: "Assign mechanics to exits now", height: 18,
			tooltip: "Assign mechanics to ride exits (offers to hire if there aren't enough)",
			onClick: function () { assignMechanicsWithHire(); }
		}),
		button({
			text: "Recalculate needed mechanics", height: 16,
			tooltip: "Refresh the exits-covered/mechanics counts, without hiring, firing or (re)assigning anyone",
			onClick: function () { refreshWindow(); }
		}),
		toggle({
			text: "Auto mechanics (hire/fire + assign)", height: 12,
			tooltip: "On exit/staff changes, automatically hire missing or fire surplus mechanics (newest, non-busy first) and assign them to exits",
			isPressed: autoKindStore.mechanic,
			onChange: function (checked) {
				setAuto(checked);
				if (checked) { autoRightSizeAndAssign(); }
				refreshWindow();
			}
		}),
		button({
			text: "Reset mechanics assignments", height: 16,
			tooltip: "Clear every mechanic's patrol area and the persisted exit->mechanic map, without hiring or firing anyone",
			onClick: function () { resetStaffType("mechanic"); }
		}),
		label({ text: mechStatusStore, height: 16 })
	];
	sections.push(box({
		text: "Mechanics",
		content: horizontal({ spacing: 6, content: [mechanicIcon, vertical({ spacing: 2, content: mechanicControls })] })
	}));

	return flexWindow({
		title: "Staff Manager",
		width: 300, height: 500,
		minWidth: 280, maxWidth: 620, minHeight: 400, maxHeight: 900,
		colours: [24, 24],
		spacing: 6,
		content: sections
	});
}

function openWindow(): void {
	if (!mainWindowTemplate) { mainWindowTemplate = buildMainWindowTemplate(); }
	mainWindowTemplate.open();
	mainWindowTemplate.focus();
	// Calculate the initial Needed/Hired numbers right away instead of
	// waiting for the user to press "Recalculate needed".
	ensureScan(false, function () {
		refreshWindow();
	});
}

// --- Main ------------------------------------------------------------------
function main(): void {
	if (typeof ui !== "undefined") {
		ui.registerMenuItem("Staff Manager", function () { openWindow(); });
	}
	startAuto();
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

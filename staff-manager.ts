/// <reference path="node_modules/@openrct2/types/openrct2.d.ts" />
/*****************************************************************************
 * Staff Manager
 * ---------------------------------------------------------------------------
 * Manages park staff by patrol area:
 *   - HANDYMEN, SECURITY, MASCOTS (entertainers): split the park's paths into
 *     equal contiguous areas (mascots optionally into overlapping areas with
 *     several mascots each).
 *   - MECHANICS: assign to ride exits (one per exit, 4x4 area) + inspection.
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

// Staff-type icon sprite (2618 = SPR_TERRAIN_STAFF, always valid).
const SPR_STAFF = 2618;
const STAFF_SPRITE: { [kind in StaffKind]: number } = {
	handyman: SPR_STAFF, security: SPR_STAFF,
	entertainer: SPR_STAFF, mechanic: SPR_STAFF
};

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
function getAssignments(): { [key: string]: number } { return store().get("assignments", {}); }
function setAssignments(v: { [key: string]: number }): void { store().set("assignments", v); }
function getPer(kind: StaffKind): number { return store().get("per_" + kind, 25); }
function setPer(kind: StaffKind, v: number): void { store().set("per_" + kind, v); }
// Last-assigned area centre per peep id, to detect reassignment ("moved").
function getLastArea(): { [peepId: number]: string } { return store().get("lastArea", {}); }
function setLastArea(v: { [peepId: number]: string }): void { store().set("lastArea", v); }
// Mascot options:
//  - queue tiles per mascot (max) : density when assigning to queue lines
//  - path tiles per mascot        : density when assigning to general paths
//  - mascots per area             : how many mascots share each area (>1 = overlap)
function getMascotQueuePer(): number { return store().get("mascotQueuePer", 8); }
function setMascotQueuePer(v: number): void { store().set("mascotQueuePer", v); }
function getMascotPathPer(): number { return store().get("mascotPathPer", 25); }
function setMascotPathPer(v: number): void { store().set("mascotPathPer", v); }
function getMascotPerArea(): number { return store().get("mascotPerArea", 1); }
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

function patrol4x4(exit: CoordsXY): CoordsXY[] {
	const tiles: CoordsXY[] = [];
	for (let dx = 0; dx < 4; dx++) {
		for (let dy = 0; dy < 4; dy++) {
			tiles.push({ x: exit.x + dx * TILE, y: exit.y + dy * TILE });
		}
	}
	return tiles;
}

function setPatrol(mechanic: Staff | null, exit: CoordsXY): void {
	if (!mechanic || !mechanic.patrolArea) { return; }
	mechanic.patrolArea.clear();
	mechanic.patrolArea.add(patrol4x4(exit));
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

// --- Confirm dialog (small Yes/No window) ----------------------------------
const CONFIRM_TAG = "smp_confirm";
let confirmYesCb: (() => void) | null = null;
let confirmNoCb: (() => void) | null = null;

function closeConfirm(): void {
	const w = ui.getWindow(CONFIRM_TAG);
	if (w) { w.close(); }
}

function confirmDialog(lines: string[], yesLabel: string, onYes: () => void, onNo: () => void): void {
	closeConfirm();
	confirmYesCb = onYes;
	confirmNoCb = onNo;
	const widgets: WidgetDesc[] = [];
	for (let i = 0; i < lines.length; i++) {
		widgets.push({ type: "label", x: 12, y: 22 + i * 13, width: 296, height: 12, text: lines[i] });
	}
	const by = 26 + lines.length * 13;
	widgets.push({
		type: "button", x: 24, y: by, width: 130, height: 18, text: yesLabel || "Yes",
		onClick: function () { const f = confirmYesCb; closeConfirm(); if (f) { f(); } }
	});
	widgets.push({
		type: "button", x: 166, y: by, width: 130, height: 18, text: "Cancel",
		onClick: function () { const f = confirmNoCb; closeConfirm(); if (f) { f(); } }
	});
	ui.openWindow({
		classification: CONFIRM_TAG,
		width: 320, height: by + 28,
		title: "Staff Manager",
		colours: [24, 24],
		widgets: widgets
	});
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
		}, function () { assignMechanicsReport(); });
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
			}, function () { assignMechanicsReport(); });
		}
	} else {
		assignMechanicsReport();
	}
}

// --- Automatic mechanic assignment (event-driven) --------------------------
// Silently right-sizes the mechanic workforce (hire missing / fire surplus,
// newest & non-busy first) then assigns. No dialogs on the auto path.
let autoBusy = false;   // re-entrancy guard: our own hire/fire retrigger this

function autoRightSizeAndAssign(): void {
	if (autoBusy) { return; }
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
	if (autoPathBusy || busy) {
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
			doPathAssign(pk.kind, pk.nice, tiles);
			next();
		});
	} else if (need < have) {
		fireStaff(pk.kind, have - need, function () {
			doPathAssign(pk.kind, pk.nice, tiles);
			next();
		});
	} else {
		doPathAssign(pk.kind, pk.nice, tiles);
		next();
	}
}

let autoSub: IDisposable | null = null;
function startAuto(): void {
	if (autoSub !== null) { return; }
	autoSub = context.subscribe("action.execute", function (e) {
		if (network.mode === "client") { return; }

		// --- Mechanics auto (immediate) ---
		if (getAuto() && TRIGGER_ACTIONS[e.action]) {
			if (!(autoBusy && (e.action === "staffhire" || e.action === "stafffire"))) {
				context.setTimeout(function () { autoRightSizeAndAssign(); }, 10);
			}
		}

		// --- Path staff auto (debounced) ---
		if (anyAutoPath() && PATH_TRIGGER_ACTIONS[e.action]) {
			// Ignore our own hire/fire actions to avoid a loop.
			if (autoPathBusy && (e.action === "staffhire" || e.action === "stafffire")) { return; }
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

function partition<T>(arr: T[], n: number): T[][] {
	const chunks: T[][] = [];
	if (n <= 0) { return chunks; }
	const per = Math.ceil(arr.length / n);
	for (let i = 0; i < n; i++) {
		const slice = arr.slice(i * per, (i + 1) * per);
		if (slice.length > 0) { chunks.push(slice); }
	}
	return chunks;
}

// Centre tile of a zone (chunk of tiles).
function zoneCentre(chunk: ScanTile[]): ScanTile {
	return chunk[Math.floor(chunk.length / 2)];
}

// Greedily match staff to their NEAREST free zone, minimising walking.
// Repeatedly picks the globally-closest (staff, zone) pair until one side runs
// out. Returns an array `assign` where assign[staffIndex] = zoneIndex (or -1).
// `staff` are entities with x/y; `chunks` is an array of tile arrays.
function matchNearestZones(staff: Staff[], chunks: ScanTile[][]): number[] {
	const assign: number[] = [];
	for (let s = 0; s < staff.length; s++) { assign[s] = -1; }
	const staffLeft = staff.length;
	const zonesLeft = chunks.length;
	const zoneTaken: boolean[] = [];
	const staffTaken: boolean[] = [];
	const centres: ScanTile[] = [];
	for (let z = 0; z < chunks.length; z++) {
		zoneTaken[z] = false;
		centres[z] = zoneCentre(chunks[z]);
	}
	for (let s2 = 0; s2 < staff.length; s2++) { staffTaken[s2] = false; }

	const pairs = Math.min(staffLeft, zonesLeft);
	for (let n = 0; n < pairs; n++) {
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
		if (bestS < 0) { break; }
		assign[bestS] = bestZ;
		staffTaken[bestS] = true;
		zoneTaken[bestZ] = true;
	}
	return assign;
}

// Cached scan result (shared by all path staff).
let cachedTiles: ScanTile[] | null = null;        // reachable, owned, non-queue path tiles
let cachedQueues: ScanTile[] | null = null;       // reachable, owned queue tiles
let pathsScanned = false;
let scanProgress = -1;

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
		// Mascots: density = tiles-per-mascot (queue or path mode).
		return Math.ceil(tileCount / mascotTilesPer());
	}
	return Math.ceil(tileCount / Math.max(1, getPer(kind)));
}

// Mascot placement. Each area holds `mascotsPerArea` mascots and spans
// tilesPerMascot * mascotsPerArea tiles (so density stays tiles-per-mascot).
// When mascotsPerArea > 1 the mascots in an area overlap.
function assignMascots(tiles: ScanTile[]): void {
	const mascots = assignableOfKind("entertainer");
	if (mascots.length === 0) {
		park.postMessage({ type: "blank", text: "No mascots available." });
		refreshWindow();
		return;
	}
	const tilesPer = mascotTilesPer();
	const perArea = Math.max(1, getMascotPerArea());
	const areaSize = Math.max(1, tilesPer * perArea);
	const numAreas = Math.ceil(tiles.length / areaSize);
	const areas = partition(tiles, numAreas);

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

	let assigned = 0;
	const areaUsed: { [index: number]: boolean } = {};
	const lastArea = getLastArea();
	const counts: AssignCounts = { fresh: 0, moved: 0 };
	const placements = Math.min(mascots.length, numAreas * perArea);

	for (let n = 0; n < placements; n++) {
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
		if (bestS < 0) { break; }
		const p = mascots[bestS];
		used[bestS] = true;
		cap[bestA]--;
		areaUsed[bestA] = true;
		if (p.patrolArea) {
			const area = areas[bestA];
			const t = centres[bestA];
			p.patrolArea.clear();
			p.patrolArea.add(area);
			try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) { /* ignore */ }
			recordAssignment(lastArea, p.id as number, t.x, t.y, counts);
			assigned++;
		}
	}
	let areasUsed = 0;
	for (const k in areaUsed) { areasUsed++; }
	setLastArea(lastArea);
	const tileWord = getMascotQueues() ? "queue" : "path";
	const overlapTxt = perArea > 1 ? (" (" + perArea + " per area, overlapping)") : "";
	park.postMessage({ type: "blank",
		text: "Mascots: " + assignSummary(counts) + " across " +
			  areasUsed + " " + tileWord + " area(s)" + overlapTxt + "." });
	refreshWindow();
}

function doPathAssign(kind: StaffKind, niceName: string, tiles: ScanTile[]): void {
	if (kind === "entertainer") {
		assignMascots(tiles);
		return;
	}
	const staff = assignableOfKind(kind);
	if (staff.length === 0) {
		park.postMessage({ type: "blank",
			text: "No assignable " + niceName + " available." });
		refreshWindow();
		return;
	}
	const chunks = partition(tiles, staff.length);
	// Match each staff member to its NEAREST zone (minimise walking).
	const assign = matchNearestZones(staff, chunks);
	let assigned = 0;
	const lastArea = getLastArea();
	const counts: AssignCounts = { fresh: 0, moved: 0 };
	for (let i = 0; i < staff.length; i++) {
		const p = staff[i];
		if (!p.patrolArea) { continue; }
		const zi = assign[i];
		if (zi < 0) { continue; }
		const chunk = chunks[zi];
		p.patrolArea.clear();
		if (chunk && chunk.length > 0) {
			p.patrolArea.add(chunk);
			const t = zoneCentre(chunk);
			try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) { /* ignore */ }
			recordAssignment(lastArea, p.id as number, t.x, t.y, counts);
			assigned++;
		}
	}
	setLastArea(lastArea);
	const tileWord = "path tiles";
	park.postMessage({ type: "blank",
		text: niceName + ": " + assignSummary(counts) + " over " +
			  tiles.length + " " + tileWord + "." });
	refreshWindow();
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
		if (need > have) {
			const deficit = need - have;
			confirmDialog([
				"Full coverage needs " + staffWord(kind, need) + ",",
				"but only " + have + " available.",
				"Hire " + staffWord(kind, deficit) + "?"
			], "Hire " + staffWord(kind, deficit),
			function () {
				hireStaff(kind, deficit, function () { doPathAssign(kind, niceName, tiles); });
			}, function () {
				doPathAssign(kind, niceName, tiles);
			});
		} else if (need < have) {
			const surplus = have - need;
			confirmDialog([
				"Coverage needs only " + staffWord(kind, need) + ",",
				"but " + have + " are available.",
				"Fire " + staffWord(kind, surplus) + " (newest first)?"
			], "Fire " + staffWord(kind, surplus),
			function () {
				fireStaff(kind, surplus, function () { doPathAssign(kind, niceName, tiles); });
			}, function () {
				doPathAssign(kind, niceName, tiles);
			});
		} else {
			doPathAssign(kind, niceName, tiles);
		}
	});
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
const WINDOW_TAG = "smp_window";

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

function wPer(kind: StaffKind): string    { return "smp_per_" + kind; }
function wStatus(kind: StaffKind): string { return "smp_st_" + kind; }
function wBtn(kind: StaffKind): string    { return "smp_btn_" + kind; }
function wRecalc(kind: StaffKind): string { return "smp_recalc_" + kind; }
function wBox(kind: StaffKind): string    { return "smp_box_" + kind; }
function wIcon(kind: StaffKind): string   { return "smp_icon_" + kind; }
function wAuto(kind: StaffKind): string { return "smp_auto_" + kind; }

const CONTENT_X = 44;
const RIGHT_PAD = 10;

const W_M_QUEUES = "smp_m_queues";
const W_M_QPER = "smp_m_qper";
const W_M_PPER = "smp_m_pper";
const W_M_PERAREA = "smp_m_perarea";

const W_INSPECT = "smp_inspect";
const W_AUTO = "smp_auto";
const W_MSTATUS = "smp_mstatus";
const W_GB_M = "smp_gb_m";
const W_BTN_APPLY = "smp_btn_ap";
const W_BTN_ASSIGN_M = "smp_btn_am";
const W_BTN_RECALC_M = "smp_btn_recalc_m";

function perLabelText(kind: StaffKind): string { return "Path tiles per staff: " + getPer(kind); }

function pathStatusText(kind: StaffKind, nice: string): string {
	if (scanProgress >= 0) { return "Scanning map... " + scanProgress + "%"; }
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

function refreshWindow(): void {
	const w = ui.getWindow(WINDOW_TAG);
	if (!w) { return; }
	PATH_KINDS.forEach(function (pk) {
		const per = w.findWidget<SpinnerWidget>(wPer(pk.kind));
		if (per) { per.text = perLabelText(pk.kind); }
		const st = w.findWidget<LabelWidget>(wStatus(pk.kind));
		if (st) { st.text = pathStatusText(pk.kind, pk.nice); }
	});
	const qz = w.findWidget<CheckboxWidget>(W_M_QUEUES);
	if (qz) { qz.isChecked = getMascotQueues(); }
	const qp = w.findWidget<SpinnerWidget>(W_M_QPER);
	if (qp) { qp.text = "Queue tiles/mascot: " + getMascotQueuePer(); }
	const pp = w.findWidget<SpinnerWidget>(W_M_PPER);
	if (pp) { pp.text = "Path tiles/mascot: " + getMascotPathPer(); }
	const pa = w.findWidget<SpinnerWidget>(W_M_PERAREA);
	if (pa) { pa.text = "Mascots per area: " + getMascotPerArea(); }
	const ms = w.findWidget<LabelWidget>(W_MSTATUS);
	if (ms) { ms.text = mechStatusText(); }
	const a = w.findWidget<CheckboxWidget>(W_AUTO);
	if (a) { a.isChecked = getAuto(); }
	PATH_KINDS.forEach(function (pk) {
		const au = w.findWidget<CheckboxWidget>(wAuto(pk.kind));
		if (au) { au.isChecked = getAutoKind(pk.kind); }
	});
}

function stretch(w: Window, name: string, width: number): void {
	const wi = w.findWidget<Widget>(name);
	if (wi) { wi.width = width; }
}

let lastReflowW = -1;
function reflow(w: Window): void {
	if (w.width === lastReflowW) { return; }
	lastReflowW = w.width;
	const full = w.width - 20;
	const cw = w.width - CONTENT_X - RIGHT_PAD;
	PATH_KINDS.forEach(function (pk) {
		stretch(w, wBox(pk.kind), w.width - 10);
		stretch(w, wPer(pk.kind), cw);
		stretch(w, wStatus(pk.kind), cw);
		stretch(w, wBtn(pk.kind), full);
		stretch(w, wRecalc(pk.kind), full);
		stretch(w, wAuto(pk.kind), full);
	});
	stretch(w, W_M_QUEUES, cw);
	stretch(w, W_M_QPER, cw);
	stretch(w, W_M_PPER, cw);
	stretch(w, W_M_PERAREA, cw);
	stretch(w, W_GB_M, w.width - 10);
	[W_BTN_APPLY, W_BTN_ASSIGN_M, W_BTN_RECALC_M, W_AUTO, W_MSTATUS].forEach(function (n) {
		stretch(w, n, full);
	});
	const dd = w.findWidget<DropdownWidget>(W_INSPECT);
	if (dd) { dd.width = Math.max(80, cw - 72); }
}

// Section height: mascots have a checkbox + 3 spinners; others one spinner.
// (+18 to fit the extra "Recalculate needed" button row.)
function sectionHeight(pk: PathKindDef): number { return (pk.kind === "entertainer" ? 168 : 88) + 18; }

function makePathSection(pk: PathKindDef, y: number): WidgetDesc[] {
	const kind = pk.kind;
	const cw = 290 - CONTENT_X - RIGHT_PAD + 5;
	const widgets: WidgetDesc[] = [
		{ type: "groupbox", name: wBox(kind), x: 5, y: y, width: 290,
		  height: sectionHeight(pk) - 6, text: pk.title },
		{
			type: "button", name: wIcon(kind),
			x: 12, y: y + 16, width: 30, height: 30,
			image: STAFF_SPRITE[kind], border: true, isDisabled: true,
			tooltip: pk.title
		}
	];

	let yStatus: number, yBtn: number;
	if (kind === "entertainer") {
		// Mascots: queue toggle + three dedicated density options.
		widgets.push({
			type: "checkbox", name: W_M_QUEUES,
			x: CONTENT_X, y: y + 16, width: cw, height: 12,
			text: "Assign to queue lines (not paths)",
			tooltip: "Place mascots along ride queues to keep queuing guests happy",
			isChecked: getMascotQueues(),
			onChange: function (checked) { setMascotQueues(checked); refreshWindow(); }
		});
		widgets.push({
			type: "spinner", name: W_M_QPER,
			x: CONTENT_X, y: y + 32, width: cw, height: 14,
			text: "Queue tiles/mascot: " + getMascotQueuePer(),
			tooltip: "Maximum queue tiles each mascot covers (queue mode)",
			onIncrement: function () { setMascotQueuePer(getMascotQueuePer() + 1); refreshWindow(); },
			onDecrement: function () { setMascotQueuePer(Math.max(1, getMascotQueuePer() - 1)); refreshWindow(); }
		});
		widgets.push({
			type: "spinner", name: W_M_PPER,
			x: CONTENT_X, y: y + 48, width: cw, height: 14,
			text: "Path tiles/mascot: " + getMascotPathPer(),
			tooltip: "Path tiles each mascot covers (path mode)",
			onIncrement: function () { setMascotPathPer(getMascotPathPer() + 1); refreshWindow(); },
			onDecrement: function () { setMascotPathPer(Math.max(1, getMascotPathPer() - 1)); refreshWindow(); }
		});
		widgets.push({
			type: "spinner", name: W_M_PERAREA,
			x: CONTENT_X, y: y + 64, width: cw, height: 14,
			text: "Mascots per area: " + getMascotPerArea(),
			tooltip: "How many mascots share each area (>1 = overlapping)",
			onIncrement: function () { setMascotPerArea(getMascotPerArea() + 1); refreshWindow(); },
			onDecrement: function () { setMascotPerArea(Math.max(1, getMascotPerArea() - 1)); refreshWindow(); }
		});
		yStatus = y + 82;
		yBtn = y + 96;
	} else {
		// Handymen / security: single density spinner.
		widgets.push({
			type: "spinner", name: wPer(kind),
			x: CONTENT_X, y: y + 16, width: cw, height: 14,
			text: perLabelText(kind),
			tooltip: "Path tiles each " + pk.nice + " member covers",
			onIncrement: (function (k) { return function () {
				setPer(k, getPer(k) + 1); refreshWindow();
			}; })(kind),
			onDecrement: (function (k) { return function () {
				setPer(k, Math.max(1, getPer(k) - 1)); refreshWindow();
			}; })(kind)
		});
		yStatus = y + 34;
		yBtn = y + 48;
	}

	widgets.push({ type: "label", name: wStatus(kind), x: CONTENT_X, y: yStatus,
		width: cw, height: 12, text: pathStatusText(kind, pk.nice) });
	widgets.push({
		type: "button", name: wBtn(kind),
		x: 10, y: yBtn, width: 280, height: 16,
		text: "Calculate & assign " + pk.nice + " areas",
		tooltip: "Scan (non-blocking) and split reachable/owned paths among " + pk.nice,
		onClick: (function (k, nice) { return function () {
			assignPathStaff(k, nice);
		}; })(kind, pk.nice)
	});
	widgets.push({
		type: "button", name: wRecalc(kind),
		x: 10, y: yBtn + 18, width: 280, height: 16,
		text: "Recalculate needed " + pk.nice,
		tooltip: "Rescan and refresh the Needed/Hired counts, without hiring, firing or (re)assigning anyone",
		onClick: (function (k, nice) { return function () {
			recalcPathNeeded(k, nice);
		}; })(kind, pk.nice)
	});
	widgets.push({
		type: "checkbox", name: wAuto(kind),
		x: 10, y: yBtn + 36, width: 280, height: 12,
		text: "Auto: hire/fire + assign on path changes",
		tooltip: "Automatically keep " + pk.nice + " right-sized and assigned when paths, land rights or staff change (newest first)",
		isChecked: getAutoKind(kind),
		onChange: (function (k) { return function (checked: boolean) {
			setAutoKind(k, checked);
			if (checked) { scheduleAutoPath(); }
			refreshWindow();
		}; })(kind)
	});
	return widgets;
}

function openWindow(): void {
	const existing = ui.getWindow(WINDOW_TAG);
	if (existing) { existing.bringToFront(); return; }

	let widgets: WidgetDesc[] = [];
	let y = 18;
	PATH_KINDS.forEach(function (pk) {
		widgets = widgets.concat(makePathSection(pk, y));
		y += sectionHeight(pk) + 6;
	});


	const my = y;
	const mcw = 290 - CONTENT_X - RIGHT_PAD + 5;
	widgets = widgets.concat([
		{ type: "groupbox", name: W_GB_M, x: 5, y: my, width: 290, height: 150, text: "Mechanics" },
		{
			type: "button", name: wIcon("mechanic"),
			x: 12, y: my + 16, width: 30, height: 30,
			image: STAFF_SPRITE.mechanic, border: true, isDisabled: true,
			tooltip: "Mechanics"
		},
		{ type: "label", x: CONTENT_X, y: my + 18, width: 60, height: 12, text: "Inspect:" },
		{
			type: "dropdown", name: W_INSPECT,
			x: CONTENT_X + 62, y: my + 16, width: mcw - 62, height: 14,
			items: INSPECTION_LABELS, selectedIndex: getInspection(),
			tooltip: "Applies to all rides, independent of ride type",
			onChange: function (index) { setInspection(index); applyInspectionAll(); }
		},
		{
			type: "button", name: W_BTN_APPLY,
			x: 10, y: my + 50, width: 280, height: 16,
			text: "Apply inspection interval to all rides",
			onClick: function () { applyInspectionAll(); }
		},
		{
			type: "button", name: W_BTN_ASSIGN_M,
			x: 10, y: my + 70, width: 280, height: 18,
			text: "Assign mechanics to exits now",
			tooltip: "Assign mechanics to ride exits (offers to hire if there aren't enough)",
			onClick: function () { assignMechanicsWithHire(); }
		},
		{
			type: "button", name: W_BTN_RECALC_M,
			x: 10, y: my + 90, width: 280, height: 16,
			text: "Recalculate needed mechanics",
			tooltip: "Refresh the exits-covered/mechanics counts, without hiring, firing or (re)assigning anyone",
			onClick: function () { refreshWindow(); }
		},
		{
			type: "checkbox", name: W_AUTO,
			x: 10, y: my + 110, width: 280, height: 12,
			text: "Auto mechanics (hire/fire + assign)",
			tooltip: "On exit/staff changes, automatically hire missing or fire surplus mechanics (newest, non-busy first) and assign them to exits",
			isChecked: getAuto(),
			onChange: function (checked) {
				setAuto(checked);
				if (checked) { autoRightSizeAndAssign(); }
				refreshWindow();
			}
		},
		{ type: "label", name: W_MSTATUS, x: 10, y: my + 128, width: 280, height: 16, text: mechStatusText() }
	]);

	const winH = my + 150 + 8;
	lastReflowW = -1;
	ui.openWindow({
		classification: WINDOW_TAG,
		width: 300, height: winH,
		minWidth: 280, maxWidth: 620,
		minHeight: winH, maxHeight: winH + 260,
		title: "Staff Manager",
		colours: [24, 24],
		onUpdate: function () {
			const w = ui.getWindow(WINDOW_TAG);
			if (w) { reflow(w); }
		},
		widgets: widgets
	});
	refreshWindow();
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

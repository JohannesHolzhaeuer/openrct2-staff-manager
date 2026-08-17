/// <reference path="openrct2.d.ts" />
/*****************************************************************************
 * Staff Manager Plus
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

var TILE = 32;
var RIDE_SETTING_INSPECTION_INTERVAL = 5;

var TRIGGER_ACTIONS = {
    staffhire: true, stafffire: true,
    rideentranceexitplace: true, rideentranceexitremove: true,
    ridedemolish: true
};

// Actions that change the park's path layout / ownership -> re-run path staff.
var PATH_TRIGGER_ACTIONS = {
    footpathplace: true, footpathremove: true,
    landsetrights: true, landbuyrights: true,
    staffhire: true, stafffire: true
};

var INSPECTION_LABELS = ["10 min", "20 min", "30 min", "45 min",
                         "60 min", "2 hours", "Never"];

var NS = "AutoMechanic";
var HANDYMAN_ORDER_MOWING = 8;
var OWNERSHIP_OWNED = 0x20;

// staffhire staffType numbers and default orders per type.
var STAFF_TYPE_NUM = { handyman: 0, mechanic: 1, security: 2, entertainer: 3 };

// Singular/plural display names per staff type (correct grammar in dialogs).
var STAFF_WORD = {
    handyman:    { one: "handyman",  many: "handymen"  },
    mechanic:    { one: "mechanic",  many: "mechanics" },
    security:    { one: "guard",     many: "guards"    },
    entertainer: { one: "mascot",    many: "mascots"   }
};
// Grammatically correct "<n> handyman/handymen" etc.
function staffWord(kind, n) {
    var w = STAFF_WORD[kind];
    return n + " " + (n === 1 ? w.one : w.many);
}

// Track a peep's assigned spot. Returns "new" (first time we assign it),
// "moved" (assigned somewhere different than before) or "same".
// `counts` (optional) accumulates { fresh, moved } for a summary message.
function recordAssignment(lastArea, peepId, cx, cy, counts) {
    var keyNow = cx + ":" + cy;
    var prev = lastArea[peepId];
    lastArea[peepId] = keyNow;
    var res;
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
function assignSummary(counts) {
    var parts = [];
    parts.push(counts.fresh + " assigned");
    if (counts.moved > 0) { parts.push(counts.moved + " reassigned"); }
    return parts.join(", ");
}
// handyman 7 = sweep(1)+water(2)+bins(4), no mowing(8) -> stays "assignable".
// mechanic 3 = inspect(2)+fix(1).
var STAFF_ORDERS = { handyman: 7, mechanic: 3, security: 0, entertainer: 0 };

// Staff-type icon sprite (2618 = SPR_TERRAIN_STAFF, always valid).
var SPR_STAFF = 2618;
var STAFF_SPRITE = {
    handyman: SPR_STAFF, security: SPR_STAFF,
    entertainer: SPR_STAFF, mechanic: SPR_STAFF
};

var DIR_DELTA = [
    { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }
];

var SCAN_ROWS_PER_TICK = 6;
var ACTIONS_PER_TICK = 20;

// --- Storage ---------------------------------------------------------------
function store() { return context.getParkStorage(NS); }
function getInspection() { return store().get("inspection", 2); }
function setInspection(v) { store().set("inspection", v); }
function getAuto() { return store().get("auto", false); }
function setAuto(v) { store().set("auto", v); }
// Auto hire/fire + assign per path-staff type (handyman/security/entertainer).
function getAutoKind(kind) { return store().get("auto_" + kind, false); }
function setAutoKind(kind, v) { store().set("auto_" + kind, v); }
// True if ANY path-staff type has auto enabled.
function anyAutoPath() {
    return getAutoKind("handyman") || getAutoKind("security") || getAutoKind("entertainer");
}
function getAssignments() { return store().get("assignments", {}); }
function setAssignments(v) { store().set("assignments", v); }
function getPer(kind) { return store().get("per_" + kind, 25); }
function setPer(kind, v) { store().set("per_" + kind, v); }
// Last-assigned area centre per peep id, to detect reassignment ("moved").
function getLastArea() { return store().get("lastArea", {}); }
function setLastArea(v) { store().set("lastArea", v); }
function getMascotOverlap() { return store().get("mascotOverlap", false); }
function setMascotOverlap(v) { store().set("mascotOverlap", v); }
function getMascotAreaSize() { return store().get("mascotAreaSize", 16); }
function setMascotAreaSize(v) { store().set("mascotAreaSize", v); }
function getMascotPerArea() { return store().get("mascotPerArea", 2); }
function setMascotPerArea(v) { store().set("mascotPerArea", v); }

// --- Async helper ----------------------------------------------------------
var busy = false;

function forEachAsync(items, perTick, doItem, onDone) {
    if (!items.length) { if (onDone) { onDone(); } return; }
    var i = 0;
    function step() {
        var end = Math.min(i + perTick, items.length);
        for (; i < end; i++) { doItem(items[i], i); }
        if (i < items.length) { context.setTimeout(step, 1); }
        else if (onDone) { onDone(); }
    }
    step();
}

// --- Staff helpers ---------------------------------------------------------
function isRide(ride) { return ride && ride.classification === "ride"; }

function stationExit(ride, i) {
    if (!ride || !ride.stations || i < 0 || i >= ride.stations.length) { return null; }
    var st = ride.stations[i];
    if (st && st.exit && st.exit.x !== null && st.exit.x >= 0) {
        return { x: st.exit.x, y: st.exit.y };
    }
    return null;
}

function exitKey(rideId, s) { return rideId + ":" + s; }
function keyRideId(k) { return Number(k.split(":")[0]); }
function keyStation(k) { return Number(k.split(":")[1]); }

function allExits() {
    var out = [];
    map.rides.forEach(function (ride) {
        if (!isRide(ride) || !ride.stations) { return; }
        for (var i = 0; i < ride.stations.length; i++) {
            var exit = stationExit(ride, i);
            if (exit) { out.push({ key: exitKey(ride.id, i), exit: exit }); }
        }
    });
    return out;
}

function allStaffOfType(kind) {
    var list = [];
    var scan = function (arr) {
        for (var i = 0; i < arr.length; i++) {
            var s = arr[i];
            if (s && s.type === "staff" && s.staffType === kind) { list.push(s); }
        }
    };
    try { scan(map.getAllEntities("staff")); }
    catch (e) { try { scan(map.getAllEntities("peep")); } catch (e2) {} }
    return list;
}
function allMechanics() { return allStaffOfType("mechanic"); }

function handymanMows(s) {
    return (typeof s.orders === "number") && ((s.orders & HANDYMAN_ORDER_MOWING) !== 0);
}

// Path staff we may manage. Handymen exclude grass-mowers.
function assignableOfKind(kind) {
    var all = allStaffOfType(kind);
    if (kind === "handyman") {
        return all.filter(function (s) { return !handymanMows(s); });
    }
    return all;
}

// Heuristic: a mechanic actively inspecting/fixing stands on a ride tile.
function mechanicIsBusy(mech) {
    if (!mech) { return false; }
    try {
        var tx = Math.floor(mech.x / TILE);
        var ty = Math.floor(mech.y / TILE);
        var tile = map.getTile(tx, ty);
        if (!tile) { return false; }
        for (var i = 0; i < tile.numElements; i++) {
            var el = tile.getElement(i);
            if (!el) { continue; }
            if (el.type === "track") { return true; }
            if (el.type === "entrance" &&
                el.ride !== null && el.ride !== undefined &&
                (el.entranceType === "ride_entrance" ||
                 el.entranceType === "ride_exit")) {
                return true;
            }
        }
    } catch (e) {}
    return false;
}

function mechanicById(id) {
    var e = map.getEntity(id);
    return (e && e.type === "staff" && e.staffType === "mechanic") ? e : null;
}

function patrol4x4(exit) {
    var tiles = [];
    for (var dx = 0; dx < 4; dx++) {
        for (var dy = 0; dy < 4; dy++) {
            tiles.push({ x: exit.x + dx * TILE, y: exit.y + dy * TILE });
        }
    }
    return tiles;
}

function setPatrol(mechanic, exit) {
    if (!mechanic || !mechanic.patrolArea) { return; }
    mechanic.patrolArea.clear();
    mechanic.patrolArea.add(patrol4x4(exit));
}

// --- Hiring ----------------------------------------------------------------
// Hire `count` staff of a kind (chunked). Calls onDone() after all attempts.
function hireStaff(kind, count, onDone) {
    if (count <= 0) { if (onDone) { onDone(); } return; }
    var items = [];
    for (var i = 0; i < count; i++) { items.push(i); }
    var remaining = count, hired = 0;
    forEachAsync(items, 5, function () {
        context.executeAction("staffhire", {
            autoPosition: true,
            staffType: STAFF_TYPE_NUM[kind],
            entityType: 0,
            staffOrders: STAFF_ORDERS[kind]
        }, function (res) {
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
function fireStaff(kind, count, onDone) {
    if (count <= 0) { if (onDone) { onDone(0); } return; }
    var pool = assignableOfKind(kind).slice();
    // Never fire a mechanic that is currently inspecting/fixing a ride.
    if (kind === "mechanic") {
        pool = pool.filter(function (m) { return !mechanicIsBusy(m); });
    }
    pool.sort(function (a, b) { return b.id - a.id; });   // newest first
    var victims = pool.slice(0, count);
    if (victims.length === 0) { if (onDone) { onDone(0); } return; }

    // Forget fired peeps' remembered spots so ids can't go stale.
    var lastArea = getLastArea();
    victims.forEach(function (v) { delete lastArea[v.id]; });
    setLastArea(lastArea);

    var remaining = victims.length, fired = 0;
    forEachAsync(victims, 5, function (staff) {
        context.executeAction("stafffire", { id: staff.id }, function (res) {
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
var CONFIRM_TAG = "smp_confirm";
var confirmYesCb = null, confirmNoCb = null;

function closeConfirm() {
    var w = ui.getWindow(CONFIRM_TAG);
    if (w) { w.close(); }
}

function confirmDialog(lines, yesLabel, onYes, onNo) {
    closeConfirm();
    confirmYesCb = onYes;
    confirmNoCb = onNo;
    var widgets = [];
    for (var i = 0; i < lines.length; i++) {
        widgets.push({ type: "label", x: 12, y: 22 + i * 13, width: 296, height: 12, text: lines[i] });
    }
    var by = 26 + lines.length * 13;
    widgets.push({
        type: "button", x: 24, y: by, width: 130, height: 18, text: yesLabel || "Yes",
        onClick: function () { var f = confirmYesCb; closeConfirm(); if (f) { f(); } }
    });
    widgets.push({
        type: "button", x: 166, y: by, width: 130, height: 18, text: "Cancel",
        onClick: function () { var f = confirmNoCb; closeConfirm(); if (f) { f(); } }
    });
    ui.openWindow({
        classification: CONFIRM_TAG,
        width: 320, height: by + 28,
        title: "Staff Manager Plus",
        colours: [24, 24],
        widgets: widgets
    });
}

// --- Inspection interval (chunked) -----------------------------------------
function applyInspectionAll() {
    var value = getInspection();
    var rides = map.rides.filter(isRide);
    forEachAsync(rides, ACTIONS_PER_TICK, function (ride) {
        context.executeAction("ridesetsetting", {
            ride: ride.id,
            setting: RIDE_SETTING_INSPECTION_INTERVAL,
            value: value
        }, function () {});
    }, function () {
        park.postMessage({
            type: "blank",
            text: "Inspection set to '" + INSPECTION_LABELS[value] +
                  "' for " + rides.length + " ride(s)."
        });
    });
}

// --- Mechanics: assign to exits --------------------------------------------
function cleanAssignments() {
    var assignments = getAssignments();
    var cleaned = {};
    var usedMech = {};
    var validExitKeys = {};
    allExits().forEach(function (e) { validExitKeys[e.key] = true; });
    for (var key in assignments) {
        var mid = assignments[key];
        if (validExitKeys[key] && mechanicById(mid) && !usedMech[mid]) {
            cleaned[key] = mid;
            usedMech[mid] = true;
        }
    }
    setAssignments(cleaned);
    return { assignments: cleaned, usedMech: usedMech };
}

function assignMechanics() {
    var state = cleanAssignments();
    var assignments = state.assignments;
    var usedMech = state.usedMech;

    for (var key in assignments) {
        var ride = map.getRide(keyRideId(key));
        var exit = stationExit(ride, keyStation(key));
        if (!exit) { continue; }
        var m = mechanicById(assignments[key]);
        if (!m || mechanicIsBusy(m)) { continue; }
        setPatrol(m, exit);
    }

    var free = allMechanics().filter(function (m) {
        return !usedMech[m.id] && !mechanicIsBusy(m);
    });
    var assigned = 0, newRideIds = {};
    var lastArea = getLastArea();
    var counts = { fresh: 0, moved: 0 };
    var exits = allExits();
    for (var i = 0; i < exits.length; i++) {
        var e = exits[i];
        if (assignments[e.key]) { continue; }
        if (free.length === 0) { break; }
        var mech = free.shift();
        assignments[e.key] = mech.id;
        setPatrol(mech, e.exit);
        recordAssignment(lastArea, mech.id, e.exit.x, e.exit.y, counts);
        newRideIds[keyRideId(e.key)] = true;
        assigned++;
    }
    setAssignments(assignments);
    setLastArea(lastArea);

    var inspected = 0, value = getInspection();
    for (var rid in newRideIds) {
        context.executeAction("ridesetsetting", {
            ride: Number(rid),
            setting: RIDE_SETTING_INSPECTION_INTERVAL,
            value: value
        }, function () {});
        inspected++;
    }

    var covered = 0;
    for (var k in assignments) { covered++; }
    return { assigned: assigned, reassigned: counts.moved, inspected: inspected,
             covered: covered, totalExits: exits.length };
}

function assignMechanicsReport() {
    var r = assignMechanics();
    var reassignTxt = r.reassigned > 0 ? (" (" + r.reassigned + " reassigned)") : "";
    park.postMessage({
        type: "blank",
        text: "Mechanics: " + r.assigned + " assigned" + reassignTxt +
              ", inspection on " + r.inspected + " ride(s). Covered " +
              r.covered + "/" + r.totalExits + " exits."
    });
    refreshWindow();
}

// Button entry: offer to hire mechanics if there aren't enough for all exits.
function assignMechanicsWithHire() {
    var exits = allExits().length;
    var have = allMechanics().length;
    if (exits > have) {
        var deficit = exits - have;
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
        var fireable = allMechanics().filter(function (m) { return !mechanicIsBusy(m); }).length;
        var surplus = Math.min(have - exits, fireable);
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
var autoBusy = false;   // re-entrancy guard: our own hire/fire retrigger this

function autoRightSizeAndAssign() {
    if (autoBusy) { return; }
    var exits = allExits().length;
    var have = allMechanics().length;

    if (exits > have) {
        autoBusy = true;
        hireStaff("mechanic", exits - have, function () {
            autoBusy = false;
            assignMechanics();
            refreshWindow();
        });
    } else if (exits < have) {
        var fireable = allMechanics().filter(function (m) { return !mechanicIsBusy(m); }).length;
        var surplus = Math.min(have - exits, fireable);
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
var autoPathBusy = false;      // re-entrancy guard for our own hire/fire
var autoPathToken = 0;         // debounce token
var AUTO_PATH_DEBOUNCE_MS = 1500;

function scheduleAutoPath() {
    autoPathToken++;
    var myToken = autoPathToken;
    context.setTimeout(function () {
        if (myToken !== autoPathToken) { return; }   // superseded by a newer trigger
        autoPathRun();
    }, AUTO_PATH_DEBOUNCE_MS);
}

function autoPathRun() {
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
function rightSizePathKindsSequential(i, tiles, done) {
    if (i >= PATH_KINDS.length) { done(); return; }
    var pk = PATH_KINDS[i];
    var next = function () { rightSizePathKindsSequential(i + 1, tiles, done); };

    if (!getAutoKind(pk.kind)) { next(); return; }   // this type's auto is off

    var have = assignableOfKind(pk.kind).length;
    var need = neededForKind(pk.kind, tiles.length);

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

var autoSub = null;
function startAuto() {
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
function scanMapAsync(onProgress, onComplete) {
    var size = map.size;
    var pathInfo = {};
    var seeds = [];
    var tx = 1;
    var maxX = size.x - 1;

    function step() {
        var endTx = Math.min(tx + SCAN_ROWS_PER_TICK, maxX);
        for (; tx < endTx; tx++) {
            for (var ty = 1; ty < size.y - 1; ty++) {
                var tile = map.getTile(tx, ty);
                var fp = null, owned = false;
                for (var i = 0; i < tile.numElements; i++) {
                    var el = tile.getElement(i);
                    if (!el) { continue; }
                    if (el.type === "footpath" && !el.isGhost && fp === null) {
                        fp = el;
                    } else if (el.type === "surface") {
                        owned = (typeof el.ownership === "number") &&
                                ((el.ownership & OWNERSHIP_OWNED) !== 0);
                    } else if (el.type === "entrance" &&
                               (el.ride === null || el.ride === undefined)) {
                        seeds.push({ tx: tx, ty: ty });
                        for (var d = 0; d < 4; d++) {
                            seeds.push({ tx: tx + DIR_DELTA[d].dx,
                                         ty: ty + DIR_DELTA[d].dy });
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

function reachableOwnedTiles(pathInfo, seeds) {
    var visited = {};
    var q = [];
    var result = [];
    function enq(tx, ty) {
        var k = tx + ":" + ty;
        if (visited[k] || !pathInfo[k]) { return; }
        visited[k] = true;
        q.push(k);
    }
    seeds.forEach(function (s) { enq(s.tx, s.ty); });
    if (q.length === 0) {
        for (var kk in pathInfo) {
            if (pathInfo[kk].owned && !visited[kk]) { visited[kk] = true; q.push(kk); }
        }
    }
    var head = 0;
    while (head < q.length) {
        var k = q[head++];
        var info = pathInfo[k];
        var parts = k.split(":");
        var tx = +parts[0], ty = +parts[1];
        if (!info.isQueue && info.owned) {
            result.push({ x: tx * TILE, y: ty * TILE, z: info.z });
        }
        for (var d = 0; d < 4; d++) {
            if ((info.edges & (1 << d)) === 0) { continue; }
            enq(tx + DIR_DELTA[d].dx, ty + DIR_DELTA[d].dy);
        }
    }
    return result;
}

function partition(arr, n) {
    var chunks = [];
    if (n <= 0) { return chunks; }
    var per = Math.ceil(arr.length / n);
    for (var i = 0; i < n; i++) {
        var slice = arr.slice(i * per, (i + 1) * per);
        if (slice.length > 0) { chunks.push(slice); }
    }
    return chunks;
}

// Cached scan result (shared by all path staff).
var cachedTiles = null;
var pathsScanned = false;
var scanProgress = -1;

function ensureScan(force, onDone) {
    if (!force && cachedTiles) { onDone(cachedTiles); return; }
    if (busy) { return; }
    busy = true;
    scanProgress = 0;
    refreshWindow();
    scanMapAsync(function (pct) {
        scanProgress = pct; refreshWindow();
    }, function (pathInfo, seeds) {
        cachedTiles = reachableOwnedTiles(pathInfo, seeds);
        cachedTiles.sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
        pathsScanned = true;
        scanProgress = -1;
        busy = false;
        refreshWindow();
        onDone(cachedTiles);
    });
}

// How many staff of a kind a full assignment needs for the given path count.
function neededForKind(kind, pathCount) {
    if (kind === "entertainer" && getMascotOverlap()) {
        var areaSize = Math.max(1, getMascotAreaSize());
        var perArea = Math.max(1, getMascotPerArea());
        return Math.ceil(pathCount / areaSize) * perArea;
    }
    return Math.ceil(pathCount / Math.max(1, getPer(kind)));
}

// Overlap-mode mascot placement.
function assignMascotsOverlap(tiles) {
    var mascots = assignableOfKind("entertainer");
    if (mascots.length === 0) {
        park.postMessage({ type: "blank", text: "No mascots available." });
        refreshWindow();
        return;
    }
    var areaSize = Math.max(1, getMascotAreaSize());
    var perArea = Math.max(1, getMascotPerArea());
    var numAreas = Math.ceil(tiles.length / areaSize);
    var areas = partition(tiles, numAreas);

    var idx = 0, assigned = 0, areasUsed = 0;
    var lastArea = getLastArea();
    var counts = { fresh: 0, moved: 0 };
    for (var a = 0; a < areas.length && idx < mascots.length; a++) {
        var area = areas[a];
        var t = area[Math.floor(area.length / 2)];
        var placedHere = 0;
        for (var j = 0; j < perArea && idx < mascots.length; j++) {
            var p = mascots[idx++];
            if (!p.patrolArea) { continue; }
            p.patrolArea.clear();
            p.patrolArea.add(area);
            try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) {}
            recordAssignment(lastArea, p.id, t.x, t.y, counts);
            assigned++; placedHere++;
        }
        if (placedHere > 0) { areasUsed++; }
    }
    setLastArea(lastArea);
    park.postMessage({ type: "blank",
        text: "Mascots: " + assignSummary(counts) + " across " + areasUsed +
              " overlapping area(s) of ~" + areaSize + " tiles (" +
              perArea + " per area)." });
    refreshWindow();
}

// Equal contiguous split among a path-staff type; drop each into its area.
function doPathAssign(kind, niceName, tiles) {
    if (kind === "entertainer" && getMascotOverlap()) {
        assignMascotsOverlap(tiles);
        return;
    }
    var staff = assignableOfKind(kind);
    if (staff.length === 0) {
        park.postMessage({ type: "blank",
            text: "No assignable " + niceName + " available." });
        refreshWindow();
        return;
    }
    var chunks = partition(tiles, staff.length);
    var assigned = 0;
    var lastArea = getLastArea();
    var counts = { fresh: 0, moved: 0 };
    for (var i = 0; i < staff.length; i++) {
        var p = staff[i];
        if (!p.patrolArea) { continue; }
        var chunk = chunks[i];
        p.patrolArea.clear();
        if (chunk && chunk.length > 0) {
            p.patrolArea.add(chunk);
            var t = chunk[Math.floor(chunk.length / 2)];
            try { p.x = t.x + 16; p.y = t.y + 16; p.z = t.z; } catch (e) {}
            recordAssignment(lastArea, p.id, t.x, t.y, counts);
            assigned++;
        }
    }
    setLastArea(lastArea);
    park.postMessage({ type: "blank",
        text: niceName + ": " + assignSummary(counts) + " over " +
              tiles.length + " path tiles." });
    refreshWindow();
}

// Button entry for path staff: scan, then offer to hire if short, then assign.
function assignPathStaff(kind, niceName) {
    if (busy) {
        park.postMessage({ type: "blank", text: "Staff Manager Plus is busy scanning..." });
        return;
    }
    ensureScan(true, function (tiles) {
        if (tiles.length === 0) {
            park.postMessage({ type: "blank", text: "No reachable owned path tiles found." });
            refreshWindow();
            return;
        }
        var have = assignableOfKind(kind).length;
        var need = neededForKind(kind, tiles.length);
        if (need > have) {
            var deficit = need - have;
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
            var surplus = have - need;
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

// --- GUI -------------------------------------------------------------------
var WINDOW_TAG = "smp_window";

var PATH_KINDS = [
    { kind: "handyman",    nice: "handymen",  title: "Handymen" },
    { kind: "security",    nice: "security",  title: "Security" },
    { kind: "entertainer", nice: "mascots",   title: "Mascots (entertainers)" }
];

function wPer(kind)    { return "smp_per_" + kind; }
function wStatus(kind) { return "smp_st_" + kind; }
function wBtn(kind)    { return "smp_btn_" + kind; }
function wBox(kind)    { return "smp_box_" + kind; }
function wIcon(kind)   { return "smp_icon_" + kind; }

var CONTENT_X = 44;
var RIGHT_PAD = 10;

var W_M_OVERLAP = "smp_m_overlap";
var W_M_AREASIZE = "smp_m_areasize";
var W_M_PERAREA = "smp_m_perarea";

var W_INSPECT = "smp_inspect";
var W_AUTO = "smp_auto";
var W_MSTATUS = "smp_mstatus";
var W_GB_M = "smp_gb_m";
var W_BTN_APPLY = "smp_btn_ap";
var W_BTN_ASSIGN_M = "smp_btn_am";

function perLabelText(kind) { return "Path tiles per staff: " + getPer(kind); }

function pathStatusText(kind, nice) {
    if (scanProgress >= 0) { return "Scanning map... " + scanProgress + "%"; }
    var paths = pathsScanned && cachedTiles ? cachedTiles.length : null;
    var pathsTxt = paths === null ? "?" : String(paths);
    var hired = allStaffOfType(kind).length;
    var assignable = assignableOfKind(kind).length;
    if (kind === "entertainer" && getMascotOverlap()) {
        var areaSize = Math.max(1, getMascotAreaSize());
        var perArea = Math.max(1, getMascotPerArea());
        var areas = paths === null ? "?" : String(Math.ceil(paths / areaSize));
        var needOv = paths === null ? "?" : String(Math.ceil(paths / areaSize) * perArea);
        return "Paths: " + pathsTxt + " | Areas: " + areas +
               " | Needed: " + needOv + " | Hired: " + hired;
    }
    var per = Math.max(1, getPer(kind));
    var needed = paths === null ? "?" : String(Math.ceil(paths / per));
    return "Paths: " + pathsTxt + " | Needed: " + needed +
           " | Hired: " + hired + " | Assignable: " + assignable;
}

function mechStatusText() {
    var assignments = getAssignments();
    var covered = 0;
    for (var k in assignments) { covered++; }
    return "Mechanics: " + allMechanics().length +
           "  |  Exits covered: " + covered +
           "  |  Auto: " + (getAuto() ? "ON" : "OFF");
}

function refreshWindow() {
    var w = ui.getWindow(WINDOW_TAG);
    if (!w) { return; }
    PATH_KINDS.forEach(function (pk) {
        var per = w.findWidget(wPer(pk.kind));
        if (per) { per.text = perLabelText(pk.kind); }
        var st = w.findWidget(wStatus(pk.kind));
        if (st) { st.text = pathStatusText(pk.kind, pk.nice); }
    });
    var ov = w.findWidget(W_M_OVERLAP);
    if (ov) { ov.isChecked = getMascotOverlap(); }
    var asz = w.findWidget(W_M_AREASIZE);
    if (asz) { asz.text = "Area: " + getMascotAreaSize(); }
    var pa = w.findWidget(W_M_PERAREA);
    if (pa) { pa.text = "Per: " + getMascotPerArea(); }
    var ms = w.findWidget(W_MSTATUS);
    if (ms) { ms.text = mechStatusText(); }
    var a = w.findWidget(W_AUTO);
    if (a) { a.isChecked = getAuto(); }
    PATH_KINDS.forEach(function (pk) {
        var au = w.findWidget(wAuto(pk.kind));
        if (au) { au.isChecked = getAutoKind(pk.kind); }
    });
}

function stretch(w, name, width) {
    var wi = w.findWidget(name);
    if (wi) { wi.width = width; }
}

var lastReflowW = -1;
function reflow(w) {
    if (w.width === lastReflowW) { return; }
    lastReflowW = w.width;
    var full = w.width - 20;
    var cw = w.width - CONTENT_X - RIGHT_PAD;
    PATH_KINDS.forEach(function (pk) {
        stretch(w, wBox(pk.kind), w.width - 10);
        stretch(w, wPer(pk.kind), cw);
        stretch(w, wStatus(pk.kind), cw);
        stretch(w, wBtn(pk.kind), full);
        stretch(w, wAuto(pk.kind), full);
    });
    stretch(w, W_M_OVERLAP, cw);
    var half = Math.floor((cw - 4) / 2);
    var aszW = w.findWidget(W_M_AREASIZE);
    if (aszW) { aszW.width = half; }
    var paW = w.findWidget(W_M_PERAREA);
    if (paW) { paW.width = half; paW.x = CONTENT_X + half + 4; }
    stretch(w, W_GB_M, w.width - 10);
    [W_BTN_APPLY, W_BTN_ASSIGN_M, W_AUTO, W_MSTATUS].forEach(function (n) {
        stretch(w, n, full);
    });
    var dd = w.findWidget(W_INSPECT);
    if (dd) { dd.width = Math.max(80, cw - 72); }
}

function wAuto(kind) { return "smp_auto_" + kind; }

// +16px per section for the per-type auto checkbox.
function sectionHeight(pk) { return pk.kind === "entertainer" ? 136 : 88; }

function makePathSection(pk, y) {
    var kind = pk.kind;
    var cw = 290 - CONTENT_X - RIGHT_PAD + 5;
    var widgets = [
        { type: "groupbox", name: wBox(kind), x: 5, y: y, width: 290,
          height: sectionHeight(pk) - 6, text: pk.title },
        {
            type: "button", name: wIcon(kind),
            x: 12, y: y + 16, width: 30, height: 30,
            image: STAFF_SPRITE[kind], border: true, isDisabled: true,
            tooltip: pk.title
        },
        {
            type: "spinner", name: wPer(kind),
            x: CONTENT_X, y: y + 16, width: cw, height: 14,
            text: perLabelText(kind),
            tooltip: "Path tiles each " + pk.nice + " member covers (non-overlap mode)",
            onIncrement: (function (k) { return function () {
                setPer(k, getPer(k) + 1); refreshWindow();
            }; })(kind),
            onDecrement: (function (k) { return function () {
                setPer(k, Math.max(1, getPer(k) - 1)); refreshWindow();
            }; })(kind)
        }
    ];

    var yStatus, yBtn;
    if (kind === "entertainer") {
        widgets.push({
            type: "checkbox", name: W_M_OVERLAP,
            x: CONTENT_X, y: y + 34, width: cw, height: 12,
            text: "Overlapping areas (multiple per area)",
            tooltip: "Group paths into fixed-size areas and place several mascots in each",
            isChecked: getMascotOverlap(),
            onChange: function (checked) { setMascotOverlap(checked); refreshWindow(); }
        });
        var halfw = Math.floor((cw - 4) / 2);
        widgets.push({
            type: "spinner", name: W_M_AREASIZE,
            x: CONTENT_X, y: y + 50, width: halfw, height: 14,
            text: "Area: " + getMascotAreaSize(),
            tooltip: "Path tiles per mascot area (overlap mode)",
            onIncrement: function () { setMascotAreaSize(getMascotAreaSize() + 1); refreshWindow(); },
            onDecrement: function () { setMascotAreaSize(Math.max(1, getMascotAreaSize() - 1)); refreshWindow(); }
        });
        widgets.push({
            type: "spinner", name: W_M_PERAREA,
            x: CONTENT_X + halfw + 4, y: y + 50, width: halfw, height: 14,
            text: "Per: " + getMascotPerArea(),
            tooltip: "Mascots per area (overlap mode)",
            onIncrement: function () { setMascotPerArea(getMascotPerArea() + 1); refreshWindow(); },
            onDecrement: function () { setMascotPerArea(Math.max(1, getMascotPerArea() - 1)); refreshWindow(); }
        });
        yStatus = y + 68;
        yBtn = y + 82;
    } else {
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
        type: "checkbox", name: wAuto(kind),
        x: 10, y: yBtn + 18, width: 280, height: 12,
        text: "Auto: hire/fire + assign on path changes",
        tooltip: "Automatically keep " + pk.nice + " right-sized and assigned when paths, land rights or staff change (newest first)",
        isChecked: getAutoKind(kind),
        onChange: (function (k) { return function (checked) {
            setAutoKind(k, checked);
            if (checked) { scheduleAutoPath(); }
            refreshWindow();
        }; })(kind)
    });
    return widgets;
}

function openWindow() {
    var existing = ui.getWindow(WINDOW_TAG);
    if (existing) { existing.bringToFront(); return; }

    var widgets = [];
    var y = 18;
    PATH_KINDS.forEach(function (pk) {
        widgets = widgets.concat(makePathSection(pk, y));
        y += sectionHeight(pk) + 6;
    });


    var my = y;
    var mcw = 290 - CONTENT_X - RIGHT_PAD + 5;
    widgets = widgets.concat([
        { type: "groupbox", name: W_GB_M, x: 5, y: my, width: 290, height: 132, text: "Mechanics" },
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
            type: "checkbox", name: W_AUTO,
            x: 10, y: my + 92, width: 280, height: 12,
            text: "Auto mechanics (hire/fire + assign)",
            tooltip: "On exit/staff changes, automatically hire missing or fire surplus mechanics (newest, non-busy first) and assign them to exits",
            isChecked: getAuto(),
            onChange: function (checked) {
                setAuto(checked);
                if (checked) { autoRightSizeAndAssign(); }
                refreshWindow();
            }
        },
        { type: "label", name: W_MSTATUS, x: 10, y: my + 110, width: 280, height: 16, text: mechStatusText() }
    ]);

    var winH = my + 132 + 8;
    lastReflowW = -1;
    ui.openWindow({
        classification: WINDOW_TAG,
        width: 300, height: winH,
        minWidth: 280, maxWidth: 620,
        minHeight: winH, maxHeight: winH + 260,
        title: "Staff Manager Plus",
        colours: [24, 24],
        onUpdate: function () {
            var w = ui.getWindow(WINDOW_TAG);
            if (w) { reflow(w); }
        },
        widgets: widgets
    });
    refreshWindow();
}

// --- Main ------------------------------------------------------------------
function main() {
    if (typeof ui !== "undefined") {
        ui.registerMenuItem("Staff Manager Plus", function () { openWindow(); });
    }
    startAuto();
}

registerPlugin({
    name: "Staff Manager Plus",
    version: "2.15.0",
    authors: ["Johannes"],
    type: "local",
    licence: "MIT",
    minApiVersion: 34,
    targetApiVersion: 77,
    main: main
});

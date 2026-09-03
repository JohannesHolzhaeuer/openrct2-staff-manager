/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import {
	handymenCleanupNeededStore, handymenGardeningNeededStore, handymenMowerTilesPerStaffStore,
	guardsNeededStore, entertainersNeededStore, mechanicsNeededStore,
	handymenEnabledStore, guardsEnabledStore, entertainersEnabledStore, mechanicsEnabledStore,
	entertainersIncludeQueueStore, entertainersPerAreaStore,
	handymenHiredStore, handymenAssignedStore, guardsHiredStore, guardsAssignedStore,
	entertainersHiredStore, entertainersAssignedStore, mechanicsHiredStore, mechanicsAssignedStore,
	computeNeeded, statusTextStore, progressStore
} from "./store";
import {
	lastAllPathTiles, lastGardenAreas, isValidStationExit, tileKey,
	CARDINAL_NEIGHBOUR_OFFSETS, DIRECTION_OFFSETS, PathTileInfo
} from "./scan";
import { t } from "./i18n";

// --- Handyman orders bitmasks ------------------------------------------------
// Handyman "orders" bitmask values (see StaffHireArgs/StaffSetOrdersArgs):
// Sweeping = 1, Watering flowers = 2, Empty bins = 4, Mowing = 8.
const HANDYMAN_ORDER_SWEEPING = 1;
const HANDYMAN_ORDER_WATERING = 2;
const HANDYMAN_ORDER_EMPTY_BINS = 4;
const HANDYMAN_ORDER_MOWING = 8;
// Cleanup handymen empty bins and sweep litter.
export const HANDYMAN_ORDERS_CLEANUP = HANDYMAN_ORDER_SWEEPING | HANDYMAN_ORDER_EMPTY_BINS;
// Gardening handymen water flowers and mow lawns.
export const HANDYMAN_ORDERS_GARDENING = HANDYMAN_ORDER_WATERING | HANDYMAN_ORDER_MOWING;

// Mechanic "orders" bitmask values: Inspect rides = 1, Fix rides = 2.
export const MECHANIC_ORDERS_DEFAULT = 1 | 2;

// Staff type ids used by the "staffhire" game action.
export const STAFF_TYPE_ID_HANDYMAN = 0;
export const STAFF_TYPE_ID_MECHANIC = 1;
export const STAFF_TYPE_ID_SECURITY = 2;
export const STAFF_TYPE_ID_ENTERTAINER = 3;

export type HandymanPurpose = "cleanup" | "gardening";

// A handyman is considered a "gardening" handyman if any of their orders are
// watering/mowing, and a "cleanup" handyman otherwise (this also covers
// freshly hired handymen with no orders set yet).
export function classifyHandyman(member: Handyman): HandymanPurpose {
	return (member.orders & HANDYMAN_ORDERS_GARDENING) !== 0 ? "gardening" : "cleanup";
}

export function getHandymenByPurpose(purpose: HandymanPurpose): Handyman[] {
	const staff = map.getAllEntities("staff");
	const result: Handyman[] = [];
	for (const member of staff) {
		if (member.staffType === "handyman" && classifyHandyman(member) === purpose) {
			result.push(member);
		}
	}
	return result;
}

export function getStaffByType(staffType: StaffType): Staff[] {
	const staff = map.getAllEntities("staff");
	const result: Staff[] = [];
	for (const member of staff) {
		if (member.staffType === staffType) {
			result.push(member);
		}
	}
	return result;
}

// A single queued hire/fire game action. Collected up-front by
// adjustStaffCounts and then dispatched a few per tick (see applyInBatches),
// because `context.executeAction` runs the action synchronously in
// single-player: issuing every hire/fire in one loop blocks the game loop for
// the entire batch (`staffhire` with autoPosition additionally searches the
// map for a spawn tile), which froze the game for seconds and prevented the
// status row from ever repainting.
type StaffAdjustTask =
	| { kind: "hire"; staffTypeId: number; orders: number }
	| { kind: "fire"; id: number };

// Collects the fire tasks for the given number of staff members, oldest first
// (lowest entity id first, since entity ids are assigned in creation order and
// are not reused while the entity is alive).
function collectFireOldestStaffTasks(members: Staff[], countToFire: number): StaffAdjustTask[] {
	const tasks: StaffAdjustTask[] = [];
	const sorted = members.slice().sort(function (a, b) { return (a.id ?? 0) - (b.id ?? 0); });
	for (let i = 0; i < countToFire && i < sorted.length; i++) {
		const id = sorted[i].id;
		if (id !== null) {
			tasks.push({ kind: "fire", id: id });
		}
	}
	return tasks;
}

// Identifiers (or parts thereof) of peep_animations objects that represent
// entertainer costumes, as opposed to handyman/mechanic/security costumes.
// Mirrors the non-staff entries of the StaffCostume type.
const ENTERTAINER_COSTUME_IDENTIFIER_PARTS = [
	"panda", "tiger", "elephant", "roman", "gorilla", "snowman", "knight", "astronaut", "bandit", "sheriff", "pirate"
];

// Finds all loaded peep_animations object indices that are valid entertainer
// costumes (mirrors the non-staff entries of the StaffCostume type).
function findEntertainerCostumeIndices(): number[] {
	const peepAnimationObjects = objectManager.getAllObjects("peep_animations");
	const result: number[] = [];
	for (const peepAnimationObject of peepAnimationObjects) {
		const identifier = peepAnimationObject.identifier.toLowerCase();
		for (const costumePart of ENTERTAINER_COSTUME_IDENTIFIER_PARTS) {
			if (identifier.includes(costumePart)) {
				result.push(peepAnimationObject.index);
				break;
			}
		}
	}
	return result;
}

// Finds a loaded peep_animations object index that is a valid costume for the
// given staff type. Handymen/mechanics/security use costume index 0 (their
// default costume); entertainers must use one of the loaded entertainer
// costume objects (picked at random), since costume 0 is the handyman
// costume and is rejected by the game for entertainers. Returns -1 if no
// valid costume exists (only possible for entertainers when no entertainer
// costume objects are loaded), so the caller can skip the hire instead of
// issuing one with costume 0 that the game would silently reject.
function findCostumeIndexForStaffType(staffTypeId: number): number {
	if (staffTypeId !== STAFF_TYPE_ID_ENTERTAINER) {
		return 0;
	}

	const entertainerCostumeIndices = findEntertainerCostumeIndices();
	if (entertainerCostumeIndices.length === 0) {
		return -1;
	}

	return entertainerCostumeIndices[Math.floor(Math.random() * entertainerCostumeIndices.length)];
}

// Collects hire tasks for the given number of new staff of the given type,
// applying the given orders bitmask (only relevant for handymen/mechanics).
// The costume is picked when the task is actually dispatched, so each hired
// staff member still gets its own randomly picked costume (entertainers).
function collectHireStaffTasks(staffTypeId: number, orders: number, countToHire: number): StaffAdjustTask[] {
	const tasks: StaffAdjustTask[] = [];
	for (let i = 0; i < countToHire; i++) {
		tasks.push({ kind: "hire", staffTypeId: staffTypeId, orders: orders });
	}
	return tasks;
}

// Executes a single queued hire/fire action. Invokes onActionComplete once the
// action's callback has fired (regardless of success/failure).
function runStaffAdjustTask(task: StaffAdjustTask, onActionComplete: () => void): void {
	if (task.kind === "fire") {
		context.executeAction("stafffire", { id: task.id }, function () { onActionComplete(); });
		return;
	}

	const costumeIndex = findCostumeIndexForStaffType(task.staffTypeId);
	if (costumeIndex < 0) {
		// No valid costume for this staff type (e.g. entertainer with no
		// entertainer costume objects loaded). Skip the hire, but still
		// invoke the completion callback so the pending-action counter in
		// adjustStaffCounts stays balanced and the UI still refreshes.
		onActionComplete();
		return;
	}

	context.executeAction("staffhire", {
		autoPosition: true,
		staffType: task.staffTypeId,
		costumeIndex: costumeIndex,
		staffOrders: task.orders
	}, function () { onActionComplete(); });
}

// Hires the given number of new staff of the given type, applying the given
// orders bitmask (only relevant for handymen/mechanics). Each hired staff
// member gets its own randomly picked costume (relevant for entertainers).
// The actions are dispatched a few per tick so hiring many staff at once
// doesn't block the game loop. Invokes onActionComplete once per action after
// its callback has fired.
export function hireStaff(staffTypeId: number, orders: number, countToHire: number, onActionComplete: () => void): void {
	const tasks = collectHireStaffTasks(staffTypeId, orders, countToHire);
	applyInBatches(tasks, function (task) {
		runStaffAdjustTask(task, onActionComplete);
	}, function () { /* per-action callbacks already reported completion */ });
}

// Collects the hire/fire tasks needed to bring handymen of a specific purpose
// (cleanup/gardening) to the needed count, firing the oldest first when there
// is a surplus.
function collectHandymanTasks(purpose: HandymanPurpose, needed: number): StaffAdjustTask[] {
	const current = getHandymenByPurpose(purpose);
	const difference = needed - current.length;
	if (difference > 0) {
		const orders = purpose === "cleanup" ? HANDYMAN_ORDERS_CLEANUP : HANDYMAN_ORDERS_GARDENING;
		return collectHireStaffTasks(STAFF_TYPE_ID_HANDYMAN, orders, difference);
	}
	if (difference < 0) {
		return collectFireOldestStaffTasks(current, -difference);
	}
	return [];
}

// Collects the hire/fire tasks needed to bring staff of a given type to the
// needed count, firing the oldest first when there is a surplus.
function collectStaffOfTypeTasks(staffType: StaffType, staffTypeId: number, orders: number, needed: number): StaffAdjustTask[] {
	const current = getStaffByType(staffType);
	const difference = needed - current.length;
	if (difference > 0) {
		return collectHireStaffTasks(staffTypeId, orders, difference);
	}
	if (difference < 0) {
		return collectFireOldestStaffTasks(current, -difference);
	}
	return [];
}

// Adjusts the number of hired staff of every type to match the currently
// calculated Needed counts: hires more if understaffed, fires the oldest
// staff first if overstaffed. The hire/fire game actions are dispatched a few
// per game tick (applyInBatches) instead of all at once, so the game keeps
// rendering/simulating and the status row stays responsive while a large
// number of staff is being adjusted. The Hired/Assigned/Difference stats are
// refreshed once all the queued hire/fire game actions have completed.
export function adjustStaffCounts(onComplete?: () => void): void {
	// Snapshot the needed counts and collect every hire/fire action to run
	// before issuing any of them, so the task list isn't affected by staff
	// created/removed while it is being worked through.
	const tasks: StaffAdjustTask[] = ([] as StaffAdjustTask[]).concat(
		collectHandymanTasks("cleanup", handymenCleanupNeededStore.get()),
		collectHandymanTasks("gardening", handymenGardeningNeededStore.get()),
		collectStaffOfTypeTasks("security", STAFF_TYPE_ID_SECURITY, 0, guardsNeededStore.get()),
		collectStaffOfTypeTasks("entertainer", STAFF_TYPE_ID_ENTERTAINER, 0, entertainersNeededStore.get()),
		collectStaffOfTypeTasks("mechanic", STAFF_TYPE_ID_MECHANIC, MECHANIC_ORDERS_DEFAULT, mechanicsNeededStore.get())
	);

	if (tasks.length === 0) {
		refreshHiredAndAssignedStaffCounts();
		setProgress(PROGRESS_ADJUST_DONE);
		if (onComplete) {
			onComplete();
		}
		return;
	}

	let pendingCount = tasks.length;
	let allDispatched = false;
	const finishIfDone: () => void = function () {
		if (allDispatched && pendingCount <= 0) {
			refreshHiredAndAssignedStaffCounts();
			if (onComplete) {
				onComplete();
			}
		}
	};
	const onActionComplete: () => void = function () {
		pendingCount--;
		finishIfDone();
	};

	setStatus(`${t("status.adjusting")} (0/${tasks.length.toString()})`);
	setProgress(0);
	applyInBatches(tasks, function (task, index) {
		runStaffAdjustTask(task, onActionComplete);
		setStatus(`${t("status.adjusting")} (${(index + 1).toString()}/${tasks.length.toString()})`);
		setProgress(PROGRESS_ADJUST_DONE * ((index + 1) / tasks.length));
	}, function () {
		allDispatched = true;
		finishIfDone();
	});
}

// --- Staff counting (Hired / Assigned) ---------------------------------------
// Counts the number of currently hired staff of a given type (e.g. handyman,
// security), and how many of those already have a non-empty patrol area
// (i.e. are already "assigned" to patrol a section of the park).
function countHiredStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (const member of staff) {
		if (member.staffType === staffType) {
			count++;
		}
	}
	return count;
}

function countAssignedStaff(staffType: StaffType): number {
	const staff = map.getAllEntities("staff");
	let count = 0;
	for (const member of staff) {
		if (member.staffType === staffType && member.patrolArea.tiles.length > 0) {
			count++;
		}
	}
	return count;
}

// Refreshes the Hired/Assigned stores for Handymen, Guards and Mechanics from
// the current, real-time staff roster. Unlike Needed (which depends on the
// potentially slow tile scan), this is cheap and can be refreshed whenever
// Calculate is pressed.
export function refreshHiredAndAssignedStaffCounts(): void {
	handymenHiredStore.set(countHiredStaff("handyman"));
	handymenAssignedStore.set(countAssignedStaff("handyman"));
	guardsHiredStore.set(countHiredStaff("security"));
	guardsAssignedStore.set(countAssignedStaff("security"));
	entertainersHiredStore.set(countHiredStaff("entertainer"));
	entertainersAssignedStore.set(countAssignedStaff("entertainer"));
	mechanicsHiredStore.set(countHiredStaff("mechanic"));
	mechanicsAssignedStore.set(countAssignedStaff("mechanic"));
}

// --- Assign patrol areas --------------------------------------------------------
// Converts a tile coordinate to the world (32-per-tile) coordinate used by
// patrol areas.
function tileToWorldXY(x: number, y: number): CoordsXY {
	return { x: x * 32, y: y * 32 };
}

// Teleports a staff member to the centre of the given tile, at the given
// world z height, via the "peeppickup" game action (pick the staff member
// up, then place them down at the target position).
//
// The game only supports one peep being "picked up" at a time (it's the same
// mechanic as the player dragging a peep with the cursor), so pickup/place
// requests for different staff members must never overlap - otherwise a
// later pickup can clobber an earlier one before its "place" has fired,
// causing staff to be placed at each other's target tiles. All teleports are
// therefore funnelled through a single queue that only runs one pickup+place
// pair at a time (see processTeleportQueue below).
interface PendingTeleport {
	id: number;
	x: number;
	y: number;
	z: number;
}
const teleportQueue: PendingTeleport[] = [];
let teleportInProgress = false;

function processTeleportQueue(): void {
	if (teleportInProgress) {
		return;
	}
	const next = teleportQueue.shift();
	if (!next) {
		return;
	}
	teleportInProgress = true;
	// Continue on the next tick rather than recursing, so a large queue is
	// processed iteratively across ticks instead of growing the call stack one frame
	// per teleport (which overflowed it).
	function scheduleNext(): void {
		teleportInProgress = false;
		context.setTimeout(processTeleportQueue, BATCH_TICK_DELAY);
	}
	context.executeAction("peeppickup", { type: 0, id: next.id, x: 0, y: 0, z: 0, playerId: 0 }, function (pickupResult) {
		if (pickupResult.error) {
			scheduleNext();
			return;
		}
		context.executeAction("peeppickup", { type: 2, id: next.id, x: next.x, y: next.y, z: next.z, playerId: 0 }, function () {
			scheduleNext();
		});
	});
}

export function teleportStaffToTile(member: Staff, x: number, y: number, z: number): void {
	const id = member.id;
	if (id === null) {
		return;
	}
	teleportQueue.push({ id: id, x: x * 32 + 16, y: y * 32 + 16, z: z });
	processTeleportQueue();
}

// Splits the given tile list into contiguous (spatially connected) chunks,
// each roughly totalTiles/staffCount tiles large. Unlike a naive index-based
// slice of the (DFS/BFS) visitation order - which can silently jump between
// unrelated branches or unrelated connected components and produce a "chunk"
// made of disjoint patches - this grows each chunk outward tile-by-tile via
// cardinal adjacency, so every chunk it returns is guaranteed to be one
// connected group of tiles. If the tile network is itself split into several
// disconnected pockets (e.g. separate garden areas), a chunk's growth simply
// stops once its local pocket is exhausted, which can result in more chunks
// than staffCount; callers should merge/ignore any surplus as appropriate.
export function chunkTilesForStaffCount(tiles: PathTileInfo[], staffCount: number): PathTileInfo[][] {
	if (staffCount <= 0 || tiles.length === 0) {
		return [];
	}
	const targetSize = Math.ceil(tiles.length / staffCount);

	const tileByKey = new Map<string, PathTileInfo>();
	const order: string[] = [];
	const orderIndexByKey = new Map<string, number>();
	for (const tile of tiles) {
		const key = tileKey(tile.x, tile.y);
		if (!tileByKey.has(key)) {
			tileByKey.set(key, tile);
			orderIndexByKey.set(key, order.length);
			order.push(key);
		}
	}

	const remaining = new Set<string>(order);
	const chunks: PathTileInfo[][] = [];

	// Index of the earliest entry in `order` that may still be in `remaining`.
	// Without this the search for the next region's start tile rescans `order`
	// from the beginning for every chunk, which is quadratic on large parks.
	let scanIndex = 0;

	while (remaining.size > 0) {
		let startKey: string | null = null;
		for (; scanIndex < order.length; scanIndex++) {
			if (remaining.has(order[scanIndex])) {
				startKey = order[scanIndex];
				break;
			}
		}
		if (startKey === null) {
			break;
		}

		const region: PathTileInfo[] = [];
		const queue: string[] = [startKey];
		remaining.delete(startKey);
		let queueIndex = 0;

		while (queueIndex < queue.length && region.length < targetSize) {
			const key = queue[queueIndex];
			queueIndex++;
			const current = tileByKey.get(key);
			if (!current) {
				break;
			}
			region.push(current);
			if (region.length >= targetSize) {
				break;
			}
			for (const neighbourKey of current.neighbourKeys) {
				if (remaining.has(neighbourKey)) {
					remaining.delete(neighbourKey);
					queue.push(neighbourKey);
				}
			}
		}

		// Any tiles enqueued but not yet processed (because the region hit
		// targetSize first) haven't actually been consumed - put them back
		// so later chunks can still use them. Re-added tiles can sit before
		// the current scan position, so rewind it to the earliest of them.
		for (; queueIndex < queue.length; queueIndex++) {
			const key = queue[queueIndex];
			remaining.add(key);
			const index = orderIndexByKey.get(key);
			if (index !== undefined && index < scanIndex) {
				scanIndex = index;
			}
		}

		chunks.push(region);
	}

	// The tile set may consist of several disconnected pockets (e.g.
	// separate lawn patches split apart by paths or rides, or paths at
	// heights that cannot be reached from one another), each of which
	// produces its own chunk above. If that leaves more chunks than
	// there are staff to assign them to, the surplus chunks would
	// otherwise be silently dropped by callers that only iterate up to
	// staffCount, leaving some areas with no assigned staff at all. To
	// avoid that, repeatedly merge the smallest chunk into a chunk it
	// is actually *connected* to, so every resulting patrol area stays
	// one contiguous, fully walkable piece. Chunks that share no
	// walkable link are never merged (that is exactly what used to
	// produce patrol areas a handyman got stuck in); if nothing can be
	// merged any more, the surplus chunks are kept and the largest
	// areas are assigned first.
	//
	// The connectivity graph between chunks is built once (O(total tiles))
	// and maintained incrementally as chunks are merged, instead of
	// recomputing every chunk's key set and testing every chunk pair on
	// each merge - that was quadratic in chunks *and* linear in tiles per
	// iteration, and was the single biggest source of the multi-second
	// freeze when assigning staff in a large park.
	if (chunks.length > staffCount) {
		mergeSurplusChunks(chunks, staffCount);
	}

	// With fewer staff than (unmergeable) areas, cover the biggest
	// areas first instead of whichever happened to be found first.
	if (chunks.length > staffCount) {
		chunks.sort(function (a, b) { return b.length - a.length; });
	}

	return chunks;
}

// Merges connected chunks together (smallest combined pair first) until at most
// `staffCount` of them remain, or until no two remaining chunks are connected.
// Mutates `chunks` in place.
//
// Connectivity is derived once from the tiles' neighbourKeys: every tile is
// mapped to the chunk owning it, so a chunk's outgoing links can be collected in
// a single pass over all tiles. Merging chunk `b` into chunk `a` then only has
// to rewire the handful of edges touching `b`, rather than re-testing every
// chunk pair against every tile again.
function mergeSurplusChunks(chunks: PathTileInfo[][], staffCount: number): void {
	const chunkIndexByKey = new Map<string, number>();
	for (let i = 0; i < chunks.length; i++) {
		for (const tile of chunks[i]) {
			chunkIndexByKey.set(tileKey(tile.x, tile.y), i);
		}
	}

	// linksOut[a] holds every chunk b that chunk a has a walkable link into
	// (mirroring the old chunksConnect(chunks[a], keySets[b]) test), linksIn[b]
	// the reverse, so both directions can be rewired on merge.
	const linksOut: Set<number>[] = chunks.map(function () { return new Set<number>(); });
	const linksIn: Set<number>[] = chunks.map(function () { return new Set<number>(); });
	for (let a = 0; a < chunks.length; a++) {
		for (const tile of chunks[a]) {
			for (const neighbourKey of tile.neighbourKeys) {
				const b = chunkIndexByKey.get(neighbourKey);
				if (b !== undefined && b !== a) {
					linksOut[a].add(b);
					linksIn[b].add(a);
				}
			}
		}
	}

	const merged: boolean[] = chunks.map(function () { return false; });
	let aliveCount = chunks.length;

	while (aliveCount > staffCount) {
		// Pick the connected pair with the smallest combined size, preferring
		// the lowest indices on ties (as the previous pairwise scan did).
		let bestA = -1;
		let bestB = -1;
		let bestSize = Number.POSITIVE_INFINITY;
		for (let a = 0; a < chunks.length; a++) {
			if (merged[a]) {
				continue;
			}
			for (const b of linksOut[a]) {
				if (merged[b] || b <= a) {
					continue;
				}
				const size = chunks[a].length + chunks[b].length;
				if (size < bestSize) {
					bestSize = size;
					bestA = a;
					bestB = b;
				}
			}
		}

		if (bestA === -1) {
			break;
		}

		chunks[bestA] = chunks[bestA].concat(chunks[bestB]);
		merged[bestB] = true;
		aliveCount--;

		// Rewire every edge that pointed at (or came from) the absorbed chunk
		// so it now refers to the surviving one.
		for (const b of linksOut[bestB]) {
			linksIn[b].delete(bestB);
			if (b !== bestA) {
				linksOut[bestA].add(b);
				linksIn[b].add(bestA);
			}
		}
		for (const a of linksIn[bestB]) {
			linksOut[a].delete(bestB);
			if (a !== bestA) {
				linksIn[bestA].add(a);
				linksOut[a].add(bestA);
			}
		}
		linksOut[bestA].delete(bestB);
		linksIn[bestA].delete(bestB);
		linksOut[bestB].clear();
		linksIn[bestB].clear();
	}

	// Drop the absorbed chunks, keeping the surviving ones in their original order.
	for (let i = chunks.length - 1; i >= 0; i--) {
		if (merged[i]) {
			chunks.splice(i, 1);
		}
	}
}

// Clears every given staff member's patrol area. Used at the start of each
// staff type's (re-)assignment so stale patrol areas don't linger.
function clearPatrolAreas(members: Staff[]): void {
	for (const member of members) {
		member.patrolArea.clear();
	}
}

// Applies `perTask` to each task, but only a bounded number per game tick, so
// assigning patrol areas to (or moving) many staff members doesn't block the game
// loop for the whole duration. Each step is re-scheduled with `context.setTimeout`
// using BATCH_TICK_DELAY, letting the game render/simulate in between.
// `onComplete` runs once every task has been processed.
// Kept deliberately small: each task issues a `patrolArea.add` game action for
// a whole chunk of tiles and may search for a placeable teleport tile, so a
// larger batch produces a visible stutter on each tick.
const TASKS_PER_TICK = 4;

// Delay used whenever work is deliberately deferred to a later tick. This must
// NOT be 0: a timer scheduled with delay 0 is already due when the engine's
// timer loop next looks at it, so it is re-entered within the *same* tick's
// timer-processing pass. That made every "batched" step run back-to-back in one
// tick - the game loop never got to render or simulate, so "Adjust and assign"
// still froze the game for seconds despite the batching.
export const BATCH_TICK_DELAY = 1;

// Helper to set the window's status row while "Adjust and assign" is running.
function setStatus(text: string): void {
	statusTextStore.set(text);
}

// Fractions of the overall "Adjust and assign" pass that each phase has
// completed by the time it finishes. The adjust phase animates smoothly from
// 0 up to PROGRESS_ADJUST_DONE as its hire/fire tasks are dispatched; the
// assignment steps step through the remaining fractions.
export const PROGRESS_ADJUST_DONE = 0.4;
export const PROGRESS_HANDYMEN_DONE = 0.55;
export const PROGRESS_GUARDS_DONE = 0.7;
export const PROGRESS_ENTERTAINERS_DONE = 0.85;

// Helper to set the window's progress bar (a fraction between 0 and 1).
function setProgress(fraction: number): void {
	progressStore.set(Math.max(0, Math.min(1, fraction)));
}

function applyInBatches<T>(tasks: T[], perTask: (task: T, index: number) => void, onComplete: () => void): void {
	let index = 0;
	function step(): void {
		const end = Math.min(tasks.length, index + TASKS_PER_TICK);
		for (; index < end; index++) {
			perTask(tasks[index], index);
		}
		if (index < tasks.length) {
			context.setTimeout(step, BATCH_TICK_DELAY);
		} else {
			onComplete();
		}
	}
	step();
}

// Whether a staff member can likely be placed on the given tile via
// "peeppickup". A tile with a walkable footpath element is accepted unless
// something genuinely blocks the column: a ride entrance/exit element (even
// from an unrelated ride placed on a bridge/tunnel above or below), an
// embedded ride track element (e.g. mini golf holes, which are technically
// "footpath" but belong to the ride), or a large scenery item. Footpath
// additions (bench, lamp, bin, queue TV, swamp plant) are NOT treated as
// blockers here - staff walk over them in-game, and excluding them made the
// teleport search bounce staff to the nearest unadorned path park-wide
// (clustering them on one far tile). If a place on a genuinely-blocked tile
// still fails, the async queue simply leaves the staff where they are.
//
// A tile with no footpath but a bare grass/surface (used for gardening
// areas, which have no footpath of their own) is also accepted, as long as
// it isn't blocked the same way and has no small scenery on it either -
// unlike mowing/watering (see hasBlockingElement/hasWaterableSceneryElement
// in scan.ts, which deliberately do NOT treat small scenery as a blocker so
// flower beds still count as garden tiles), "peeppickup" placement itself
// fails outright on any small scenery item (e.g. a tree), so such a tile
// must never be chosen as a teleport target even though a handyman can
// still walk across/around it once already patrolling the area normally.
export function isPeepPlaceableTile(x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= map.size.x || y >= map.size.y) {
		return false;
	}
	const tile = map.getTile(x, y);
	let footpath: FootpathElement | null = null;
	let hasSurface = false;
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "footpath") {
			footpath = element;
		} else if (element.type === "entrance" || element.type === "track" || element.type === "large_scenery" || element.type === "small_scenery") {
			return false;
		} else if (element.type === "surface") {
			hasSurface = true;
		}
	}
	return footpath !== null || hasSurface;
}

// Returns the given tiles ordered by Manhattan distance from (x, y), nearest
// first. Used so the placeability check below only has to touch the closest
// candidates instead of every tile in the park.
function tilesByDistance(tiles: PathTileInfo[], x: number, y: number): PathTileInfo[] {
	return tiles.slice().sort(function (a, b) {
		return (Math.abs(a.x - x) + Math.abs(a.y - y)) - (Math.abs(b.x - x) + Math.abs(b.y - y));
	});
}

// Finds the walkable footpath tile (from lastAllPathTiles) closest to the
// given tile, by Manhattan distance, that is actually clear enough for a
// staff member to be placed on (see isPeepPlaceableTile). Used to find a
// safe spot to teleport a staff member to when the tile they'd otherwise be
// placed on (e.g. a gardening tile covered in scenery, or a path tile with
// an obstruction) isn't safe/placeable, since "peeppickup" place fails (e.g.
// "Can't place person here... Swamp Plant in the way") when targeting
// obstructed tiles.
//
// Candidates are tested nearest-first and the search stops at the first
// placeable one. Testing every tile instead (isPeepPlaceableTile does a
// `map.getTile` plus an element scan) meant one engine query per path tile in
// the park *per staff member*, which was a major source of stutter while
// patrol areas were being assigned.
function findNearestPathTile(x: number, y: number): PathTileInfo | null {
	for (const tile of tilesByDistance(lastAllPathTiles, x, y)) {
		if (isPeepPlaceableTile(tile.x, tile.y)) {
			return tile;
		}
	}
	return null;
}

// Finds the walkable footpath tile closest to (x, y) among only the given
// tiles (typically the chunk/area being assigned to the staff member), that
// is actually clear enough for a staff member to be placed on. Fall back to
// the global nearest placeable tile if the area has none.
export function findNearestPathInOrderedTiles(tiles: PathTileInfo[], x: number, y: number): PathTileInfo | null {
	const inBounds = tiles.filter(function (tile) {
		return tile.x >= 0 && tile.y >= 0 && tile.x < map.size.x && tile.y < map.size.y;
	});
	for (const tile of tilesByDistance(inBounds, x, y)) {
		if (isPeepPlaceableTile(tile.x, tile.y)) {
			return tile;
		}
	}
	return findNearestPathTile(x, y);
}

// Assigns one consecutive chunk of the given ordered tile list to each hired
// staff member (only dealing with already-hired staff, per Assign's remit),
// and teleports each staff member to the first placeable tile of their new
// area. The chunk's own first tile isn't necessarily placeable (e.g.
// gardening tiles covered by scenery, or path tiles with an obstruction such
// as a ride entrance/exit or a bench), so the nearest actually-placeable
// tile is used as the teleport target instead; the patrol area itself still
// covers the full chunk regardless.
function assignConsecutiveAreas(members: Staff[], orderedTiles: PathTileInfo[], onComplete: () => void): void {
	clearPatrolAreas(members);
	if (members.length === 0) {
		onComplete();
		return;
	}
	const chunks = chunkTilesForStaffCount(orderedTiles, members.length);
	const tasks = chunks.slice(0, members.length).map(function (chunk, i) {
		return { member: members[i], chunk: chunk };
	});
	applyInBatches(tasks, function (task) {
		const area = task.chunk.map(function (t) { return tileToWorldXY(t.x, t.y); });
		task.member.patrolArea.add(area);
		// If the staff member is already standing on their area's first tile, they
		// don't need teleporting - this keeps automatic re-assignment from repeatedly
		// yanking already-correctly-placed staff, while newly-assigned/needed staff
		// are still moved to the start of their area.
		if (isStandingOnTile(task.member, task.chunk[0])) {
			return;
		}
		// Resolved here rather than up-front for every member, so the tile
		// placeability queries are spread across ticks along with the rest of
		// the work instead of all running before the first batch.
		const teleportTarget = findNearestPathInOrderedTiles(task.chunk, task.chunk[0].x, task.chunk[0].y) ?? task.chunk[0];
		teleportStaffToTile(task.member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
	}, onComplete);
}

// Whether the given staff member is currently standing on the given tile.
export function isStandingOnTile(member: Staff, tile: PathTileInfo): boolean {
	const tileX = Math.floor(member.x / 32);
	const tileY = Math.floor(member.y / 32);
	return tileX === tile.x && tileY === tile.y;
}

// The outcome of deciding what to do with a freshly placed tile for one staff type.
export type AreaDecision =
	| { action: "covered" }
	| { action: "enlarge"; areaIndex: number }
	| { action: "hire" };

// Converts a world coordinate to its integer tile coordinate.
export function worldToTileX(v: number): number {
	return Math.floor(v / 32);
}

// Cardinal-neighbour world-offsets used to find which areas are adjacent to a tile.
export const ADJACENT_OFFSETS: CoordsXY[] = [
	{ x: 32, y: 0 },
	{ x: -32, y: 0 },
	{ x: 0, y: 32 },
	{ x: 0, y: -32 }
];

// Pure decision logic for a freshly placed (or bought) tile against one staff type's
// already-assigned patrol areas, using that type's configured maximum area size:
//  - If the tile is already in any area              -> "covered"  (do nothing)
//  - Else if an adjacent area is under the max size -> "enlarge"  (extend that area)
//  - Else                                       -> "hire"      (new staff + assign)
// `areas` is the list of tile-world-coordinate arrays, one per already-hired staff
// member of the type. `newTile` is the placed tile in tile coordinates. The optional
// `connect` predicate decides whether the new tile is genuinely walkable to an
// existing area tile: when supplied, only actually-connected cardinal neighbours count as
// adjacent (so bridges/inclined ways are never merged); when omitted (tests), plain
// cardinal adjacency is used.
export function decideAreaAction(areas: CoordsXY[][], newTile: CoordsXY, maxSize: number, connect?: (areaTileX: number, areaTileY: number, newTileX: number, newTileY: number, areaIndex: number) => boolean): AreaDecision {
	if (newTile.x < 0 || newTile.y < 0) {
		return { action: "hire" };
	}
	// Index every area tile once by "x,y" tile key, mapping to the index of the
	// area it belongs to. The coverage and adjacency checks below then become
	// O(1) lookups instead of rescanning every tile of every area (the coverage
	// pass alone used to flatten and walk all areas on each placed tile).
	const areaIndexByTileKey = new Map<string, number>();
	for (let i = 0; i < areas.length; i++) {
		const area = areas[i];
		for (const tile of area) {
			const key = String(worldToTileX(tile.x)) + "," + String(worldToTileX(tile.y));
			// Keep the first area that claims a tile, matching the previous
			// first-match-wins iteration order.
			if (!areaIndexByTileKey.has(key)) {
				areaIndexByTileKey.set(key, i);
			}
		}
	}
	// 1. Already covered?
	if (areaIndexByTileKey.has(String(newTile.x) + "," + String(newTile.y))) {
		return { action: "covered" };
	}
	// 2. Adjacent to an existing area that's under the cap -> enlarge it.
	for (const offset of ADJACENT_OFFSETS) {
		const neighbourX = newTile.x + worldToTileX(offset.x);
		const neighbourY = newTile.y + worldToTileX(offset.y);
		const areaIndex = areaIndexByTileKey.get(String(neighbourX) + "," + String(neighbourY));
		if (areaIndex === undefined) {
			continue;
		}
		if (connect && !connect(neighbourX, neighbourY, newTile.x, newTile.y, areaIndex)) {
			continue;
		}
		if (areas[areaIndex].length < maxSize) {
			return { action: "enlarge", areaIndex: areaIndex };
		}
		return { action: "hire" };
	}
	return { action: "hire" };
}

// Returns the patrol-area tile arrays for every currently hired member of the
// given staff type (in order, one entry per member).
export function getStaffAreas(staffType: StaffType): CoordsXY[][] {
	return getStaffByType(staffType).map(function (m) { return m.patrolArea.tiles.slice(); });
}

// Assigns gardening areas built from the garden tiles' connected components.
// Unlike a flat/naive approach (concatenating every component into one tile
// list before chunking), each connected component is allocated its own
// dedicated gardener(s) and chunked entirely on its own. This guarantees a
// component that isn't reachable from the rest of the park's lawn (e.g. a
// patch of grass cut off by a path/building) always gets its own patrol
// area and gardener, rather than being merged with a spatially "nearby" but
// actually disconnected component - which would otherwise produce a patrol
// area whose tiles aren't all reachable from one another. Staff are
// allocated across components proportionally to each component's tile
// count (largest-remainder rounding), with at least one gardener per
// component when there are enough gardeners to go around; if there are
// fewer gardeners than components, the smallest components are left
// unassigned (logged) rather than silently merged into an unrelated area.
function assignGardeningAreas(members: Staff[], onComplete: () => void): void {
	clearPatrolAreas(members);
	if (members.length === 0) {
		onComplete();
		return;
	}

	const components = lastGardenAreas.filter(function (area) { return area.some(function (t) { return !t.isConnector; }); });
	if (components.length === 0) {
		onComplete();
		return;
	}

	// Only mowable/waterable tiles (work tiles) count toward staffing; footpath
	// connector tiles in an area are reachability only and don't add staffing.
	function workSize(area: PathTileInfo[]): number {
		let count = 0;
		for (const t of area) {
			if (!t.isConnector) {
				count++;
			}
		}
		return count;
	}

	const totalTiles = components.reduce(function (sum, area) { return sum + workSize(area); }, 0);

	// Each component's own needed count (same "max tiles per staff" rule
	// used for the needed-gardener total), guaranteeing every disconnected
	// area gets at least one gardener regardless of its size relative to
	// the others.
	const tilesPerStaff = handymenMowerTilesPerStaffStore.get();
	const desiredCounts = components.map(function (area) { return computeNeeded(workSize(area), tilesPerStaff); });
	const desiredTotal = desiredCounts.reduce(function (sum, c) { return sum + c; }, 0);

	let counts: number[];
	if (desiredTotal === members.length) {
		// Exactly enough gardeners hired to cover every area's own need;
		// use the per-area counts directly.
		counts = desiredCounts;
	} else {
		// Hired count doesn't match total need (e.g. hiring/firing hasn't
		// caught up yet); fall back to a largest-remainder allocation of
		// the actually-available gardeners, proportional to tile count.
		const allocations = components.map(function (area) {
			return (workSize(area) / totalTiles) * members.length;
		});
		counts = allocations.map(Math.floor);
		const assignedTotal = counts.reduce(function (sum, c) { return sum + c; }, 0);
		let remainder = members.length - assignedTotal;

		// Distribute leftover gardeners (from flooring) to the components with
		// the largest fractional remainder first.
		const order = components.map(function (_, i) { return i; })
			.sort(function (a, b) { return (allocations[b] - counts[b]) - (allocations[a] - counts[a]); });
		for (let i = 0; i < order.length && remainder > 0; i++) {
			counts[order[i]]++;
			remainder--;
		}

		// If there are more components than gardeners, some components will
		// have received zero gardeners above; ensure the largest components are
		// prioritized to receive at least one by taking from any
		// multiply-allocated component, largest first.
		if (members.length < components.length) {
			const bySizeDesc = components.map(function (_, i) { return i; })
				.sort(function (a, b) { return workSize(components[b]) - workSize(components[a]); });
			const newCounts = components.map(function () { return 0; });
			for (let i = 0; i < members.length; i++) {
				newCounts[bySizeDesc[i]] = 1;
			}
			counts = newCounts;
		}
	}

	let memberIndex = 0;
	const tasks: { member: Staff; chunk: PathTileInfo[] }[] = [];
	for (let c = 0; c < components.length; c++) {
		const count = counts[c];
		if (count <= 0) {
			continue;
		}
		const componentMembers = members.slice(memberIndex, memberIndex + count);
		memberIndex += count;

		const chunks = chunkTilesForStaffCount(components[c], componentMembers.length);
		for (let i = 0; i < chunks.length && i < componentMembers.length; i++) {
			tasks.push({ member: componentMembers[i], chunk: chunks[i] });
		}
	}
	applyInBatches(tasks, function (task) {
		task.member.patrolArea.add(task.chunk.map(function (t) { return tileToWorldXY(t.x, t.y); }));
		if (isStandingOnTile(task.member, task.chunk[0])) {
			return;
		}
		// Resolved per batch rather than up-front, so the tile placeability
		// queries are spread across ticks (see assignConsecutiveAreas).
		const teleportTarget = findNearestPathInOrderedTiles(task.chunk, task.chunk[0].x, task.chunk[0].y) ?? task.chunk[0];
		teleportStaffToTile(task.member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
	}, onComplete);
}

// Assigns consecutive entertainer areas, putting "perArea" entertainers into
// each patrol area (all sharing the same tiles), rather than one staff
// member per area like the other staff types.
function assignEntertainerAreas(members: Staff[], orderedTiles: PathTileInfo[], perArea: number, onComplete: () => void): void {
	clearPatrolAreas(members);
	if (members.length === 0 || orderedTiles.length === 0 || perArea <= 0) {
		onComplete();
		return;
	}
	const areaCount = Math.max(1, Math.ceil(members.length / perArea));
	const chunks = chunkTilesForStaffCount(orderedTiles, areaCount);
	const tasks: { member: Staff; coords: CoordsXY[]; chunk: PathTileInfo[]; anchorTile: PathTileInfo }[] = [];
	let memberIndex = 0;
	for (let a = 0; a < chunks.length && memberIndex < members.length; a++) {
		const chunk = chunks[a];
		const coords = chunk.map(function (t) { return tileToWorldXY(t.x, t.y); });
		for (let p = 0; p < perArea && memberIndex < members.length; p++, memberIndex++) {
			tasks.push({ member: members[memberIndex], coords: coords, chunk: chunk, anchorTile: chunk[0] });
		}
	}
	// Entertainers sharing an area also share a teleport target, so the search
	// result is cached per chunk - it is resolved lazily inside the batch (see
	// assignConsecutiveAreas) rather than up-front for every area.
	const teleportTargetByChunk = new Map<PathTileInfo[], PathTileInfo>();
	applyInBatches(tasks, function (task) {
		task.member.patrolArea.add(task.coords);
		if (isStandingOnTile(task.member, task.anchorTile)) {
			return;
		}
		let teleportTarget = teleportTargetByChunk.get(task.chunk);
		if (!teleportTarget) {
			teleportTarget = findNearestPathInOrderedTiles(task.chunk, task.chunk[0].x, task.chunk[0].y) ?? task.chunk[0];
			teleportTargetByChunk.set(task.chunk, teleportTarget);
		}
		teleportStaffToTile(task.member, teleportTarget.x, teleportTarget.y, teleportTarget.baseZ);
	}, onComplete);
}

// Finds the footpath element on a tile, if any (mirrors findSurfaceElement).
function findFootpathElement(tile: Tile): FootpathElement | null {
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if (element.type === "footpath") {
			return element;
		}
	}
	return null;
}

// Whether a mechanic can safely be teleported: the API doesn't expose
// whether a mechanic is currently servicing a ride, so this uses the best
// available proxy - a mechanic standing on a footpath tile is walking/idle,
// while one that isn't (e.g. inside a ride's building) is assumed to be
// busy fixing/inspecting it and is left alone.
export function canTeleportMechanic(member: Staff): boolean {
	const tileX = Math.floor(member.x / 32);
	const tileY = Math.floor(member.y / 32);
	return findFootpathElement(map.getTile(tileX, tileY)) !== null;
}

// Assigns mechanics to ride exits: each patrol area consists of just the
// ride exit tile and the path tile directly in front of it. Rather than
// trusting the exit's stored facing direction (which turned out to
// sometimes point to a side of the exit building with no path connected -
// e.g. when the exit is offset from the queue/track - and produced patrol
// areas that weren't reachable from the exit at all), every cardinal
// neighbour of the exit tile is checked and the one that actually has a
// footpath element on it is used. Only runs when exactly enough mechanics
// are hired to cover every ride exit (difference === 0); otherwise does
// nothing, since there's no sensible way to split a single-tile-pair area
// further.
function assignMechanics(onComplete: () => void): void {
	const mechanics = getStaffByType("mechanic");
	const mechanicsNeeded = mechanicsNeededStore.get();
	if (mechanics.length !== mechanicsNeeded) {
		onComplete();
		return;
	}

	// Every mechanic's patrol area is cleared and rebuilt to exactly the exit
	// tile plus the path tile in front of it. Clearing/re-adding a patrol area
	// does NOT physically move a mechanic or interrupt a repair in progress -
	// only teleporting does - so it is safe to reset areas for busy mechanics
	// too. This is important: skipping busy mechanics here would leave any
	// stale, larger patrol area (e.g. a 4x4 block from an earlier version of
	// this plugin) permanently in place, since a busy mechanic would never get
	// its area rebuilt. The teleport below is the only step gated on whether a
	// mechanic is busy.
	clearPatrolAreas(mechanics);

	const rides = map.rides;
	const tasks: { member: Staff; patrolTiles: CoordsXY[]; teleportTarget: { x: number; y: number; z: number } | null }[] = [];
	let mechanicIndex = 0;
	for (let i = 0; i < rides.length && mechanicIndex < mechanics.length; i++) {
		if (rides[i].classification !== "ride") {
			continue;
		}
		const stations = rides[i].stations;
		for (let s = 0; s < stations.length && mechanicIndex < mechanics.length; s++) {
			const exit = stations[s].exit;
			if (!isValidStationExit(exit)) {
				continue;
			}

			const exitTileX = Math.floor(exit.x / 32);
			const exitTileY = Math.floor(exit.y / 32);

			let frontTileX: number | null = null;
			let frontTileY: number | null = null;
			let frontFootpath: FootpathElement | null = null;

			// The "front" tile is the footpath the exit actually leads onto.
			// Prefer the exit's stored facing direction (mapped through
			// DIRECTION_OFFSETS, since the game's direction ordering does not
			// match CARDINAL_NEIGHBOUR_OFFSETS), then fall back to whichever
			// cardinal neighbour has a footpath, in case the stored direction
			// doesn't line up with where the path really is (e.g. an exit
			// offset from the queue/track). Selection is based purely on a
			// footpath being present - NOT on peep-placeability - so a path
			// tile carrying an addition (bench, lamp, bin, queue TV) or sharing
			// its column with an unrelated element, which blocks teleporting
			// but is still the correct tile to patrol, is never skipped in
			// favour of an unrelated neighbour.
			const preferredOffset = DIRECTION_OFFSETS[exit.direction] || CARDINAL_NEIGHBOUR_OFFSETS[0];
			const candidateOffsets = [preferredOffset].concat(
				CARDINAL_NEIGHBOUR_OFFSETS.filter(function (o) { return o.x !== preferredOffset.x || o.y !== preferredOffset.y; })
			);
			for (const offset of candidateOffsets) {
				const candidateX = exitTileX + offset.x;
				const candidateY = exitTileY + offset.y;
				const footpath = findFootpathElement(map.getTile(candidateX, candidateY));
				if (footpath !== null) {
					frontTileX = candidateX;
					frontTileY = candidateY;
					frontFootpath = footpath;
					break;
				}
			}

			// The patrol area must always stay just the exit tile plus the
			// path tile directly in front of it - if no cardinal neighbour has
			// a footpath, there is no valid "front of the ride" tile to patrol,
			// so the area is just the exit tile on its own. A distant fallback
			// tile is only ever used as a teleport destination (below), never
			// added to the patrol area, since that produced patrol areas far
			// away from the ride.
			const member = mechanics[mechanicIndex];
			const patrolTiles: CoordsXY[] = [tileToWorldXY(exitTileX, exitTileY)];
			if (frontTileX !== null && frontTileY !== null) {
				patrolTiles.push(tileToWorldXY(frontTileX, frontTileY));
			}

			// Only teleport idle mechanics. A busy mechanic (one not standing
			// on a footpath - see canTeleportMechanic, the best available proxy
			// for "currently servicing a ride") keeps its correct new patrol
			// area from above but is not physically dragged off mid-repair; it
			// will walk to its assigned area once it finishes its current job.
			let teleportTarget: { x: number; y: number; z: number } | null = null;
			if (canTeleportMechanic(member)) {
				// Prefer standing on the front tile, but only if a peep can
				// actually be placed there (it may carry a bench/lamp/bin);
				// otherwise drop the mechanic on the nearest placeable footpath.
				// The patrol area still stays on the real front tile regardless
				// of where the mechanic is physically placed.
				let teleportTileX: number | null = null;
				let teleportTileY: number | null = null;
				let teleportFootpath: FootpathElement | null = null;
				if (frontTileX !== null && frontTileY !== null && isPeepPlaceableTile(frontTileX, frontTileY)) {
					teleportTileX = frontTileX;
					teleportTileY = frontTileY;
					teleportFootpath = frontFootpath;
				} else {
					const nearestPathTile = findNearestPathTile(exitTileX, exitTileY);
					if (nearestPathTile) {
						teleportTileX = nearestPathTile.x;
						teleportTileY = nearestPathTile.y;
						teleportFootpath = findFootpathElement(map.getTile(nearestPathTile.x, nearestPathTile.y));
					}
				}
				if (teleportTileX !== null && teleportTileY !== null) {
					teleportTarget = {
						x: teleportTileX * 32 + 16,
						y: teleportTileY * 32 + 16,
						z: teleportFootpath ? teleportFootpath.baseZ : exit.z
					};
				}
			}
			tasks.push({ member: member, patrolTiles: patrolTiles, teleportTarget: teleportTarget });
			mechanicIndex++;
		}
	}
	applyInBatches(tasks, function (task) {
		task.member.patrolArea.add(task.patrolTiles);
		if (task.teleportTarget) {
			const id = task.member.id;
			if (id !== null) {
				teleportQueue.push({ id: id, x: task.teleportTarget.x, y: task.teleportTarget.y, z: task.teleportTarget.z });
				processTeleportQueue();
			}
		}
	}, onComplete);
}

// Information about a valid ride exit that has a footpath tile directly in front
// of it. Mechanics are only needed (and only assigned, in automatic mode) for
// exits that actually have a path, since an exit with no path yet has nothing to
// patrol and would leave a mechanic stuck on the exit tile.
interface StaffedRideExit {
	exitTileX: number;
	exitTileY: number;
	frontTileX: number;
	frontTileY: number;
	frontFootpath: FootpathElement;
}

// Collects every valid ride exit that has a footpath in front of it (see the
// front-finding logic in assignMechanics for why the facing direction alone isn't
// reliable - we fall back to any cardinal neighbour with a footpath).
function getStaffedRideExitFronts(): StaffedRideExit[] {
	const result: StaffedRideExit[] = [];
	const rides = map.rides;
	for (const ride of rides) {
		if (ride.classification !== "ride") {
			continue;
		}
		const stations = ride.stations;
		for (const station of stations) {
			const exit = station.exit;
			if (!isValidStationExit(exit)) {
				continue;
			}
			const exitTileX = Math.floor(exit.x / 32);
			const exitTileY = Math.floor(exit.y / 32);
			const preferredOffset = DIRECTION_OFFSETS[exit.direction] || CARDINAL_NEIGHBOUR_OFFSETS[0];
			const candidateOffsets = [preferredOffset].concat(
				CARDINAL_NEIGHBOUR_OFFSETS.filter(function (o) { return o.x !== preferredOffset.x || o.y !== preferredOffset.y; })
			);
			for (const offset of candidateOffsets) {
				const candidateX = exitTileX + offset.x;
				const candidateY = exitTileY + offset.y;
				const footpath = findFootpathElement(map.getTile(candidateX, candidateY));
				if (footpath !== null) {
					result.push({ exitTileX: exitTileX, exitTileY: exitTileY, frontTileX: candidateX, frontTileY: candidateY, frontFootpath: footpath });
					break;
				}
			}
		}
	}
	return result;
}

// The number of ride exits that actually have a footpath in front of them. Used
// by automatic mode to decide how many mechanics are needed; exits without a path
// yet aren't staffed until a path is added at them.
export function countStaffedRideExitFronts(): number {
	return getStaffedRideExitFronts().length;
}

// Whether any already-hired mechanic is assigned to (patrolling) the given exit
// tile - i.e. their patrol area contains that tile. Used by automatic mode to
// only hire/assign a mechanic for a newly-path-added exit that doesn't have one
// yet.
export function isExitAlreadyAssigned(exitTileX: number, exitTileY: number): boolean {
	const mechanics = getStaffByType("mechanic");
	for (const member of mechanics) {
		for (const tile of member.patrolArea.tiles) {
			if (Math.floor(tile.x / 32) === exitTileX && Math.floor(tile.y / 32) === exitTileY) {
				return true;
			}
		}
	}
	return false;
}

// Automatic-mode mechanics handling: hires a mechanic + assigns a patrol area for
// every ride exit that has a footpath in front of it and that doesn't already
// have a mechanic assigned. Exits without a front path, and exits already
// covered, are left alone so existing staff aren't disturbed.
export function adjustAndAssignAutoMechanics(onComplete: () => void): void {
	if (!mechanicsEnabledStore.get()) {
		onComplete();
		return;
	}
	const staffedExits = getStaffedRideExitFronts();
	const exitsNeedingMechanic = staffedExits.filter(function (exit) {
		return !isExitAlreadyAssigned(exit.exitTileX, exit.exitTileY);
	});
	if (exitsNeedingMechanic.length === 0) {
		onComplete();
		return;
	}
	const currentMechanics = getStaffByType("mechanic");
	const currentFree = currentMechanics.length - currentMechanics.filter(function (m) {
		return m.patrolArea.tiles.length > 0;
	}).length;
	const shortfall = Math.max(0, exitsNeedingMechanic.length - currentFree);
	if (shortfall > 0) {
		let hireDone = false;
		setStatus(t("status.assigningMechanics"));
		hireStaff(STAFF_TYPE_ID_MECHANIC, MECHANIC_ORDERS_DEFAULT, shortfall, function () {
			if (hireDone) {
				return;
			}
			hireDone = true;
			assignAutoMechanicAreas(exitsNeedingMechanic, onComplete);
		});
	} else {
		assignAutoMechanicAreas(exitsNeedingMechanic, onComplete);
	}
}

// Assigns a patrol area (exit tile + front path tile) to a mechanic for each of
// the given needed exits. Already-assigned mechanics keep their existing areas;
// only unassigned (free) mechanics are reused, and any shortfall is hired by the
// caller. Batching the work across ticks avoids a game freeze.
function assignAutoMechanicAreas(neededExits: StaffedRideExit[], onComplete: () => void): void {
	const mechanics = getStaffByType("mechanic");
	const freeMechanics = mechanics.filter(function (m) {
		return m.patrolArea.tiles.length === 0;
	});
	const tasks: { member: Staff; exit: StaffedRideExit }[] = neededExits.map(function (exit, i) {
		return { member: freeMechanics[i % freeMechanics.length], exit: exit };
	});
	applyInBatches(tasks, function (task) {
		const patrolTiles: CoordsXY[] = [tileToWorldXY(task.exit.exitTileX, task.exit.exitTileY)];
		patrolTiles.push(tileToWorldXY(task.exit.frontTileX, task.exit.frontTileY));
		task.member.patrolArea.add(patrolTiles);
		if (canTeleportMechanic(task.member)) {
			const id = task.member.id;
			if (id !== null) {
				teleportQueue.push({
					id: id,
					x: task.exit.frontTileX * 32 + 16,
					y: task.exit.frontTileY * 32 + 16,
					z: task.exit.frontFootpath.baseZ
				});
				processTeleportQueue();
			}
		}
	}, onComplete);
}

// Builds the ordered tile list entertainers patrol: path tiles, plus queue
// tiles too if the "Queue" toggle is on, preserving the original BFS
// visitation order across both.
function getEntertainerTiles(includeQueue: boolean): PathTileInfo[] {
	if (includeQueue) {
		return lastAllPathTiles;
	}
	return lastAllPathTiles.filter(function (t) { return !t.isQueue; });
}

// Recomputes which currently-hired handymen should be cleanup vs gardening
// handymen and (re-)applies their orders accordingly. A handyman's
// cleanup/gardening purpose is only set once, at hire time (via
// staffOrders), so without this, handymen hired before the needed
// cleanup/gardening tile split changed would keep their original purpose
// forever, and Assign would build patrol areas for the wrong number of
// cleanup/gardening handymen. This reassigns capabilities for every hired
// handyman - not just newly hired ones - every time Assign runs, splitting
// the currently hired handymen (oldest first, for a stable/consistent
// result) between cleanup and gardening in proportion to the needed counts.
function reassignHandymenOrders(): void {
	const handymen = getStaffByType("handyman").slice().sort(function (a, b) { return (a.id ?? 0) - (b.id ?? 0); });
	if (handymen.length === 0) {
		return;
	}

	const cleanupNeeded = handymenCleanupNeededStore.get();
	const gardeningNeeded = handymenGardeningNeededStore.get();
	const totalNeeded = cleanupNeeded + gardeningNeeded;

	let cleanupCount: number;
	if (totalNeeded <= 0) {
		cleanupCount = handymen.length;
	} else {
		cleanupCount = Math.round(handymen.length * (cleanupNeeded / totalNeeded));
	}
	cleanupCount = Math.max(0, Math.min(handymen.length, cleanupCount));

	for (let i = 0; i < handymen.length; i++) {
		const member = handymen[i] as Handyman;
		const desiredOrders = i < cleanupCount ? HANDYMAN_ORDERS_CLEANUP : HANDYMAN_ORDERS_GARDENING;
		if (member.orders !== desiredOrders) {
			member.orders = desiredOrders;
		}
	}
}

// Handles the "Assign" button: (re-)builds every staff type's patrol areas
// from the most recently scanned tiles, and teleports one staff member to
// the start of each new area. Only deals with already-hired staff; use
// "Adjust staff count" first to hire/fire staff to match the Needed counts.
// Assigns patrol areas for handymen, guards and entertainers (not mechanics).
// Used by both the manual Assign button and automatic mode; mechanics are handled
// separately (manual: assignMechanics; auto: adjustAndAssignAutoMechanics) so auto
// mode never clears/re-assigns already-placed mechanics.
export function assignHandymenGuardsEntertainers(onComplete: () => void): void {
	function next(): void {
		stepIndex++;
		if (stepIndex < steps.length) {
			steps[stepIndex]();
		} else {
			onComplete();
		}
	}

	const steps: (() => void)[] = [
		function () {
			if (!handymenEnabledStore.get()) {
				next();
				return;
			}
			reassignHandymenOrders();
			let remaining = 2;
			const done: () => void = function () {
				remaining--;
				if (remaining <= 0) {
					setProgress(PROGRESS_HANDYMEN_DONE);
					next();
				}
			};
			setStatus(t("status.assigningHandymen"));
			assignConsecutiveAreas(getHandymenByPurpose("cleanup"), lastAllPathTiles, done);
			assignGardeningAreas(getHandymenByPurpose("gardening"), done);
		},
		function () {
			if (guardsEnabledStore.get()) {
				setStatus(t("status.assigningGuards"));
				assignConsecutiveAreas(getStaffByType("security"), lastAllPathTiles.filter(function (t) { return !t.isQueue; }), function () {
					setProgress(PROGRESS_GUARDS_DONE);
					next();
				});
			} else {
				setProgress(PROGRESS_GUARDS_DONE);
				next();
			}
		},
		function () {
			if (entertainersEnabledStore.get()) {
				setStatus(t("status.assigningEntertainers"));
				assignEntertainerAreas(getStaffByType("entertainer"), getEntertainerTiles(entertainersIncludeQueueStore.get()), entertainersPerAreaStore.get(), function () {
					setProgress(PROGRESS_ENTERTAINERS_DONE);
					next();
				});
			} else {
				setProgress(PROGRESS_ENTERTAINERS_DONE);
				next();
			}
		}
	];

	let stepIndex = 0;
	steps[0]();
}

export function assignStaff(): void {
	const finish: () => void = function () {
		setProgress(1);
		setStatus(t("status.done"));
	};
	assignHandymenGuardsEntertainers(function () {
		if (mechanicsEnabledStore.get()) {
			setStatus(t("status.assigningMechanics"));
			assignMechanics(finish);
		} else {
			finish();
		}
	});
}


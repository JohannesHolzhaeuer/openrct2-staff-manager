import {
	ADJACENT_OFFSETS,
	HANDYMAN_ORDERS_CLEANUP,
	HANDYMAN_ORDERS_GARDENING,
	MECHANIC_ORDERS_DEFAULT,
	STAFF_TYPE_ID_ENTERTAINER,
	STAFF_TYPE_ID_HANDYMAN,
	STAFF_TYPE_ID_MECHANIC,
	STAFF_TYPE_ID_SECURITY,
	canTeleportMechanic,
	decideAreaAction,
	findNearestPathInOrderedTiles,
	getStaffByType,
	hireStaff,
	isExitAlreadyAssigned,
	isPeepPlaceableTile,
	refreshHiredAndAssignedStaffCounts,
	teleportStaffToTile,
	worldToTileX,
} from "./staff";
import {
	PathTileInfo,
	footpathsConnectTiles,
	isGardenTile,
	isQueueTile,
	isValidStationExit,
	surfaceBaseZAt,
	surfaceTilesConnect,
	tileKey,
} from "./scan";
import {
	entertainersEnabledStore,
	entertainersIncludeQueueStore,
	entertainersTilesPerStaffStore,
	guardsEnabledStore,
	guardsTilesPerStaffStore,
	handymenEnabledStore,
	handymenMowerTilesPerStaffStore,
	handymenTilesPerStaffStore,
	mechanicsEnabledStore,
} from "./store";
import { gameMap } from "./game";

// --- Incremental automatic helpers (single-tile) ---------------------------------
//
// Automatic mode must make decisions *synchronously* so that a burst of connected
// tile placements is handled correctly. If we based the decision on the live staff
// roster / patrol areas (which only update asynchronously, after the `staffhire`
// and `patrolArea.add` game actions complete), a freshly hired member would not
// yet show its (single, empty-looking) patrol area when the next connected tile is
// decided, so every tile would fall through to "hire" — one staff member per tile
// and no area ever getting extended to its max. Instead we keep our own in-memory
// record of each staff type's auto-mode areas, seeded from the roster at the first
// tile of a batch and updated synchronously as tiles are added. Decisions run
// against these synchronous areas, and hires are queued one at a time; each newly
// hired member gets the tiles accumulated for it assigned patched onto its real
// patrol area once the hire completes.
interface AutoArea {
	member: Staff | undefined;
	// Tile keys (see tileKey) of tiles assigned to this area, world-coordinate
	// lists of the patrol area tile targets for TeleportStoredTile are kept in
	// tileKeys for coverage/adjacency checks.
	tileKeys: Set<string>;
	// World coordinates of every tile in this area (for patrolArea.add).
	coords: CoordsXY[];
}

interface AutoGroup {
	staffType: StaffType;
	staffTypeId: number;
	orders: number;
	getMaxSize: () => number;
	purpose: string;
	// Connectivity predicate (shared with the manual scan) used to decide whether a
	// freshly placed tile is genuinely walkable into an area before enlarging it.
	connect: (areaTile: CoordsXY, newTile: CoordsXY, areaIndex: number) => boolean;
}

const AUTO_GROUP_CLEANUP: AutoGroup = {
	staffType: "handyman",
	staffTypeId: STAFF_TYPE_ID_HANDYMAN,
	orders: HANDYMAN_ORDERS_CLEANUP,
	getMaxSize: () => handymenTilesPerStaffStore.get(),
	purpose: "cleanup",
	connect: (areaTile, newTile) => footpathsConnectTiles(areaTile, newTile),
};
const AUTO_GROUP_GARDENING: AutoGroup = {
	staffType: "handyman",
	staffTypeId: STAFF_TYPE_ID_HANDYMAN,
	orders: HANDYMAN_ORDERS_GARDENING,
	getMaxSize: () => handymenMowerTilesPerStaffStore.get(),
	purpose: "gardening",
	connect: (areaTile, newTile) => surfaceTilesConnect(areaTile, newTile),
};
const AUTO_GROUP_GUARD: AutoGroup = {
	staffType: "security",
	staffTypeId: STAFF_TYPE_ID_SECURITY,
	orders: 0,
	getMaxSize: () => guardsTilesPerStaffStore.get(),
	purpose: "guard",
	connect: (areaTile, newTile) => footpathsConnectTiles(areaTile, newTile),
};
const AUTO_GROUP_ENTERTAINER: AutoGroup = {
	staffType: "entertainer",
	staffTypeId: STAFF_TYPE_ID_ENTERTAINER,
	orders: 0,
	getMaxSize: () => entertainersTilesPerStaffStore.get(),
	purpose: "entertainer",
	connect: (areaTile, newTile) => footpathsConnectTiles(areaTile, newTile),
};

// Synchronous per-purpose area records (see the block comment above the interface).
const autoAreasByPurpose = new Map<string, AutoArea[]>();
// Tracks which purpose currently has an outstanding (async) hire so hires within a burst
// are serialized one at a time instead of one per tile.
const autoHireForPurpose = new Map<string, boolean>();

function autoAreas(group: AutoGroup): AutoArea[] {
	let list = autoAreasByPurpose.get(group.purpose);
	if (!list) {
		list = [];
		for (const m of getStaffByType(group.staffType)) {
			const coords = [...m.patrolArea.tiles];
			const keys = new Set<string>();
			for (const t of coords) {
				keys.add(tileKey(worldToTileX(t.x), worldToTileX(t.y)));
			}
			list.push({ member: m, tileKeys: keys, coords: coords });
		}
		autoAreasByPurpose.set(group.purpose, list);
	}
	return list;
}

function autoAddTileToArea(group: AutoGroup, areaIndex: number, tile: CoordsXY): void {
	const area = autoAreas(group)[areaIndex];
	if (area.tileKeys.has(tileKey(tile.x, tile.y))) {
		return;
	}
	area.tileKeys.add(tileKey(tile.x, tile.y));
	area.coords.push({ x: tile.x * 32, y: tile.y * 32 });
}

function handleTileForGroup(group: AutoGroup, tx: number, ty: number): boolean {
	const areas = autoAreas(group);
	const list = autoAreasAsCoords(group);
	const decision = decideAreaAction({
		areas: list,
		newTile: { x: tx, y: ty },
		maxSize: group.getMaxSize(),
		connect: group.connect,
	});
	if ("covered" === decision.action) {
		return false;
	}
	if ("enlarge" === decision.action) {
		autoAddTileToArea(group, decision.areaIndex, { x: tx, y: ty });
		applyAutoAreasToLive(group);
		return false;
	}
	areas.push({
		member: undefined,
		tileKeys: new Set([tileKey(tx, ty)]),
		coords: [{ x: tx * 32, y: ty * 32 }],
	});
	queueAutoHire(group, tx, ty);
	return true;
}

function autoAreasAsCoords(group: AutoGroup): CoordsXY[][] {
	return autoAreas(group).map(function (a) {
		return a.coords;
	});
}

function applyAutoAreasToLive(group: AutoGroup): void {
	for (const area of autoAreas(group)) {
		if (area.member) {
			area.member.patrolArea.add(area.coords);
		}
	}
}

// The teleport height for a member of the given auto group at (tx, ty):
// surface height for gardening handymen (so they land on the grass to mow),
// or footpath height otherwise.
function teleportZForGroup(group: AutoGroup, tx: number, ty: number): number {
	if ("handyman" === group.staffType && group.orders === HANDYMAN_ORDERS_GARDENING) {
		return surfaceBaseZAt(tx, ty);
	}
	return footpathBaseZAt(tx, ty);
}

function queueAutoHire(group: AutoGroup, tx: number, ty: number): void {
	if (autoHireForPurpose.get(group.purpose)) {
		return;
	}
	autoHireForPurpose.set(group.purpose, true);
	hireStaff({ staffTypeId: group.staffTypeId, orders: group.orders, countToHire: 1 }, function () {
		autoHireForPurpose.set(group.purpose, false);
		const member = getLastStaffOfType(group.staffType);
		if (member) {
			const area = autoAreas(group)[autoAreas(group).length - 1];
			if (
				"handyman" === group.staffType &&
				group.orders === HANDYMAN_ORDERS_GARDENING &&
				(member as Handyman).orders !== HANDYMAN_ORDERS_GARDENING
			) {
				(member as Handyman).orders = HANDYMAN_ORDERS_GARDENING;
			}
			area.member = member;
			member.patrolArea.add(area.coords);
			const z = teleportZForGroup(group, tx, ty);
			// For a gardening area, avoid dropping the handyman onto a queue/fenced
			// footpath (which now only occurs as a possible teleport tile when the tile
			// itself is a path), so they can actually step onto the grass they are to mow.
			let teleportX = tx;
			let teleportY = ty;
			let teleportZ = z;
			if (
				"handyman" === group.staffType &&
				group.orders === HANDYMAN_ORDERS_GARDENING &&
				isQueueTile(tx, ty)
			) {
				const workTile = area.coords.find(function (c) {
					const wx = Math.floor(c.x / 32);
					const wy = Math.floor(c.y / 32);
					if (wx === tx && wy === ty) {
						return false;
					}
					return !isQueueTile(wx, wy);
				});
				if (workTile) {
					teleportX = Math.floor(workTile.x / 32);
					teleportY = Math.floor(workTile.y / 32);
					teleportZ = surfaceBaseZAt(teleportX, teleportY);
				}
			}
			// The chosen (tx, ty) tile (e.g. a gardening/land tile that just triggered
			// this hire) isn't guaranteed to be peep-placeable - it may have small
			// scenery (a tree) or other obstruction on it - so fall back to the
			// nearest actually-placeable tile in this area, then park-wide, rather
			// than issuing a "peeppickup" place that's guaranteed to fail (surfaced
			// in-game as a "Can't place person here..." popup).
			if (!isPeepPlaceableTile(teleportX, teleportY)) {
				const fallback = findNearestPathInOrderedTiles(
					area.coords.map(function (c): PathTileInfo {
						return {
							x: Math.floor(c.x / 32),
							y: Math.floor(c.y / 32),
							baseHeight: 0,
							baseZ: 0,
							isQueue: false,
							neighbourKeys: [],
						};
					}),
					teleportX,
					teleportY,
				);
				if (fallback) {
					teleportX = fallback.x;
					teleportY = fallback.y;
					teleportZ = teleportZForGroup(group, teleportX, teleportY);
				}
			}
			teleportStaffToTile(member, { x: teleportX, y: teleportY, z: teleportZ });
		}
		refreshHiredAndAssignedStaffCounts();
	});
}

function getLastStaffOfType(staffType: StaffType): Staff | undefined {
	const members = getStaffByType(staffType);
	if (0 < members.length) {
		return members[members.length - 1];
	}
	return undefined;
}

// The baseZ of the footpath on a tile, if any (used as a teleport height).
function footpathBaseZAt(tx: number, ty: number): number {
	const tile = gameMap().getTile(tx, ty);
	for (const member of getFootpathBaseZFromTile(tile)) {
		return member;
	}
	return 0;
}

// Returns an array with the baseZ of the first footpath element on the tile.
function getFootpathBaseZFromTile(tile: Tile): number[] {
	const result: number[] = [];
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if ("footpath" === element.type) {
			result.push(element.baseZ);
		}
	}
	return result;
}

// Handles one freshly placed path/queue tile for the given staff type's patroling.
// `isQueue` boolean determines path vs queue handling; queue tiles are only handled by
// handymen (cleanup) and entertainers (if the Queue toggle is on).
function handlePathTileForType(staffType: StaffType, orders: number, tile: CoordsXY): void {
	const group = groupForPathTile(staffType, orders);
	handleTileForGroup(group, tile.x, tile.y);
	refreshHiredAndAssignedStaffCounts();
}

// Maps a staff type + orders to its persistent auto-mode group.
function groupForPathTile(staffType: StaffType, orders: number): AutoGroup {
	if ("handyman" === staffType) {
		if (orders === HANDYMAN_ORDERS_GARDENING) {
			return AUTO_GROUP_GARDENING;
		}
		return AUTO_GROUP_CLEANUP;
	}
	if ("security" === staffType) {
		return AUTO_GROUP_GUARD;
	}
	return AUTO_GROUP_ENTERTAINER;
}

// Handles a freshly placed path/queue tile for all relevant staff types.
export function handlePlacedPathTile(tx: number, ty: number, isQueue: boolean): void {
	// Mechanics: if a ride exit is on an adjacent tile, assign a mechanic.
	handleMechanicForAdjacentExit(tx, ty);

	if (isQueue) {
		// Queue tiles: only handymen (cleanup) and entertainers (if the Queue
		// toggle is on).
		if (handymenEnabledStore.get()) {
			handlePathTileForType("handyman", HANDYMAN_ORDERS_CLEANUP, { x: tx, y: ty });
		}
		if (entertainersEnabledStore.get() && entertainersIncludeQueueStore.get()) {
			handlePathTileForType("entertainer", 0, { x: tx, y: ty });
		}
		return;
	}

	// Plain path tiles: cleanup handymen, guards and entertainers.
	if (handymenEnabledStore.get()) {
		handlePathTileForType("handyman", HANDYMAN_ORDERS_CLEANUP, { x: tx, y: ty });
	}
	if (guardsEnabledStore.get()) {
		handlePathTileForType("security", 0, { x: tx, y: ty });
	}
	if (entertainersEnabledStore.get()) {
		handlePathTileForType("entertainer", 0, { x: tx, y: ty });
	}
}

// Handles a newly bought land tile: if it becomes a garden tile, apply the
// gardening-handyman enlarge-vs-hire rule.
export function handleBoughtLandTile(tx: number, ty: number): void {
	if (!handymenEnabledStore.get()) {
		return;
	}
	if (!isGardenTile(tx, ty)) {
		return;
	}
	handleTileForGroup(AUTO_GROUP_GARDENING, tx, ty);
	refreshHiredAndAssignedStaffCounts();
}

// If a ride exit sits on a tile adjacent to the given path tile and no mechanic is
// assigned there yet, hire+assign a mechanic covering (exit tile + this tile).
function handleMechanicForAdjacentExit(tx: number, ty: number): void {
	if (!mechanicsEnabledStore.get()) {
		return;
	}
	for (const offset of ADJACENT_OFFSETS) {
		const ex = tx + worldToTileX(offset.x);
		const ey = ty + worldToTileX(offset.y);
		if (isRideExitOnTile(ex, ey)) {
			if (isExitAlreadyAssigned(ex, ey)) {
				return;
			}
			// Hire one mechanic and assign (exit + this path tile).
			hireAndAssignMechanicForExit({ x: ex, y: ey }, { x: tx, y: ty });
			return;
		}
	}
}

// Whether a ride exit element sits on the given tile.
function isRideExitOnTile(tx: number, ty: number): boolean {
	const rides = gameMap().rides;
	for (const ride of rides) {
		const stations = ride.stations;
		for (const station of stations) {
			const exit = station.exit;
			if (isValidStationExit(exit)) {
				if (Math.floor(exit.x / 32) === tx && Math.floor(exit.y / 32) === ty) {
					return true;
				}
			}
		}
	}
	return false;
}

// Hires one mechanic and assigns a patrol area covering the exit tile and the given
// path tile in front of it.
function hireAndAssignMechanicForExit(exitTile: CoordsXY, frontTile: CoordsXY): void {
	hireStaff(
		{ staffTypeId: STAFF_TYPE_ID_MECHANIC, orders: MECHANIC_ORDERS_DEFAULT, countToHire: 1 },
		function () {
			const mechanics = getStaffByType("mechanic");
			if (0 === mechanics.length) {
				return;
			}
			const member = mechanics[mechanics.length - 1];
			member.patrolArea.add([
				{ x: exitTile.x * 32, y: exitTile.y * 32 },
				{ x: frontTile.x * 32, y: frontTile.y * 32 },
			]);
			if (canTeleportMechanic(member)) {
				teleportStaffToTile(member, {
					x: frontTile.x,
					y: frontTile.y,
					z: footpathBaseZAt(frontTile.x, frontTile.y),
				});
			}
			refreshHiredAndAssignedStaffCounts();
		},
	);
}

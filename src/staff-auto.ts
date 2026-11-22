import {
	ADJACENT_OFFSETS,
	type AreaNode,
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
	getHandymenByPurpose,
	getStaffByType,
	hireStaff,
	isExitAlreadyAssigned,
	isPeepPlaceableTile,
	refreshHiredAndAssignedStaffCounts,
	teleportStaffToTile,
	worldToTileX,
} from "./staff";
import {
	type PathTileInfo,
	footpathBaseZsAt,
	isGardenTile,
	isQueueTile,
	isValidStationExit,
	lastScanComponentOf,
	pathLevelsConnect,
	pathNodeKey,
	surfaceBaseZAt,
	surfaceTilesConnect,
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
	// Node keys (see pathNodeKey: "x,y,baseZ") of the tile LEVELS assigned to
	// this area. Levels, not tiles: a single tile can carry several stacked
	// footpaths at different heights (a bridge over a ground path) that belong
	// to separate walkable networks, so the area owns each level it actually
	// walks - keying by (x, y, baseZ) is what stops a bridge level from being
	// glued onto a ground-level area (or vice versa).
	nodeKeys: Set<string>;
	// World coordinates of every distinct x/y tile in this area (for
	// patrolArea.add). The engine's patrol area is x/y-only, so one coordinate
	// per tile covers every level the area has there.
	coords: CoordsXY[];
}

interface AutoGroup {
	staffType: StaffType;
	staffTypeId: number;
	orders: number;
	getMaxSize: () => number;
	purpose: string;
	// The tile level(s) (baseZ) the freshly handled tile currently carries for
	// this group: one entry per stacked footpath level for the path groups,
	// the surface height for the gardening group.
	getLevels: (tx: number, ty: number) => number[];
	// Connectivity predicate (shared with the manual scan) used to decide whether a
	// freshly placed tile level is genuinely walkable into an area before enlarging it.
	connect: (areaNode: AreaNode, newNode: AreaNode, areaIndex: number) => boolean;
}

const AUTO_GROUP_CLEANUP: AutoGroup = {
	staffType: "handyman",
	staffTypeId: STAFF_TYPE_ID_HANDYMAN,
	orders: HANDYMAN_ORDERS_CLEANUP,
	getMaxSize: () => handymenTilesPerStaffStore.get(),
	purpose: "cleanup",
	getLevels: (tx, ty) => footpathBaseZsAt(tx, ty),
	connect: (areaNode, newNode) => pathLevelsConnect(areaNode, newNode),
};
const AUTO_GROUP_GARDENING: AutoGroup = {
	staffType: "handyman",
	staffTypeId: STAFF_TYPE_ID_HANDYMAN,
	orders: HANDYMAN_ORDERS_GARDENING,
	getMaxSize: () => handymenMowerTilesPerStaffStore.get(),
	purpose: "gardening",
	getLevels: (tx, ty) => [surfaceBaseZAt(tx, ty)],
	connect: (areaNode, newNode) =>
		surfaceTilesConnect({ x: areaNode.x, y: areaNode.y }, { x: newNode.x, y: newNode.y }),
};
const AUTO_GROUP_GUARD: AutoGroup = {
	staffType: "security",
	staffTypeId: STAFF_TYPE_ID_SECURITY,
	orders: 0,
	getMaxSize: () => guardsTilesPerStaffStore.get(),
	purpose: "guard",
	getLevels: (tx, ty) => footpathBaseZsAt(tx, ty),
	connect: (areaNode, newNode) => pathLevelsConnect(areaNode, newNode),
};
const AUTO_GROUP_ENTERTAINER: AutoGroup = {
	staffType: "entertainer",
	staffTypeId: STAFF_TYPE_ID_ENTERTAINER,
	orders: 0,
	getMaxSize: () => entertainersTilesPerStaffStore.get(),
	purpose: "entertainer",
	getLevels: (tx, ty) => footpathBaseZsAt(tx, ty),
	connect: (areaNode, newNode) => pathLevelsConnect(areaNode, newNode),
};

// Synchronous per-purpose area records (see the block comment above the interface).
const autoAreasByPurpose = new Map<string, AutoArea[]>();
// Tracks which purpose currently has an outstanding (async) hire so hires within a burst
// are serialized one at a time instead of one per tile.
const autoHireForPurpose = new Map<string, boolean>();

// Test seam only. Production code must never call this. Clears the in-memory
// auto-area records so a fresh test can seed them from its own staff roster.
export const resetAutoAreas = function resetAutoAreas(): void {
	autoAreasByPurpose.clear();
	autoHireForPurpose.clear();
};

// The roster members that belong to this group. For the handyman groups only
// handymen of the matching purpose: a cleanup handyman's path area must not
// seed the gardening group's record (and vice versa), since the two patrol
// entirely different tile sets.
const groupMembers = function groupMembers(group: AutoGroup): Staff[] {
	if ("handyman" === group.staffType) {
		return HANDYMAN_ORDERS_GARDENING === group.orders
			? getHandymenByPurpose("gardening")
			: getHandymenByPurpose("cleanup");
	}
	return getStaffByType(group.staffType);
};

// Decodes a path node key ("x,y,baseZ", see pathNodeKey) back into an AreaNode.
const keyToNode = function keyToNode(key: string): AreaNode {
	const parts = key.split(",");
	return { x: Number(parts[0]), y: Number(parts[1]), baseZ: Number(parts[2]) };
};

// Seeds a member's (x/y-only) patrol area into (x/y/height) nodes. Land (the
// gardening group) has one level per tile. For path groups, a tile with a
// single footpath level is unambiguous. A tile carrying several stacked
// footpaths (a bridge over a ground path) is ambiguous - the patrol area API
// carries no height - so its level(s) are resolved against the most recent
// scan's walk graph: only the level(s) that belong to the same walkable
// component as this area's other nodes are kept. With no scan graph to
// resolve against, every level is kept: the engine's patrol area is x/y-only
// anyway, so this can at worst re-create the old over-merge on a later
// placement, never drop a level the area genuinely walks.
const seedAreaNodes = function seedAreaNodes(group: AutoGroup, coords: CoordsXY[]): Set<string> {
	const nodeKeys = new Set<string>();
	if ("handyman" === group.staffType && HANDYMAN_ORDERS_GARDENING === group.orders) {
		for (const tile of coords) {
			const tx = worldToTileX(tile.x);
			const ty = worldToTileX(tile.y);
			nodeKeys.add(pathNodeKey(tx, ty, surfaceBaseZAt(tx, ty)));
		}
		return nodeKeys;
	}
	const levelsByTileKey = new Map<string, number[]>();
	for (const tile of coords) {
		const tx = worldToTileX(tile.x);
		const ty = worldToTileX(tile.y);
		const key = `${tx},${ty}`;
		if (!levelsByTileKey.has(key)) {
			levelsByTileKey.set(key, footpathBaseZsAt(tx, ty));
		}
	}
	let hasAmbiguousTile = false;
	for (const levels of levelsByTileKey.values()) {
		if (1 < levels.length) {
			hasAmbiguousTile = true;
			break;
		}
	}
	if (!hasAmbiguousTile) {
		for (const [key, levels] of levelsByTileKey) {
			for (const baseZ of levels) {
				nodeKeys.add(pathNodeKey(Number(key.split(",")[0]), Number(key.split(",")[1]), baseZ));
			}
		}
		return nodeKeys;
	}
	// Resolve the stacked tiles via the walk-graph components of this area's
	// unambiguous nodes.
	const areaComponents = new Set<number>();
	for (const [key, levels] of levelsByTileKey) {
		if (1 === levels.length) {
			const [x, y] = key.split(",");
			const component = lastScanComponentOf(pathNodeKey(Number(x), Number(y), levels[0]));
			if (component !== undefined) {
				areaComponents.add(component);
			}
		}
	}
	for (const [key, levels] of levelsByTileKey) {
		const [x, y] = key.split(",");
		const tx = Number(x);
		const ty = Number(y);
		if (1 === levels.length) {
			nodeKeys.add(pathNodeKey(tx, ty, levels[0]));
		} else {
			let addedAny = false;
			for (const baseZ of levels) {
				const component = lastScanComponentOf(pathNodeKey(tx, ty, baseZ));
				if (component !== undefined && areaComponents.has(component)) {
					nodeKeys.add(pathNodeKey(tx, ty, baseZ));
					addedAny = true;
				}
			}
			if (!addedAny) {
				for (const baseZ of levels) {
					nodeKeys.add(pathNodeKey(tx, ty, baseZ));
				}
			}
		}
	}
	return nodeKeys;
};

const autoAreas = function autoAreas(group: AutoGroup): AutoArea[] {
	let list = autoAreasByPurpose.get(group.purpose);
	if (!list) {
		list = [];
		for (const m of groupMembers(group)) {
			const coords = [...m.patrolArea.tiles];
			const nodeKeys = seedAreaNodes(group, coords);
			list.push({ member: m, nodeKeys: nodeKeys, coords: coords });
		}
		autoAreasByPurpose.set(group.purpose, list);
	}
	return list;
};

const autoAddNodeToArea = function autoAddNodeToArea(
	group: AutoGroup,
	areaIndex: number,
	node: AreaNode,
): void {
	const area = autoAreas(group)[areaIndex];
	const key = pathNodeKey(node.x, node.y, node.baseZ);
	if (area.nodeKeys.has(key)) {
		return;
	}
	area.nodeKeys.add(key);
	// The engine's patrol area is x/y-only, so only add the coordinate when
	// this is the first level of the tile the area gains.
	const tileKeyOfNode = `${node.x},${node.y}`;
	const hasTile = area.coords.some(function sameTile(c) {
		return tileKeyOfNode === `${worldToTileX(c.x)},${worldToTileX(c.y)}`;
	});
	if (!hasTile) {
		area.coords.push({ x: node.x * 32, y: node.y * 32 });
	}
};

// Decides what to do with every level the freshly placed/bought tile
// currently carries: a level already in an area is "covered"; a level
// genuinely walkable into an under-cap area enlarges it; anything else starts
// a new area (and a hire). Deciding per level - rather than per tile - is
// what keeps a stacked tile's levels in their own height networks: the
// ground level of a bridge-over-path tile stays in the ground area while the
// bridge level above it grows into the bridge's own area.
const handleTileForGroup = function handleTileForGroup(
	group: AutoGroup,
	tx: number,
	ty: number,
): boolean {
	const levels = group.getLevels(tx, ty);
	if (0 === levels.length) {
		return false;
	}
	const areas = autoAreas(group);
	// A node view per area for decideAreaAction, kept in sync with the
	// AutoArea records as nodes are added below.
	const nodeAreas: AreaNode[][] = areas.map(function areaNodes(a) {
		return [...a.nodeKeys].map(keyToNode);
	});
	let hired = false;
	let enlarged = false;
	for (const baseZ of levels) {
		const newNode: AreaNode = { x: tx, y: ty, baseZ: baseZ };
		const decision = decideAreaAction({
			areas: nodeAreas,
			newNode: newNode,
			maxSize: group.getMaxSize(),
			connect: group.connect,
		});
		if ("covered" !== decision.action) {
			if ("enlarge" === decision.action) {
				autoAddNodeToArea(group, decision.areaIndex, newNode);
				nodeAreas[decision.areaIndex].push(newNode);
				enlarged = true;
			} else {
				areas.push({
					member: undefined,
					nodeKeys: new Set([pathNodeKey(tx, ty, baseZ)]),
					coords: [{ x: tx * 32, y: ty * 32 }],
				});
				nodeAreas.push([newNode]);
				queueAutoHire(group, newNode);
				hired = true;
			}
		}
	}
	if (enlarged) {
		applyAutoAreasToLive(group);
	}
	return hired;
};

const applyAutoAreasToLive = function applyAutoAreasToLive(group: AutoGroup): void {
	for (const area of autoAreas(group)) {
		if (area.member) {
			area.member.patrolArea.add(area.coords);
		}
	}
};

// The teleport height for a member of the given auto group at (tx, ty):
// surface height for gardening handymen (so they land on the grass to mow),
// or the footpath level that triggered the hire otherwise. NOT the lowest
// footpath on the tile: a bridge level hired over a ground path must be
// dropped onto the bridge, not the path beneath it.
const teleportZForGroup = function teleportZForGroup(group: AutoGroup, node: AreaNode): number {
	if ("handyman" === group.staffType && group.orders === HANDYMAN_ORDERS_GARDENING) {
		return surfaceBaseZAt(node.x, node.y);
	}
	return node.baseZ;
};

// The level this area patrols at (tx, ty) (its node's baseZ), if it owns a
// node there at all. Used to drop a hired member at the height of the network
// they were hired for when the trigger tile itself isn't placeable.
const areaLevelAt = function areaLevelAt(
	area: AutoArea,
	tx: number,
	ty: number,
): number | undefined {
	for (const key of area.nodeKeys) {
		const node = keyToNode(key);
		if (node.x === tx && node.y === ty) {
			return node.baseZ;
		}
	}
	return undefined;
};

const queueAutoHire = function queueAutoHire(group: AutoGroup, node: AreaNode): void {
	const tx = node.x;
	const ty = node.y;
	if (autoHireForPurpose.get(group.purpose)) {
		return;
	}
	autoHireForPurpose.set(group.purpose, true);
	hireStaff(
		{ staffTypeId: group.staffTypeId, orders: group.orders, countToHire: 1 },
		function onAutoHired() {
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
				const z = teleportZForGroup(group, node);
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
					const workTile = area.coords.find(function isNonQueueWorkTile(c) {
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
						area.coords.map(function toPathTileInfo(c): PathTileInfo {
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
						teleportZ =
							"handyman" === group.staffType && group.orders === HANDYMAN_ORDERS_GARDENING
								? surfaceBaseZAt(teleportX, teleportY)
								: (areaLevelAt(area, teleportX, teleportY) ??
									footpathBaseZAt(teleportX, teleportY));
					}
				}
				teleportStaffToTile(member, { x: teleportX, y: teleportY, z: teleportZ });
			}
			refreshHiredAndAssignedStaffCounts();
		},
	);
};

const getLastStaffOfType = function getLastStaffOfType(staffType: StaffType): Staff | undefined {
	const members = getStaffByType(staffType);
	if (0 < members.length) {
		return members[members.length - 1];
	}
	return undefined;
};

// The baseZ of the footpath on a tile, if any (used as a teleport height).
const footpathBaseZAt = function footpathBaseZAt(tx: number, ty: number): number {
	const tile = gameMap().getTile(tx, ty);
	for (const member of getFootpathBaseZFromTile(tile)) {
		return member;
	}
	return 0;
};

// Returns an array with the baseZ of the first footpath element on the tile.
const getFootpathBaseZFromTile = function getFootpathBaseZFromTile(tile: Tile): number[] {
	const result: number[] = [];
	for (let e = 0; e < tile.numElements; e++) {
		const element = tile.getElement(e);
		if ("footpath" === element.type) {
			result.push(element.baseZ);
		}
	}
	return result;
};

// Handles one freshly placed path/queue tile for the given staff type's patroling.
// `isQueue` boolean determines path vs queue handling; queue tiles are only handled by
// handymen (cleanup) and entertainers (if the Queue toggle is on).
const handlePathTileForType = function handlePathTileForType(
	staffType: StaffType,
	orders: number,
	tile: CoordsXY,
): void {
	const group = groupForPathTile(staffType, orders);
	handleTileForGroup(group, tile.x, tile.y);
	refreshHiredAndAssignedStaffCounts();
};

// Maps a staff type + orders to its persistent auto-mode group.
const groupForPathTile = function groupForPathTile(
	staffType: StaffType,
	orders: number,
): AutoGroup {
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
};

// Handles a freshly placed path/queue tile for all relevant staff types.
export const handlePlacedPathTile = function handlePlacedPathTile(
	tx: number,
	ty: number,
	isQueue: boolean,
): void {
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
};

// Handles a newly bought land tile: if it becomes a garden tile, apply the
// gardening-handyman enlarge-vs-hire rule.
export const handleBoughtLandTile = function handleBoughtLandTile(tx: number, ty: number): void {
	if (!handymenEnabledStore.get()) {
		return;
	}
	if (!isGardenTile(tx, ty)) {
		return;
	}
	handleTileForGroup(AUTO_GROUP_GARDENING, tx, ty);
	refreshHiredAndAssignedStaffCounts();
};

// If a ride exit sits on a tile adjacent to the given path tile and no mechanic is
// assigned there yet, hire+assign a mechanic covering (exit tile + this tile).
const handleMechanicForAdjacentExit = function handleMechanicForAdjacentExit(
	tx: number,
	ty: number,
): void {
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
};

// Whether a ride exit element sits on the given tile.
const isRideExitOnTile = function isRideExitOnTile(tx: number, ty: number): boolean {
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
};

// Hires one mechanic and assigns a patrol area covering the exit tile and the given
// path tile in front of it.
const hireAndAssignMechanicForExit = function hireAndAssignMechanicForExit(
	exitTile: CoordsXY,
	frontTile: CoordsXY,
): void {
	hireStaff(
		{ staffTypeId: STAFF_TYPE_ID_MECHANIC, orders: MECHANIC_ORDERS_DEFAULT, countToHire: 1 },
		function onMechanicHired() {
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
};

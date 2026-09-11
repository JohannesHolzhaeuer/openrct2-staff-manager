import { CARDINAL_NEIGHBOUR_OFFSETS, DIRECTION_OFFSETS, footpathsConnect } from "../src/scan";
import type { GameMap } from "../src/game";

export interface FakeSurface {
	baseHeight: number;
	baseZ?: number;
	waterHeight?: number;
	parkFences?: number;
	surfaceStyle?: number;
	// OpenRCT2's SurfaceElement masks land ownership into `ownership` bit 0.
	// The plugin checks `hasOwnership`, so the fake exposes both.
	ownership?: number;
	hasOwnership?: boolean;
}

export interface FakeFootpath {
	baseZ: number;
	baseHeight?: number;
	slopeDirection?: number | null;
	isQueue?: boolean;
	isGhost?: boolean;
}

export interface FakeTileSpec {
	surface?: FakeSurface;
	footpaths?: FakeFootpath[];
	// Extra element types on the tile (e.g. "small_scenery", "track"), used to
	// exercise the checks that reject obstructed tiles.
	others?: TileElementType[];
	// Small scenery placed on the tile (for waterable-scenery checks), with the
	// loaded object index and optional baseZ height.
	smallScenery?: { object: number; baseZ?: number }[];
	// Full custom tile elements (e.g. park-entrance elements carrying a
	// `sequence`), pushed verbatim rather than reduced to `{ type }`.
	customElements?: TileElement[];
}

// A fake loaded small scenery object plus its flags. Used instead of the bare
// "small_scenery" element array because the waterable check reads the object's
// flags (SMALL_SCENERY_FLAG_CAN_BE_WATERED), not just the element.
export interface FakeSmallSceneryObject {
	index: number;
	flags: number;
}

const toElements = function toElements(spec: FakeTileSpec): TileElement[] {
	const elements: TileElement[] = [];
	if (spec.surface) {
		elements.push({
			type: "surface",
			baseHeight: spec.surface.baseHeight,
			baseZ: spec.surface.baseZ ?? 0,
			waterHeight: spec.surface.waterHeight ?? 0,
			parkFences: spec.surface.parkFences ?? 0,
			surfaceStyle: spec.surface.surfaceStyle ?? 0,
			ownership: spec.surface.ownership ?? 0,
			hasOwnership: spec.surface.hasOwnership ?? 0 != 0,
		} as unknown as TileElement);
	}
	for (const footpath of spec.footpaths ?? []) {
		elements.push({
			type: "footpath",
			baseZ: footpath.baseZ,
			baseHeight: footpath.baseHeight ?? footpath.baseZ / 8,
			slopeDirection: footpath.slopeDirection ?? null,
			isQueue: footpath.isQueue ?? false,
			isGhost: footpath.isGhost ?? false,
		} as unknown as TileElement);
	}
	for (const scenery of spec.smallScenery ?? []) {
		elements.push({
			type: "small_scenery",
			object: scenery.object,
			baseZ: scenery.baseZ ?? 0,
		} as unknown as TileElement);
	}
	for (const type of spec.others ?? []) {
		elements.push({ type: type } as unknown as TileElement);
	}
	for (const element of spec.customElements ?? []) {
		elements.push(element);
	}
	return elements;
};

// Builds a GameMap backed by a plain "x,y" -> tile-spec dictionary, so the
// scanning helpers can be exercised without the OpenRCT2 globals. Tiles that
// were not specified come back empty.
export const fakeMap = function fakeMap(
	size: CoordsXY,
	tiles: { [key: string]: FakeTileSpec } = {},
	extras: { rides?: Ride[]; staff?: Staff[] } = {},
): GameMap {
	const rides = extras.rides ?? [];
	const staff = extras.staff ?? [];
	const footpathsAt = function footpathsAt(x: number, y: number): FakeFootpath[] {
		const spec = (tiles as { [key: string]: FakeTileSpec | undefined })[`${x},${y}`];
		return spec?.footpaths ?? [];
	};

	// Derives a minimal PathNavigator from the fake tile data so tests can
	// exercise pathGraph.ts against the same fixtures used for the rest of
	// the scanning tests, without needing a real OpenRCT2 map. A connection
	// is reported to a cardinal neighbour whenever any footpath on this tile
	// and any footpath on the neighbour meet at the same edge height,
	// matching the real engine's own connectivity rule.
	const getPathNavigator = function getPathNavigator(
		position: CoordsXYZ,
		options?: PathNavigationOptions,
	): PathNavigator | null {
		const x = Math.floor(position.x / 32);
		const y = Math.floor(position.y / 32);
		const here = footpathsAt(x, y).find(function isAtPositionZ(fp) {
			return fp.baseZ === position.z;
		});
		if (!here) {
			return null;
		}
		const hereBaseZ = here.baseZ;
		const hereSlopeDirection = here.slopeDirection ?? null;
		const connectedPaths = function connectedPaths(): PathConnection[] {
			const result: PathConnection[] = [];
			for (let d = 0; d < CARDINAL_NEIGHBOUR_OFFSETS.length; d++) {
				const offset = DIRECTION_OFFSETS[d];
				const nx = x + offset.x;
				const ny = y + offset.y;
				for (const neighbourFootpath of footpathsAt(nx, ny)) {
					if (
						(!neighbourFootpath.isQueue || options?.includeQueues) &&
						footpathsConnect(
							{ baseZ: hereBaseZ, slopeDirection: hereSlopeDirection },
							{
								baseZ: neighbourFootpath.baseZ,
								slopeDirection: neighbourFootpath.slopeDirection ?? null,
							},
							d,
						)
					) {
						result.push({
							position: { x: nx * 32, y: ny * 32, z: neighbourFootpath.baseZ },
							elementIndex: 0,
							direction: d,
							isSloped: null !== neighbourFootpath.slopeDirection,
							slopeDirection: neighbourFootpath.slopeDirection ?? null,
							isQueue: neighbourFootpath.isQueue ?? false,
							isWide: false,
							ride: null,
							station: null,
						} as PathConnection);
					}
				}
			}
			return result;
		};
		return {
			current: {
				position: { x: x * 32, y: y * 32, z: here.baseZ },
				elementIndex: 0,
				direction: null,
				isSloped: null !== here.slopeDirection,
				slopeDirection: here.slopeDirection ?? null,
				isQueue: here.isQueue ?? false,
				isWide: false,
				ride: null,
				station: null,
			} as PathConnection,
			edges: 0,
			permittedEdges: 0,
			getConnectedPaths(): PathConnection[] {
				return connectedPaths();
			},
			moveTo(): boolean {
				return false;
			},
		};
	};

	return {
		size: size,
		rides: rides,
		getAllEntities(): Staff[] {
			return staff;
		},
		getTile(x: number, y: number): Tile {
			const elements = toElements(tiles[`${x},${y}`] ?? {});
			return {
				x: x,
				y: y,
				numElements: elements.length,
				getElement(index: number): TileElement {
					return elements[index];
				},
			} as unknown as Tile;
		},
		getPathNavigator: getPathNavigator,
	};
};

// A minimal staff entity for getAllEntities("staff") based lookups. `orders`
// only matters for handymen, where it decides cleanup vs gardening.
export const fakeStaff = function fakeStaff(id: number, staffType: StaffType, orders = 0): Staff {
	return {
		id: id,
		staffType: staffType,
		orders: orders,
		x: 0,
		y: 0,
		z: 0,
		patrolArea: makeFakePatrolArea(),
	} as unknown as Staff;
};

const makeFakePatrolArea = function makeFakePatrolArea(
	initialTiles: { x: number; y: number }[] = [],
): { tiles: CoordsXY[]; add: (tiles: CoordsXY[]) => void; clear: () => void } {
	const tiles: CoordsXY[] = [...initialTiles];
	return {
		tiles: tiles,
		add(newTiles: CoordsXY[]): void {
			for (const t of newTiles) {
				tiles.push(t);
			}
		},
		clear(): void {
			tiles.length = 0;
		},
	};
};

// A minimal staff entity with a populated patrol area.
export const fakeStaffWithPatrol = function fakeStaffWithPatrol(
	id: number,
	staffType: StaffType,
	orders = 0,
	initialTiles: { x: number; y: number }[] = [],
): Staff {
	return {
		...fakeStaff(id, staffType, orders),
		patrolArea: makeFakePatrolArea(initialTiles),
	} as unknown as Staff;
};

// A minimal ride with the given stations (only classification and station
// entrance/exit tiles are read).
export const fakeRide = function fakeRide(
	classification: "ride" | "shop",
	stations: { entrance?: CoordsXYZD; exit?: CoordsXYZD | null }[] = [],
): Ride {
	return {
		classification: classification,
		stations: stations.map(
			(s) =>
				({
					entrance: s.entrance,
					exit: s.exit,
				}) as unknown as RideStation,
		),
	} as unknown as Ride;
};

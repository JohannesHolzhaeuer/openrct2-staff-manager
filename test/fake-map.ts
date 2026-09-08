import type { GameMap } from "../src/game";
import { CARDINAL_NEIGHBOUR_OFFSETS, DIRECTION_OFFSETS, footpathsConnect } from "../src/scan";

export interface FakeSurface {
    baseHeight: number;
    waterHeight?: number;
    parkFences?: number;
    surfaceStyle?: number;
    ownership?: number;
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
}

function toElements(spec: FakeTileSpec): TileElement[] {    const elements: TileElement[] = [];
    if (spec.surface) {
        elements.push({
            type: "surface",
            baseHeight: spec.surface.baseHeight,
            waterHeight: spec.surface.waterHeight ?? 0,
            parkFences: spec.surface.parkFences ?? 0,
            surfaceStyle: spec.surface.surfaceStyle ?? 0,
            ownership: spec.surface.ownership ?? 0
        } as unknown as TileElement);
    }
    for (const footpath of spec.footpaths ?? []) {
        elements.push({
            type: "footpath",
            baseZ: footpath.baseZ,
            baseHeight: footpath.baseHeight ?? footpath.baseZ / 8,
            slopeDirection: footpath.slopeDirection ?? null,
            isQueue: footpath.isQueue ?? false,
            isGhost: footpath.isGhost ?? false
        } as unknown as TileElement);
    }
    for (const type of spec.others ?? []) {
        elements.push({ type: type } as unknown as TileElement);
    }
    return elements;
}

// Builds a GameMap backed by a plain "x,y" -> tile-spec dictionary, so the
// scanning helpers can be exercised without the OpenRCT2 globals. Tiles that
// were not specified come back empty.
export function fakeMap(size: CoordsXY, tiles: Record<string, FakeTileSpec> = {}, rides: Ride[] = [], staff: Staff[] = []): GameMap {
    function footpathsAt(x: number, y: number): FakeFootpath[] {
        const spec = (tiles as Record<string, FakeTileSpec | undefined>)[String(x) + "," + String(y)];
        return spec?.footpaths ?? [];
    }

    // Derives a minimal PathNavigator from the fake tile data so tests can
    // exercise pathGraph.ts against the same fixtures used for the rest of
    // the scanning tests, without needing a real OpenRCT2 map. A connection
    // is reported to a cardinal neighbour whenever any footpath on this tile
    // and any footpath on the neighbour meet at the same edge height,
    // matching the real engine's own connectivity rule.
    function getPathNavigator(position: CoordsXYZ, options?: PathNavigationOptions): PathNavigator | null {
        const x = Math.floor(position.x / 32);
        const y = Math.floor(position.y / 32);
        const here = footpathsAt(x, y).find(function (fp) { return fp.baseZ === position.z; });
        if (!here) {
            return null;
        }
        const hereBaseZ = here.baseZ;
        const hereSlopeDirection = here.slopeDirection ?? null;
        function connectedPaths(): PathConnection[] {
            const result: PathConnection[] = [];
            for (let d = 0; d < CARDINAL_NEIGHBOUR_OFFSETS.length; d++) {
                const offset = DIRECTION_OFFSETS[d];
                const nx = x + offset.x;
                const ny = y + offset.y;
                for (const neighbourFootpath of footpathsAt(nx, ny)) {
                    if (neighbourFootpath.isQueue && !(options?.includeQueues)) {
                        continue;
                    }
                    if (footpathsConnect(
                        { baseZ: hereBaseZ, slopeDirection: hereSlopeDirection },
                        { baseZ: neighbourFootpath.baseZ, slopeDirection: neighbourFootpath.slopeDirection ?? null },
                        d
                    )) {
                        result.push({
                            position: { x: nx * 32, y: ny * 32, z: neighbourFootpath.baseZ },
                            elementIndex: 0,
                            direction: d,
                            isSloped: neighbourFootpath.slopeDirection != null,
                            slopeDirection: neighbourFootpath.slopeDirection ?? null,
                            isQueue: neighbourFootpath.isQueue ?? false,
                            isWide: false,
                            ride: null,
                            station: null
                        } as PathConnection);
                    }
                }
            }
            return result;
        }
        return {
            current: {
                position: { x: x * 32, y: y * 32, z: here.baseZ },
                elementIndex: 0,
                direction: null,
                isSloped: here.slopeDirection != null,
                slopeDirection: here.slopeDirection ?? null,
                isQueue: here.isQueue ?? false,
                isWide: false,
                ride: null,
                station: null
            } as PathConnection,
            edges: 0,
            permittedEdges: 0,
            getConnectedPaths(): PathConnection[] {
                return connectedPaths();
            },
            moveTo(): boolean {
                return false;
            }
        };
    }

    return {
        size: size,
        rides: rides,
        getAllEntities(): Staff[] {
            return staff;
        },
        getTile(x: number, y: number): Tile {
            const elements = toElements(tiles[String(x) + "," + String(y)] ?? {});
            return {
                x: x,
                y: y,
                numElements: elements.length,
                getElement(index: number): TileElement {
                    return elements[index];
                }
            } as unknown as Tile;
        },
        getPathNavigator: getPathNavigator
    };
}

// A minimal staff entity for getAllEntities("staff") based lookups. `orders`
// only matters for handymen, where it decides cleanup vs gardening.
export function fakeStaff(id: number, staffType: StaffType, orders = 0): Staff {
    return { id: id, staffType: staffType, orders: orders } as unknown as Staff;
}

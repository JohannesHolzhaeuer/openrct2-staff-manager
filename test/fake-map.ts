/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import type { GameMap } from "../src/game";

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/consistent-type-assertions */

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
}

function toElements(spec: FakeTileSpec): TileElement[] {
    const elements: TileElement[] = [];
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
    return elements;
}

// Builds a GameMap backed by a plain "x,y" -> tile-spec dictionary, so the
// scanning helpers can be exercised without the OpenRCT2 globals. Tiles that
// were not specified come back empty.
export function fakeMap(size: CoordsXY, tiles: Record<string, FakeTileSpec> = {}, rides: Ride[] = []): GameMap {
    return {
        size: size,
        rides: rides,
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
        }
    };
}

/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />

// The (very small) part of the OpenRCT2 `map` global that the scanning code
// actually needs. Going through this interface instead of the global keeps the
// tile-walking logic runnable outside the game, so it can be unit tested
// against a fake map.
export interface GameMap {
    readonly size: CoordsXY;
    readonly rides: Ride[];
    getTile(x: number, y: number): Tile;
}

// Delegates to the real global. Kept lazy: the global does not exist while the
// module is being evaluated in a test process.
const realGameMap: GameMap = {
    get size(): CoordsXY {
        return map.size;
    },
    get rides(): Ride[] {
        return map.rides;
    },
    getTile(x: number, y: number): Tile {
        return map.getTile(x, y);
    }
};

let current: GameMap = realGameMap;

export function gameMap(): GameMap {
    return current;
}

// Test seam only. Production code must never call this.
export function setGameMap(replacement: GameMap): void {
    current = replacement;
}

export function resetGameMap(): void {
    current = realGameMap;
}

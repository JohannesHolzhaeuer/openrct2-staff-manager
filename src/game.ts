/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />

// The (very small) part of the OpenRCT2 `map` global that the scanning code
// actually needs. Going through this interface instead of the global keeps the
// tile-walking logic runnable outside the game, so it can be unit tested
// against a fake map.
export interface GameMap {
    readonly size: CoordsXY;
    readonly rides: Ride[];
    getTile(x: number, y: number): Tile;
    getAllEntities(type: "staff"): Staff[];
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
    },
    getAllEntities(type: "staff"): Staff[] {
        return map.getAllEntities(type);
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

// --- Game context -------------------------------------------------------------
// The part of the OpenRCT2 `context` global the plugin uses: tick scheduling,
// game actions, event subscriptions and persisted settings. Routing these
// through an interface lets the batching and hire/fire flows run under test.
export interface GameContext {
    setTimeout(callback: () => void, delay: number): number;
    clearTimeout(handle: number): void;
    executeAction(action: string, args: object, callback: (result: GameActionResult) => void): void;
    subscribe(hook: "action.execute", callback: (event: GameActionEventArgs) => void): IDisposable;
    getSetting<T>(key: string, fallback: T): T;
    setSetting(key: string, value: unknown): void;
}

// Delegates to the real global. Every member is a method (not a captured
// reference) so the global is only touched when actually called, which keeps
// the module importable in a test process where no global exists.
const realGameContext: GameContext = {
    setTimeout(callback: () => void, delay: number): number {
        return context.setTimeout(callback, delay);
    },
    clearTimeout(handle: number): void {
        context.clearTimeout(handle);
    },
    executeAction(action: string, args: object, callback: (result: GameActionResult) => void): void {
        context.executeAction(action, args, callback);
    },
    subscribe(hook: "action.execute", callback: (event: GameActionEventArgs) => void): IDisposable {
        return context.subscribe(hook, callback);
    },
    getSetting<T>(key: string, fallback: T): T {
        return context.sharedStorage.get(key, fallback);
    },
    setSetting(key: string, value: unknown): void {
        context.sharedStorage.set(key, value);
    }
};

let currentContext: GameContext = realGameContext;

export function gameContext(): GameContext {
    return currentContext;
}

// Test seam only. Production code must never call this.
export function setGameContext(replacement: GameContext): void {
    currentContext = replacement;
}

export function resetGameContext(): void {
    currentContext = realGameContext;
}

// --- Object manager -----------------------------------------------------------
// Only the loaded-object lookup used to pick staff costumes.
export interface GameObjects {
    getAllObjects(type: "peep_animations"): LoadedObject[];
}

const realGameObjects: GameObjects = {
    getAllObjects(type: "peep_animations"): LoadedObject[] {
        return objectManager.getAllObjects(type);
    }
};

let currentObjects: GameObjects = realGameObjects;

export function gameObjects(): GameObjects {
    return currentObjects;
}

// Test seam only. Production code must never call this.
export function setGameObjects(replacement: GameObjects): void {
    currentObjects = replacement;
}

export function resetGameObjects(): void {
    currentObjects = realGameObjects;
}

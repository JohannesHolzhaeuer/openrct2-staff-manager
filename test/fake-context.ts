/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import type { GameContext, GameObjects } from "../src/game";

export interface RecordedAction {
    action: string;
    args: Record<string, unknown>;
}

// A GameContext that never actually schedules anything: timers are collected
// so a test can decide exactly when (and whether) each deferred step runs.
// This is what makes the tick-batching logic assertable - the production code
// hands work to setTimeout, and the test drives the clock by hand.
export class FakeContext implements GameContext {
    readonly actions: RecordedAction[] = [];
    readonly settings = new Map<string, unknown>();
    subscriptions = 0;
    disposals = 0;

    // Pending timer callbacks keyed by handle, in scheduling order.
    private timers = new Map<number, () => void>();
    private nextHandle = 1;
    // Result handed to every executeAction callback; override to simulate a
    // failing game action.
    actionResult: GameActionResult = {};

    // Delays passed to setTimeout, in order. Asserted by tests that care the
    // batching never schedules with a delay of 0.
    readonly delays: number[] = [];

    setTimeout(callback: () => void, delay: number): number {
        this.delays.push(delay);
        const handle = this.nextHandle++;
        this.timers.set(handle, callback);
        return handle;
    }

    clearTimeout(handle: number): void {
        this.timers.delete(handle);
    }

    executeAction(action: string, args: object, callback: (result: GameActionResult) => void): void {
        this.actions.push({ action: action, args: args as Record<string, unknown> });
        // Single-player executes actions synchronously, so mirror that here.
        callback(this.actionResult);
    }

    subscribe(): IDisposable {
        this.subscriptions++;
        return {
            dispose: (): void => {
                this.disposals++;
            }
        };
    }

    getSetting<T>(key: string, fallback: T): T {
        return this.settings.has(key) ? this.settings.get(key) as T : fallback;
    }

    setSetting(key: string, value: unknown): void {
        this.settings.set(key, value);
    }

    get pendingTimers(): number {
        return this.timers.size;
    }

    // Runs every currently pending timer once. Callbacks that schedule further
    // work are NOT run in the same pass, so each call represents one tick.
    runPendingTimers(): void {
        const due = Array.from(this.timers.entries());
        this.timers.clear();
        for (const [, callback] of due) {
            callback();
        }
    }

    // Drains the timer queue, tick by tick, until no work remains. Guarded so a
    // runaway reschedule fails the test instead of hanging it.
    runAllTimers(maxTicks = 1000): number {
        let ticks = 0;
        while (this.timers.size > 0) {
            if (++ticks > maxTicks) {
                throw new Error("timer queue did not drain within " + String(maxTicks) + " ticks");
            }
            this.runPendingTimers();
        }
        return ticks;
    }

    actionsOfType(action: string): RecordedAction[] {
        return this.actions.filter(a => a.action === action);
    }
}

// Costume objects for hire tests. Only `index` and `identifier` are read.
export function fakeObjects(identifiers: string[]): GameObjects {
    return {
        getAllObjects(): LoadedObject[] {
            return identifiers.map((identifier, index) => {
                return { index: index, identifier: identifier } as unknown as LoadedObject;
            });
        }
    };
}

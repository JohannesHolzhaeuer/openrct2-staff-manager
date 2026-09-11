import type { GameContext, GameObjects } from "../src/game";

export interface RecordedAction {
	action: string;
	args: { [key: string]: unknown };
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
	// The most recently subscribed action.execute callback, so tests can
	// simulate a game action firing without a real event bus.
	actionExecuteCallback: ((event: GameActionEventArgs) => void) | undefined = undefined;

	// Pending timer callbacks keyed by handle, in scheduling order.
	private timers = new Map<number, () => void>();
	private nextHandle = 1;
	// Result handed to every executeAction callback; override to simulate a
	// failing game action.
	actionResult: GameActionResult = {};

	// Optional hook invoked whenever a "staffhire" action is executed, so tests
	// can simulate the OpenRCT2 roster actually growing after the action
	// succeeds (otherwise the code paths that look up the freshly hired member
	// - e.g. queueAutoHire's teleport - can never find one). Receives the
	// action's args and returns the id of the newly hired staff member.
	onStaffHire: ((args: { [key: string]: unknown }) => number) | undefined = undefined;

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
		this.actions.push({ action: action, args: args as { [key: string]: unknown } });
		// Single-player executes actions synchronously, so mirror that here.
		if ("staffhire" === action && this.onStaffHire) {
			this.onStaffHire(args as { [key: string]: unknown });
		}
		callback(this.actionResult);
	}

	subscribe(_hook: "action.execute", callback: (event: GameActionEventArgs) => void): IDisposable {
		this.subscriptions++;
		this.actionExecuteCallback = callback;
		return {
			dispose: (): void => {
				this.disposals++;
			},
		};
	}

	getSetting<T>(key: string, fallback: T): T {
		if (this.settings.has(key)) {
			return this.settings.get(key) as T;
		}
		return fallback;
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
		const due = [...this.timers.entries()];
		this.timers.clear();
		for (const [, callback] of due) {
			callback();
		}
	}

	// Drains the timer queue, tick by tick, until no work remains. Guarded so a
	// runaway reschedule fails the test instead of hanging it.
	runAllTimers(maxTicks = 1000): number {
		let ticks = 0;
		while (0 < this.timers.size) {
			if (++ticks > maxTicks) {
				throw new Error(`timer queue did not drain within ${maxTicks} ticks`);
			}
			this.runPendingTimers();
		}
		return ticks;
	}

	actionsOfType(action: string): RecordedAction[] {
		return this.actions.filter((a) => a.action === action);
	}
}

// Loaded-object fixtures for the replaceable object manager. `getAllObjects`
// returns every identifier (in order), and `getObject` looks up individual
// small scenery by index. The optional `flags` map lets tests mark specific
// small-scenery objects as "can be watered" (SMALL_SCENERY_FLAG_CAN_BE_WATERED).
export const fakeObjects = function fakeObjects(
	identifiers: string[],
	options: { smallSceneryFlags?: { [index: number]: number } } = {},
): GameObjects {
	const smallSceneryFlags = options.smallSceneryFlags ?? {};
	return {
		getAllObjects(_type: "peep_animations" | "terrain_surface"): LoadedObject[] {
			return identifiers.map(
				(identifier, index) => ({ index, identifier }) as unknown as LoadedObject,
			);
		},
		getObject(_type: "small_scenery", index: number): SmallSceneryObject {
			return {
				index: index,
				identifier: `small_scenery_${index}`,
				flags: smallSceneryFlags[index] ?? 0,
			} as unknown as SmallSceneryObject;
		},
	};
};

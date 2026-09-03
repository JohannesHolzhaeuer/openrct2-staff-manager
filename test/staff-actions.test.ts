import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { setGameMap, resetGameMap, setGameContext, resetGameContext, setGameObjects, resetGameObjects } from "../src/game";
import { fakeMap, fakeStaff } from "./fake-map";
import { FakeContext, fakeObjects } from "./fake-context";
import { hireStaff, teleportStaffToTile, STAFF_TYPE_ID_HANDYMAN, STAFF_TYPE_ID_ENTERTAINER, HANDYMAN_ORDERS_CLEANUP } from "../src/staff";

let ctx: FakeContext;

beforeEach(() => {
    ctx = new FakeContext();
    setGameContext(ctx);
    setGameMap(fakeMap({ x: 16, y: 16 }));
    // A loaded entertainer costume, so entertainer hires are possible by default.
    setGameObjects(fakeObjects(["rct2.peep_animations.handyman", "rct2.peep_animations.panda"]));
});

afterEach(() => {
    resetGameContext();
    resetGameMap();
    resetGameObjects();
});

describe("hireStaff", () => {
    it("issues one staffhire action per requested staff member", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, HANDYMAN_ORDERS_CLEANUP, 3, () => { /* noop */ });
        ctx.runAllTimers();
        expect(ctx.actionsOfType("staffhire")).toHaveLength(3);
    });

    it("passes the staff type and orders through to the game action", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, HANDYMAN_ORDERS_CLEANUP, 1, () => { /* noop */ });
        ctx.runAllTimers();
        const args = ctx.actionsOfType("staffhire")[0].args;
        expect(args.staffType).toBe(STAFF_TYPE_ID_HANDYMAN);
        expect(args.staffOrders).toBe(HANDYMAN_ORDERS_CLEANUP);
        expect(args.autoPosition).toBe(true);
    });

    it("invokes the completion callback once per hire", () => {
        let completed = 0;
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 5, () => { completed++; });
        ctx.runAllTimers();
        expect(completed).toBe(5);
    });

    it("hires nothing when zero are requested", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 0, () => { /* noop */ });
        ctx.runAllTimers();
        expect(ctx.actions).toHaveLength(0);
    });

    it("picks a valid entertainer costume rather than the handyman default", () => {
        hireStaff(STAFF_TYPE_ID_ENTERTAINER, 0, 1, () => { /* noop */ });
        ctx.runAllTimers();
        // Index 1 is the only entertainer ("panda") costume; index 0 is the
        // handyman costume, which the game rejects for entertainers.
        expect(ctx.actionsOfType("staffhire")[0].args.costumeIndex).toBe(1);
    });

    it("skips the hire but still reports completion when no entertainer costume is loaded", () => {
        setGameObjects(fakeObjects(["rct2.peep_animations.handyman"]));
        let completed = 0;
        hireStaff(STAFF_TYPE_ID_ENTERTAINER, 0, 2, () => { completed++; });
        ctx.runAllTimers();
        // No action is issued, but the counter must stay balanced or the UI
        // would never re-enable.
        expect(ctx.actionsOfType("staffhire")).toHaveLength(0);
        expect(completed).toBe(2);
    });
});

describe("hire batching across ticks", () => {
    it("dispatches at most TASKS_PER_TICK actions before yielding to the game loop", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 10, () => { /* noop */ });
        // The first chunk runs synchronously; the rest must be deferred.
        expect(ctx.actionsOfType("staffhire")).toHaveLength(4);
        expect(ctx.pendingTimers).toBe(1);
    });

    it("spreads the remaining hires over subsequent ticks", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 10, () => { /* noop */ });
        ctx.runPendingTimers();
        expect(ctx.actionsOfType("staffhire")).toHaveLength(8);
        ctx.runPendingTimers();
        expect(ctx.actionsOfType("staffhire")).toHaveLength(10);
        // Everything is done, so nothing further should be scheduled.
        expect(ctx.pendingTimers).toBe(0);
    });

    it("never schedules a follow-up tick when the work fits in one chunk", () => {
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 4, () => { /* noop */ });
        expect(ctx.actionsOfType("staffhire")).toHaveLength(4);
        expect(ctx.pendingTimers).toBe(0);
    });

    it("uses a non-zero delay so the engine can render between chunks", () => {
        // A delay of 0 would be re-entered within the same tick, defeating the
        // batching entirely (see BATCH_TICK_DELAY).
        hireStaff(STAFF_TYPE_ID_HANDYMAN, 0, 8, () => { /* noop */ });
        expect(ctx.delays.length).toBeGreaterThan(0);
        expect(ctx.delays.every(d => d > 0)).toBe(true);
    });
});

describe("teleportStaffToTile", () => {
    it("picks the staff member up and puts them down on the target tile", () => {
        teleportStaffToTile(fakeStaff(7, "handyman"), 3, 4, 32);
        ctx.runAllTimers();
        const pickups = ctx.actionsOfType("peeppickup");
        expect(pickups).toHaveLength(2);
        // type 0 = pick up, type 2 = place.
        expect(pickups[0].args.type).toBe(0);
        expect(pickups[1].args.type).toBe(2);
        // The tile coordinates are converted to world coordinates centred on
        // the tile (tile * 32 + 16), which is where the peep is placed.
        expect([pickups[1].args.x, pickups[1].args.y, pickups[1].args.z]).toEqual([3 * 32 + 16, 4 * 32 + 16, 32]);
    });

    it("does not attempt to place the staff member when the pickup fails", () => {
        ctx.actionResult = { error: 1 };
        teleportStaffToTile(fakeStaff(7, "handyman"), 3, 4, 32);
        ctx.runAllTimers();
        expect(ctx.actionsOfType("peeppickup")).toHaveLength(1);
    });
});

/// <reference path="../node_modules/@openrct2/types/openrct2.d.ts" />
import {
	store as flexStore, compute, Store
} from "openrct2-flexui";
import {
	DEFAULT_HANDYMEN_TILES_PER_STAFF,
	DEFAULT_HANDYMEN_MOWER_TILES_PER_STAFF,
	DEFAULT_GUARDS_TILES_PER_STAFF,
	DEFAULT_ENTERTAINERS_TILES_PER_STAFF,
	DEFAULT_ENTERTAINERS_PER_AREA,
	DEFAULT_ENTERTAINERS_INCLUDE_QUEUE,
	DEFAULT_HANDYMEN_ENABLED,
	DEFAULT_GUARDS_ENABLED,
	DEFAULT_ENTERTAINERS_ENABLED,
	DEFAULT_MECHANICS_ENABLED
} from "./config";

// --- Raw scan-result stores -------------------------------------------------
// Raw tile/entity counts produced by the scan functions. Needed staff counts
// are derived from these via `compute`, so they automatically recompute
// whenever a scan re-runs or a "tiles per staff"-style spinner changes.
export const pathTilesCountStore = flexStore<number>(0);
export const queueTilesCountStore = flexStore<number>(0);
export const gardenTilesCountStore = flexStore<number>(0);
// Tile counts of each disconnected gardening area (connected component), so
// the needed-gardener count can guarantee at least one gardener per
// component instead of just dividing the grand total by tiles-per-staff
// (which could round down to fewer gardeners than there are components,
// leaving some areas with none).
export const gardenAreaSizesStore = flexStore<number[]>([]);
export const rideExitCountStore = flexStore<number>(0);

// --- User settings stores ---------------------------------------------------
export const handymenTilesPerStaffStore = flexStore<number>(DEFAULT_HANDYMEN_TILES_PER_STAFF);
export const handymenMowerTilesPerStaffStore = flexStore<number>(DEFAULT_HANDYMEN_MOWER_TILES_PER_STAFF);
export const guardsTilesPerStaffStore = flexStore<number>(DEFAULT_GUARDS_TILES_PER_STAFF);
export const entertainersTilesPerStaffStore = flexStore<number>(DEFAULT_ENTERTAINERS_TILES_PER_STAFF);
export const entertainersPerAreaStore = flexStore<number>(DEFAULT_ENTERTAINERS_PER_AREA);
export const entertainersIncludeQueueStore = flexStore<boolean>(DEFAULT_ENTERTAINERS_INCLUDE_QUEUE);

// Whether each staff type is enabled. When a staff type is disabled, it is
// treated as needing 0 staff (so "Adjust staff count" fires everyone of that
// type) and "Assign" skips it entirely. Its spinners/toggles/labels are also
// disabled in the UI.
export const handymenEnabledStore = flexStore<boolean>(DEFAULT_HANDYMEN_ENABLED);
export const guardsEnabledStore = flexStore<boolean>(DEFAULT_GUARDS_ENABLED);
export const entertainersEnabledStore = flexStore<boolean>(DEFAULT_ENTERTAINERS_ENABLED);
export const mechanicsEnabledStore = flexStore<boolean>(DEFAULT_MECHANICS_ENABLED);

// --- Hired / assigned stores -------------------------------------------------
export const handymenHiredStore = flexStore<number>(0);
export const handymenAssignedStore = flexStore<number>(0);
export const guardsHiredStore = flexStore<number>(0);
export const guardsAssignedStore = flexStore<number>(0);
export const entertainersHiredStore = flexStore<number>(0);
export const entertainersAssignedStore = flexStore<number>(0);
export const mechanicsHiredStore = flexStore<number>(0);
export const mechanicsAssignedStore = flexStore<number>(0);

// --- UI state stores ---------------------------------------------------------
// Whether the tile counts have been calculated yet. Until this is true, all
// spinners and stat text within the staff group boxes are disabled.
export const tilesCalculatedStore = flexStore<boolean>(false);
export const staffControlsDisabledStore = compute(tilesCalculatedStore, function (calculated) { return !calculated; });

// Text shown at the top of the window describing where the park entrance was
// found. Not translated via t() here: this initial value only exists for the
// brief moment before openWindow() triggers a scan and overwrites it (t()
// must not be called at module-load time - see src/i18n/index.ts for why).
export const parkEntranceInfoStore = flexStore<string>("Path tiles: 0, Queue tiles: 0, Garden tiles: 0");

// Text shown in the status row during "Adjust and assign". Updated as each
// staff type's processing step runs, so the player can see which step is
// being done. Empty when idle.
export const statusTextStore = flexStore<string>("");

// Per-staff-type "disabled" stores for the spinners/toggles/labels within
// each staff group box: disabled whenever the general controls are disabled
// (tiles not yet calculated) OR the staff type's own "Enabled" toggle is off.
function controlsDisabledFor(enabled: Store<boolean>): Store<boolean> {
	return compute(staffControlsDisabledStore, enabled, function (controlsDisabled: boolean, isEnabled: boolean) {
		return controlsDisabled || !isEnabled;
	});
}
export const handymenControlsDisabledStore = controlsDisabledFor(handymenEnabledStore);
export const guardsControlsDisabledStore = controlsDisabledFor(guardsEnabledStore);
export const entertainersControlsDisabledStore = controlsDisabledFor(entertainersEnabledStore);
export const mechanicsControlsDisabledStore = controlsDisabledFor(mechanicsEnabledStore);

// --- Needed staff computations ------------------------------------------------
export function computeNeeded(totalTiles: number, tilesPerStaff: number): number {
	if (tilesPerStaff <= 0 || totalTiles <= 0) {
		return 0;
	}
	return Math.ceil(totalTiles / tilesPerStaff);
}

// Handymen are needed both to clean up the path/queue network (Cleanup) and
// to mow/water the park's garden tiles (Gardening). These are tracked as
// separate needed counts (used when hiring/firing specialised handymen) and
// summed for the single "Needed" row shown in the UI.
export const handymenCleanupNeededStore = compute(pathTilesCountStore, queueTilesCountStore, handymenTilesPerStaffStore, handymenEnabledStore,
	function (path: number, queue: number, tilesPerStaff: number, enabled: boolean) {
		return enabled ? computeNeeded(path + queue, tilesPerStaff) : 0;
	});
export const handymenGardeningNeededStore = compute(gardenAreaSizesStore, handymenMowerTilesPerStaffStore, handymenEnabledStore,
	function (areaSizes: number[], mowerTilesPerStaff: number, enabled: boolean) {
		if (!enabled) {
			return 0;
		}
		// Sum of each area's own needed count, so every disconnected area
		// gets at least one gardener (as long as it has any tiles), rather
		// than allocating gardeners against the grand total tile count.
		return areaSizes.reduce(function (sum, size) { return sum + computeNeeded(size, mowerTilesPerStaff); }, 0);
	});
export const handymenNeededStore = compute(handymenCleanupNeededStore, handymenGardeningNeededStore,
	function (cleanup: number, gardening: number) { return cleanup + gardening; });

// Guards only patrol plain pathway tiles, not queue tiles.
export const guardsNeededStore = compute(pathTilesCountStore, guardsTilesPerStaffStore, guardsEnabledStore,
	function (path: number, tilesPerStaff: number, enabled: boolean) {
		return enabled ? computeNeeded(path, tilesPerStaff) : 0;
	});

// Entertainers patrol path tiles (and queue tiles, if the "Queue" toggle is
// on), but multiple entertainers can be assigned to each patrol area.
const entertainersNeededBaseStore = compute(
	pathTilesCountStore, queueTilesCountStore, entertainersIncludeQueueStore, entertainersTilesPerStaffStore, entertainersPerAreaStore,
	function (path: number, queue: number, includeQueue: boolean, tilesPerStaff: number, perArea: number) {
		const tiles = path + (includeQueue ? queue : 0);
		return computeNeeded(tiles, tilesPerStaff) * Math.max(perArea, 0);
	});
export const entertainersNeededStore = compute(entertainersNeededBaseStore, entertainersEnabledStore,
	function (needed: number, enabled: boolean) { return enabled ? needed : 0; });

// One mechanic is needed per ride exit in the park.
export const mechanicsNeededStore = compute(rideExitCountStore, mechanicsEnabledStore,
	function (rideExits: number, enabled: boolean) { return enabled ? rideExits : 0; });

// Whether every staff type's Needed count matches its Hired count, i.e.
// there is nothing left to adjust. `compute` only supports up to 5 stores at
// once, so the staff types are combined in two steps.
const noHandymenOrGuardsDifferenceStore = compute(
	handymenNeededStore, handymenHiredStore, guardsNeededStore, guardsHiredStore,
	function (handymenNeeded: number, handymenHired: number, guardsNeeded: number, guardsHired: number) {
		return handymenNeeded === handymenHired && guardsNeeded === guardsHired;
	});
const noStaffDifferenceStore = compute(
	noHandymenOrGuardsDifferenceStore, entertainersNeededStore, entertainersHiredStore, mechanicsNeededStore, mechanicsHiredStore,
	function (noHandymenOrGuardsDifference: boolean, entertainersNeeded: number, entertainersHired: number,
		mechanicsNeeded: number, mechanicsHired: number) {
		return noHandymenOrGuardsDifference && entertainersNeeded === entertainersHired && mechanicsNeeded === mechanicsHired;
	});
export const adjustButtonDisabledStore = compute(
	staffControlsDisabledStore, noStaffDifferenceStore,
	function (controlsDisabled: boolean, noStaffDifference: boolean) {
		return controlsDisabled || noStaffDifference;
	});

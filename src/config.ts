// Default configuration values for the Staff Manager plugin.
// These are the initial values assigned to the reactive stores in store.ts,
// and can be overridden by the user via the plugin's UI.

// Tiles per staff member for each staff type.
export const DEFAULT_HANDYMEN_TILES_PER_STAFF = 8;
export const DEFAULT_HANDYMEN_MOWER_TILES_PER_STAFF = 256;
export const DEFAULT_GUARDS_TILES_PER_STAFF = 16;
export const DEFAULT_ENTERTAINERS_TILES_PER_STAFF = 16;
export const DEFAULT_ENTERTAINERS_PER_AREA = 2;
export const DEFAULT_ENTERTAINERS_INCLUDE_QUEUE = true;

// Whether each staff type is managed by default.
export const DEFAULT_HANDYMEN_ENABLED = true;
export const DEFAULT_GUARDS_ENABLED = true;
export const DEFAULT_ENTERTAINERS_ENABLED = true;
export const DEFAULT_MECHANICS_ENABLED = true;

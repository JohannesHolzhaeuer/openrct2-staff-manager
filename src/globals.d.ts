// Build-time-injected plugin version (see bundle.ts and vitest.config.ts).
//
// esbuild's `define` rewrites every reference to STAFF_MANAGER_VERSION with the
// `version` from package.json when bundling, and vitest applies the same define.
// Keeping the value out of src/main.ts means the compiled plugin always reports
// the same version as the npm package instead of a hardcoded string that drifts
// across releases.
declare const STAFF_MANAGER_VERSION: string;

# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project overview

This is an [OpenRCT2](https://openrct2.io/) plugin called **Staff Manager**. It automates park
staff management (handymen, security guards, entertainers, mechanics) by splitting the park's
paths and queues into patrol areas and assigning staff accordingly. Handymen are split between
**cleanup** (paths + queues) and **gardening** (mow/water); mechanics patrol ride exits.

Patrol/gardening area construction is height‑ and water‑aware: tiles are only linked into the
same area when actually walkable between each other (matching footpath/slope heights, no
unclimbable terrain steps, never across water), so every assigned patrol area is guaranteed to be
one contiguous, fully reachable region rather than accidentally including unreachable tiles at a
different height. Entertainers have dedicated controls (Tiles/Staff, Staff/Area, and a Queue
checkbox) instead of the generic density spinner used by handymen/guards.

- Plugin project: all runtime logic lives in the `src/` subdirectory as several TypeScript modules,
  bundled into a single compiled JavaScript file. `src/main.ts` is the entry point.
- Distributed as a single compiled JavaScript file that OpenRCT2 loads as a "local" plugin.

## Key files

- `src/main.ts` — entry point: registers the plugin and the map-toolbar menu item.
- `src/ui.ts` — the flexui window and its widgets (titles/labels/spinners/toggles/sliders).
- `src/store.ts` — the reactive stores (raw scan counts, user settings, hired/assigned counts, the
  derived Needed computations and disabled stores).
- `src/config.ts` — default values for the user-facing settings (tiles per staff, enabled flags, etc.).
- `src/scan.ts` — the map scans: park-entrance detection, height-aware footpath network walk,
  gardening-tile scan, ride-exit counting.
- `src/staff.ts` — staff roster logic: hire/fire, classification (cleanup vs gardening), patrol-area
  assignment and teleporting (single serialised queue), the Hired/Assigned refresh.
- `src/i18n/` — translation dictionaries (en-GB, de-DE) and the `t()` helper.
- `@openrct2/types` (npm dev dependency) — official OpenRCT2 scripting API type definitions,
  providing `node_modules/@openrct2/types/openrct2.d.ts`. Kept up to date via `npm update`; do not
  vendor a local copy.
- `tsconfig.json` — compiles `src/**/*.ts` to `dist/staff-manager.js` (ES2023, no module
  system, strict mode).
- `package.json` — `build` script runs `tsc --noEmit && esbuild ... && node deploy.js`; `watch`
  runs `esbuild --watch`.
- `deploy.js` — copies `dist/staff-manager.js` into the local OpenRCT2 `plugin` folder (OS-specific
  default path, overridable via `OPENRCT2_PLUGIN_DIR` env var) so it can be hot-reloaded in-game.
- `openrct2-staff-manager.slnx` / `openrct2-staff-manager.esproj` — Visual Studio JavaScript/TypeScript
  project so the plugin can be opened and built from Visual Studio.
- `.github/workflows/release.yml` — CI pipeline that builds the plugin and publishes a GitHub
  Release with `dist/staff-manager.js` attached whenever a tag matching `v*` is pushed.

## Build & run

```powershell
npm install        # first time only
npm run build      # tsc typecheck + esbuild bundle + deploy to local OpenRCT2 plugin folder
npm run watch       # esbuild --watch, for iterative development (does not auto-deploy)
```

Requires Node.js and npm on PATH. In Visual Studio, building the `.esproj`/`.slnx` runs the same
`npm run build` script.

## Conventions

- Tabs for indentation in the TypeScript files under `src/` (match existing style).
- Strict TypeScript (`strict: true`); avoid introducing `any` where a proper OpenRCT2 API type
  exists in `node_modules/@openrct2/types/openrct2.d.ts`.
- The compiled output has no runtime module system — the plugin must remain a single self-contained
  script, so internal modules are only allowed via `import`/`export` that esbuild bundles into the
  output file. Do not split into separate compiled output files.
- Note that map scans and bulk assignments currently run synchronously (they are not chunked
  across ticks with `forEachAsync`/`context.setTimeout`). Staff teleports ARE serialised through a
  single queue (`teleportQueue`/`processTeleportQueue`) because OpenRCT2 only supports one peep
  being picked up at a time — preserve this when adding any teleport logic.
- Plugin metadata (name, version, author) is set in the `registerPlugin(...)` call at the bottom
  of `src/main.ts`; keep `package.json`'s `version` field in sync when bumping versions for a
  release.
- Do not rely on `FootpathElement`/`EntranceElement.ride` as a sentinel to distinguish park
  entrances from ride entrances/exits, since a park entrance can share the same ride id as an
  unrelated ride. Instead, build the set of real ride entrance/exit tiles from
  `map.rides[*].stations[*].entrance/exit` (dividing by 32 to convert to tile coords).

## Releasing

1. Bump `version` in `package.json` and the `registerPlugin` call in `src/main.ts`.
2. Commit, then create and push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release.yml` workflow builds the plugin and publishes a GitHub Release with
   `dist/staff-manager.js` attached automatically.

## Testing changes

There is no automated test suite. Validate changes by:
1. Running `npm run build` to confirm the TypeScript compiles without errors.
2. Loading the deployed `staff-manager.js` in OpenRCT2 and exercising the affected functionality
   (open the plugin window from the map/red-toolbox menu, verify staff assignment behavior).

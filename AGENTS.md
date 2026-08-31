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
- `tsconfig.node.json` — type-checks the Node build-tooling `.ts` files (`deploy.ts`,
  `eslint.config.ts`) against `@types/node` as part of `npm run typecheck`.
- `eslint.config.ts` — dual-config ESLint flat config. Plugin source and unit tests
  (`src/**/*.ts`, `test/**/*.ts`) use the **type-aware** presets
  `recommendedTypeChecked` + `strictTypeChecked` + `stylisticTypeChecked`, wired to ESLint's
  `projectService` so rules have type info (tests are added to `allowDefaultProject` since
  `tsconfig.json` only includes `src/`). Build-tooling `.ts` files (`deploy.ts`,
  `eslint.config.ts`, `*.cjs`, `*.mjs`) are linted with the `@typescript-eslint/parser`
  plus ESLint core (`@eslint/js`) and `@stylistic/eslint-plugin`, with Node globals from the
  `globals` package and a strict/core rule set — do not apply the TS type-aware presets there.
  ESLint loads this TS config via `jiti` (ESLint 10 natively supports `.ts` configs).
- `deploy.ts` — copies `dist/staff-manager.js` into the local OpenRCT2 `plugin` folder
  (OS-specific default path, overridable via `OPENRCT2_PLUGIN_DIR` env var) so it can be
  hot-reloaded in-game. Run with `node` (project is `"type": "module"`).
- `openrct2-staff-manager.slnx` / `openrct2-staff-manager.esproj` — Visual Studio JavaScript/TypeScript
  project so the plugin can be opened and built from Visual Studio. `BaseIntermediateOutputPath` is set to
  `.tmp\obj\` so VS build artefacts don't pollute the repo root.
- `.github/workflows/release.yml` — CI pipeline that builds the plugin, runs the tests, and publishes
  a GitHub Release with `dist/staff-manager.js` attached whenever a tag matching `v*` is pushed.
- `.github/workflows/develop-prerelease.yml` — CI pipeline that builds the plugin, runs the tests, and
  publishes a `develop` prerelease tracking the tip of `main`.
- `test/` — Vitest unit tests for the pure, testable logic in `src/`.

## Build & run

```powershell
npm install        # first time only
npm run build      # lint + test + tsc typecheck + esbuild bundle + deploy to local OpenRCT2 plugin folder
npm run watch       # esbuild --watch, for iterative development (does not auto-deploy)
npm test           # run the unit tests alone (vitest run)
npm run typecheck  # run the TypeScript compiler alone (src + tsconfig.node.json)
npm run lint       # run the linter alone (eslint .)
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
- Automatic mode (`src/auto.ts` + the "Incremental automatic helpers" in `src/staff.ts`) decides
  **synchronously** against an in-memory record of each purpose's assigned areas
  (`autoAreasByPurpose` / `AutoArea`), *not* against the live staff roster/`patrolArea`s — those
  only update after async `staffhire`/`patrolArea.add` calls complete, so reading them mid-drag would
  hire one member per tile. Consecutive connected tiles extend one area up to its tiles/staff cap, hiring
  a new member only when nothing adjacent is under the cap; hires are serialised one per purpose via
  `queueAutoHire`. Ghost (hover) footpath tiles are filtered out in `queueTileIfPlacedPath` in
  `src/auto.ts` so hovering never hires staff. Preserve this synchronous tracking when touching auto mode.
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

Validate changes by:
1. Running `npm run build` to confirm lint, typecheck, AND the unit tests (`vitest`) pass.
2. Loading the deployed `staff-manager.js` in OpenRCT2 and exercising the affected functionality
   (open the plugin window from the map/red-toolbox menu, verify staff assignment behavior).

### Tests

Unit tests live in `test/` and cover the pure, testable logic in `src/` (they don't touch
OpenRCT2's live map/UI). They run on every `npm run build` and in CI (both workflows run
`npm test`). Because the bundled plugin runs in QuickJS-NG with no module loader, tests only
exercise exported pure helpers (`computeNeeded`, `tileKey`, `isValidStationExit`,
`classifyHandyman`, config defaults, …). OpenRCT2 globals that functions read at call time
(e.g. `map.size`) are stubbed in `beforeAll`/`afterAll`; never import `src/ui.ts` in a test.
When adding a new pure helper worth testing, export it from its module and add a `describe`/`it`
case in `test/`. Avoid relying on notes that map scans and bulk assignments run synchronously.

# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project overview

This is an [OpenRCT2](https://openrct2.io/) plugin called **Staff Manager**. It automates park
staff management (handymen, security guards, entertainers, mechanics) by splitting the park's
paths and queues into patrol areas and assigning staff accordingly. Handymen are split between
**cleanup** (paths + queues) and **gardening** (mow/water); mechanics patrol ride exits.

- Single-plugin project: all runtime logic lives in one root-level TypeScript file.
- Distributed as a single compiled JavaScript file that OpenRCT2 loads as a "local" plugin.

## Key files

- `staff-manager.ts` — the entire plugin source (types, logic, GUI, plugin registration). This is
  the only file that should normally need edits for feature/bugfix work.
- `@openrct2/types` (npm dev dependency) — official OpenRCT2 scripting API type definitions,
  providing `node_modules/@openrct2/types/openrct2.d.ts`. Kept up to date via `npm update`; do not
  vendor a local copy.
- `tsconfig.json` — compiles `staff-manager.ts` to `dist/staff-manager.js` (ES2023, no module
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

- Tabs for indentation in `staff-manager.ts` (match existing style).
- Strict TypeScript (`strict: true`); avoid introducing `any` where a proper OpenRCT2 API type
  exists in `node_modules/@openrct2/types/openrct2.d.ts`.
- The compiled output has no module system — the plugin must remain a single self-contained
  script; do not introduce `import`/`export` or split into multiple compiled modules (aside from
  the existing `import` of `openrct2-flexui`, which esbuild bundles into the single output file).
- Note that map scans and bulk assignments currently run synchronously (they are not chunked
  across ticks with `forEachAsync`/`context.setTimeout`). Staff teleports ARE serialised through a
  single queue (`teleportQueue`/`processTeleportQueue`) because OpenRCT2 only supports one peep
  being picked up at a time — preserve this when adding any teleport logic.
- Plugin metadata (name, version, author) is set in the `registerPlugin(...)` call at the bottom
  of `staff-manager.ts`; keep `package.json`'s `version` field in sync when bumping versions for a
  release.
- Do not rely on `FootpathElement`/`EntranceElement.ride` as a sentinel to distinguish park
  entrances from ride entrances/exits, since a park entrance can share the same ride id as an
  unrelated ride. Instead, build the set of real ride entrance/exit tiles from
  `map.rides[*].stations[*].entrance/exit` (dividing by 32 to convert to tile coords).

## Releasing

1. Bump `version` in `package.json` and the `registerPlugin` call in `staff-manager.ts`.
2. Commit, then create and push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release.yml` workflow builds the plugin and publishes a GitHub Release with
   `dist/staff-manager.js` attached automatically.

## Testing changes

There is no automated test suite. Validate changes by:
1. Running `npm run build` to confirm the TypeScript compiles without errors.
2. Loading the deployed `staff-manager.js` in OpenRCT2 and exercising the affected functionality
   (open the plugin window from the map/red-toolbox menu, verify staff assignment behavior).

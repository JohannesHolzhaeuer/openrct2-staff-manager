# AGENT.md

Guidance for AI coding agents (and humans) working in this repository.

## Project overview

This is an [OpenRCT2](https://openrct2.io/) plugin called **Staff Assigner**. It automates park
staff management (handymen, security, mascots/entertainers, mechanics) by splitting the park's
paths into patrol areas and assigning staff accordingly.

- Single-plugin project: all runtime logic lives in one root-level TypeScript file.
- Distributed as a single compiled JavaScript file that OpenRCT2 loads as a "local" plugin.

## Key files

- `staff-assigner.ts` — the entire plugin source (types, logic, GUI, plugin registration). This is
  the only file that should normally need edits for feature/bugfix work.
- `@openrct2/types` (npm dev dependency) — official OpenRCT2 scripting API type definitions,
  providing `node_modules/@openrct2/types/openrct2.d.ts`. Kept up to date via `npm update`; do not
  vendor a local copy.
- `tsconfig.json` — compiles `staff-assigner.ts` to `dist/staff-assigner.js` (ES2017, no module
  system, strict mode).
- `package.json` — `build` script runs `tsc && node deploy.js`; `watch` runs `tsc --watch`.
- `deploy.js` — copies `dist/staff-assigner.js` into the local OpenRCT2 `plugin` folder (OS-specific
  default path, overridable via `OPENRCT2_PLUGIN_DIR` env var) so it can be hot-reloaded in-game.
- `openrct2-staff-assigner.slnx` / `openrct2-staff-assigner.esproj` — Visual Studio JavaScript/TypeScript
  project so the plugin can be opened and built from Visual Studio.
- `.github/workflows/release.yml` — CI pipeline that builds the plugin and publishes a GitHub
  Release with `dist/staff-assigner.js` attached whenever a tag matching `v*` is pushed.

## Build & run

```powershell
npm install        # first time only
npm run build      # tsc compile + deploy to local OpenRCT2 plugin folder
npm run watch       # tsc --watch, for iterative development (does not auto-deploy)
```

Requires Node.js and npm on PATH. In Visual Studio, building the `.esproj`/`.sln` runs the same
`npm run build` script.

## Conventions

- Tabs for indentation in `staff-assigner.ts` (match existing style).
- Strict TypeScript (`strict: true`); avoid introducing `any` where a proper OpenRCT2 API type
  exists in `node_modules/@openrct2/types/openrct2.d.ts`.
- The compiled output has no module system (`module: "None"`) — the plugin must remain a single
  self-contained script; do not introduce `import`/`export` or split into multiple compiled
  modules.
- Keep long-running work (map scans, bulk assignments) chunked/asynchronous using the existing
  patterns (e.g. `forEachAsync`, `context.setTimeout`, busy/token guards) to avoid blocking the
  game loop.
- Plugin metadata (name, version, author) is set in the `registerPlugin(...)` call at the bottom
  of `staff-assigner.ts`; keep `package.json`'s `version` field in sync when bumping versions for a
  release.

## Releasing

1. Bump `version` in `package.json` and the `registerPlugin` call in `staff-assigner.ts`.
2. Commit, then create and push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release.yml` workflow builds the plugin and publishes a GitHub Release with
   `dist/staff-assigner.js` attached automatically.

## Testing changes

There is no automated test suite. Validate changes by:
1. Running `npm run build` to confirm the TypeScript compiles without errors.
2. Loading the deployed `staff-assigner.js` in OpenRCT2 and exercising the affected functionality
   (open the plugin window from the map/red-toolbox menu, verify staff assignment behavior).

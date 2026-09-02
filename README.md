# Staff Manager

![Staff Manager screenshot](https://github.com/JohannesHolzhaeuer/openrct2-staff-manager/raw/main/screenshot.png)

An [OpenRCT2](https://openrct2.org/) plugin that automates park staff management:
it splits your paths (and ride **queues**) among **handymen, security guards and
entertainers**, assigns **mechanics** to ride exits, and can **hire, fire and
(re)assign** staff so the right number always patrol the right places — sending
each staff member to their **nearest** free zone.

- **Version:** 0.9.4
- **Type:** local (single‑player / client‑side)
- **Licence:** MIT
- **Min API:** 34 · **Target API:** 77
- **Source:** `src/` (TypeScript, `src/main.ts` entry point, compiles to `dist/staff-manager.js`)

---

## Features

### 🧹 Path staff — Handymen, Guards, Entertainers
- **One area per staff member.** The park's pathways are split into contiguous
  patrol areas and one is assigned to each staff member.
- **Nearest‑zone assignment.** Every staff member is matched to the **closest free
  zone** to where they currently stand, minimising walking.
- **Only relevant paths.** Path counting uses a flood‑fill from the **park
  entrance** and keeps only tiles on **park‑owned land** — so unusable public
  streets (e.g. *Bumbly Beach*) are ignored.
- **Configurable density.** A spinner sets how many tiles each staff member should
  cover; the stats table shows *Hired · Needed · Difference* per type.
- **Handymen split in two.** Handymen are classified by their orders:
  - **Cleanup** handymen patrol the **path and queue** network.
  - **Gardening** handymen water and **mow** the park's grass/scenery tiles,
    with each connected garden area guaranteed at least one gardener.
- **Staff are placed in their area.** Each assigned staff member is moved into the
  centre of its area (onto a real, safely‑placeable path/queue tile).

### 🎭 Entertainers — dedicated options
Entertainers have their own controls instead of the generic density spinner:
- **Tiles / Staff** — how many tiles each entertainer covers.
- **Staff / Area** — how many entertainers share each area; **> 1 = overlapping**
  (the area grows so the tiles‑per‑staff density is preserved). Defaults to 2.
- **Queue** checkbox — include ride **queue** tiles in the patrol set, so
  entertainers can keep queuing guests happy instead of only patrolling plain paths.

### 🔧 Mechanics
- **One mechanic per ride exit.** Each mechanic patrols the exit tile plus the
  path tile directly in front of it (chosen by checking every cardinal neighbour
  for an actual footpath, rather than trusting the exit's stored facing direction).
- **Busy mechanics are protected.** A mechanic currently servicing a ride is never
  teleported or interrupted; they keep their patrol area but finish their job first.

### 🤖 Automatic management
- **Optional auto mode.** A toggle at the bottom of the window keeps staffing
  right-sized as the park changes, without pressing the buttons. New staff are only
  hired (or an existing area extended) when appropriate — see
  [Automatic staffing](#automatic-staffing-1) below.
- **Hovers don't hire.** A freshly placed path only triggers staff once it's a real
  (non-ghost) footpath; merely hovering the path tool never hires anyone.
- **Areas grow to their cap before hiring.** Auto mode tracks each type's assigned
  areas synchronously, so consecutive connected tiles extend one area up to the
  configured tiles/staff limit before hiring a new member — no more one hire per
  tile. Gardening handymen are created only for newly bought land with
  mowable/waterable grass that isn't already assigned.
- **Gated until first run.** The auto toggle is only usable after "Adjust and
  assign" has been run once.

### 👥 Hire / Fire
- **Adjust staff count** button hires or fires the right number of **every** type
  at once to match the calculated *Needed* counts — hiring when understaffed,
  firing staff when overstaffed.
- **Oldest staff first.** Surplus staff are fired oldest‑first for a stable,
  consistent result.

### 🖥️ UI & behaviour
- One resizable window with an **Enabled** toggle and a *Hired / Needed /
  Difference* stat table per staff type.
- **Assign** builds every type's patrol areas from the most recently scanned tiles
  and teleports one staff member to the start of each new area.
- Staff teleports are **serialised through a single queue**, because OpenRCT2 only
  supports one peep being “picked up” at a time — overlapping pickups would
  otherwise clobber each other.
- A status line reports the scanned counts, e.g.
  *Path tiles: n, Queue tiles: n, Garden tiles: n*.

---

## Building

This plugin is written in TypeScript against the community-maintained
[`@openrct2/types`](https://www.npmjs.com/package/@openrct2/types) package, which provides
official OpenRCT2 plugin API typings and is installed as a dev dependency via `npm install`
(no vendored `.d.ts` file is checked into this repository).

### Prerequisites

- **[Node.js](https://nodejs.org/) 24+ with npm** — required to install
  dependencies, run the TypeScript compiler, and run the `.ts` build tooling
  (`deploy.ts`, `eslint.config.ts`) through Node's native TypeScript support.
  Verify with:
  ```powershell
  node -v
  npm -v
  ```
- **OpenRCT2** installed at least once, so the local `plugin` folder (or your own custom
  location) exists to deploy into.
- Optional: **Visual Studio 2022/2026** with the Node.js/JavaScript workload if you want to open
  `openrct2-staff-manager.slnx` and build from the IDE instead of the command line (this runs the
  same `npm run build` script under the hood).

1. Install dependencies: `npm install`.
2. Build: `npm run build`.
   - Lints, runs the unit tests, type-checks, and compiles `src/` (entry
     `src/main.ts`) to `dist/staff-manager.js`, then automatically copies
     (`deploy.ts`) that file straight into your local OpenRCT2 **plugin**
     folder:
     - **Windows:** `Documents\OpenRCT2\plugin\`
     - **macOS:** `~/Library/Application Support/OpenRCT2/plugin/`
     - **Linux:** `~/.config/OpenRCT2/plugin/`
   - Override the destination with the `OPENRCT2_PLUGIN_DIR` environment
     variable if your OpenRCT2 user directory is somewhere else.
3. Use `npm run watch` while developing to recompile on save (note: this only
   recompiles; run `npm run build` again, or press the game's plugin
   hot-reload, after a `watch` recompile to redeploy the file).

### Code quality

- **Type-safe linting.** `npm run build` starts with `npm run lint` (`eslint .`).
  Plugin source and tests are checked with the type-aware
  `recommendedTypeChecked`/`strictTypeChecked`/`stylisticTypeChecked` presets,
  and the TypeScript build tooling (`deploy.ts`, `eslint.config.ts`) with
  ESLint core plus `@stylistic/eslint-plugin`. Run `npm run lint` on its own
  any time.

### Tests

Unit tests are written with [Vitest](https://vitest.dev) and cover the
testable, pure logic in `src/` (they don't touch OpenRCT2's live map/UI).
They run automatically as part of every build (`npm run build` = lint → test →
typecheck → bundle → deploy), or alone via `npm run test`.

- Tests live in [`test/`](test/). The OpenRCT2 globals that functions read
  at call time (e.g. `map.size`) are stubbed in `beforeAll`/`afterAll`.
- Because the bundled plugin runs in QuickJS-NG with no module loader, tests
  only exercise exported pure helpers (`computeNeeded`, `tileKey`,
  `isValidStationExit`, `classifyHandyman`, config defaults, …) — they do not
  load `src/ui.ts` or open a real window.

## Installation

1. Run `npm install` then `npm run build` (see [Building](#building)) — this
   compiles and deploys `staff-manager.js` directly into your OpenRCT2 plugin
   folder.
2. Start OpenRCT2 (or, in single‑player, use the plugin **hot‑reload**).
3. Open it from the **map / red‑toolbox button → “Staff Manager”**.

---

## Usage

1. **Open the window** from the toolbox menu.
2. For each staff type, tick the **Enabled** checkbox to include it.
3. Click **Adjust staff count** to hire/fire the right number of each type based
   on your settings (this is what fills the *Needed* column).
4. Click **Assign** to build patrol areas and move staff into them.
5. Tune the per-type spinners (tiles/staff, entertainer staff/area, handyman
   gardening density, entertainer Queue checkbox) and repeat steps 3–4 as your park
   changes.
6. Optionally **enable automatic management** (toggle at the bottom of the window) so
   the plugin keeps hiring/firing and assigning staff as you connect new paths or buy new
   land — see [Automatic staffing](#automatic-staffing-1).

---

## How it decides which tiles count

1. **Scan** every tile for footpaths (incl. queue flag), surface ownership and
   the park entrance.
2. **Flood‑fill** from the park entrance across connected footpath **edges**.
3. **Keep** only reachable tiles on **owned land**, split into **paths** and
   **queues**.
4. **Scan gardening tiles** — tiles with mowable grass or waterable scenery —
   grouped into connected components.
5. **Match** staff to the **nearest** zone (paths, or paths+queues for
   entertainers with the Queue checkbox on), or into fixed‑size overlapping areas for
   entertainers. Mechanics get the exit tile plus the adjacent path tile.

If the entrance can't be found, it falls back to seeding from owned path tiles.

---

## Automatic staffing

Auto mode (the toggle at the bottom of the window) reacts to two kinds of map edits:

- **New footpath / queue tiles.** When a real (non-ghost) path is created, a
  cleanup handyman, guard or entertainer is hired only if **no area of that type
  already covers the tile**; otherwise the adjacent area is **extended** up to its
  tiles/staff cap. Hover previews (ghost paths) are ignored.
- **Newly bought land.** A gardening handyman is created only for newly bought land whose
  tile is actually mowable/waterable grass **and** is not yet assigned to a gardening
  handyman; adjacent garden areas are extended up to the mower-tiles/staff cap first.

Auto mode bases these decisions on a **synchronous in-memory record** of each staff
type's assigned areas (independent of the async staff-hire/patrol-area game actions),
which is why a burst of connected tiles extends one area rather than hiring one member per
tile. It's disabled until "Adjust and assign" has been run once.

### Notes & limitations (new)

- **Auto mode never performs full map scans.** It makes incremental, minimal changes only
  for the tiles you actually place or buy, so it stays cheap during long path drags.

---

## Notes & limitations

- **Mechanic dispatch:** the scripting API doesn't expose which ride a mechanic is
  dispatched to, so “busy” is inferred from the mechanic not standing on a
  footpath tile.
- **Patrol areas are height‑ and water‑aware.** Tiles are only linked into the
  same patrol area when actually walkable between each other (matching path/slope
  heights, no unclimbable height differences, never through water), so an area is
  always one contiguous, fully reachable region. If there are more disconnected
  pockets than staff to cover them, the largest pockets are covered first rather
  than merging areas a staff member couldn't actually walk across.
- **Teleport vs. patrol:** a staff member's patrol area is always built in full,
  but the physical teleport target is the **nearest safely‑placeable** path tile,
  since the game rejects placement on obstructed tiles (benches, scenery, queue TV,
  embedded ride elements, etc.).
- **Single‑player focus:** actions are skipped on network clients.

---

## Configuration (in‑file)

Near the top of `src/config.ts` the default tunables are defined (and the
initial values are assigned to the stores in `src/store.ts`). They're exposed
directly in the UI, but their initial defaults live in code:

| Store (default) | Purpose |
| --- | --- |
| `handymenTilesPerStaffStore` (8) | Path/queue tiles per cleanup handyman |
| `handymenMowerTilesPerStaffStore` (256) | Garden tiles per gardening handyman |
| `guardsTilesPerStaffStore` (16) | Plain path tiles per guard |
| `entertainersTilesPerStaffStore` (16) | Tiles per entertainer |
| `entertainersPerAreaStore` (2) | Entertainers assigned per area |
| `entertainersIncludeQueueStore` (true) | Whether entertainers patrol queues |
| `*EnabledStore` (true) | Whether each staff type is managed |

---

## Changelog

- **0.9.4** – Made auto-mode's enlarge-vs-hire decision respect genuine walkable
  connectivity (bridges over paths, and inclined ways at different heights, are
  no longer merged into one patrol area). Included elevated footpaths over
  unowned land (bridges/overpasses) in patrol areas. Fixed a teleport-queue
  stack overflow for large queues. Excluded tiles with shops/rides/tracks from
  garden tiles unless the element is clearly elevated above the grass. Fixed
  gardening handymen being teleported off their patrol area onto the wrong
  height. Let gardening patrol areas span paths for reachability, so a handyman
  can walk across a path to reach mowed grass on the other side.
- **0.9.3** – Combined "Adjust staff count" and "Assign" into a single
  "Adjust and assign" button that runs only after the async hire/fire actions
  complete; split the previously-synchronous per-staff patrol-area assignment
  across ticks so the game no longer freezes; added a live status line
  showing which step is running. All new strings localized.
- **0.9.2** – Made patrol and gardening areas height‑ and water‑aware: paths
  and land tiles are now only linked when actually walkable (matching slope
  heights, no cliffs, no water), so patrol areas are always one contiguous,
  fully reachable region instead of sometimes stranding staff on disconnected
  or submerged tiles.
- **0.9.0** – Renamed from the plugin's original working title to **Staff
  Manager**; added per‑staff‑type enable controls; rewrote the UI; improved
  entrance detection, mechanic patrol assignment (cardinal‑neighbour front‑tile
  matching, busy‑mechanic protection), gardening granularity, and patrol
  connectivity; removed leftover console logging.

---

## TODO

- **Fix patrol‑area edge cases** — continue shaking out issues in area assignment
  (gardening, mechanics, handymen) and the hire/fire flows.

---

## Localization

The plugin's UI text is localized through a small, self-contained TypeScript
i18n layer in [`src/i18n/`](src/i18n/) — OpenRCT2's built-in `StringId`/
`data/language/*.txt` localization system is part of the C++ core and isn't
exposed to plugins, so this layer replaces it entirely.

- **Language detection**: on startup, the plugin reads
  `context.configuration.get("general.language", "en-GB")` inside a
  try/catch (the API can vary between OpenRCT2 versions). If the read fails,
  or the detected language has no matching dictionary, the plugin falls back
  to **`en-GB`**, which is the canonical/fallback dictionary and always
  contains every translation key.
- **Adding a new language**: copy [`src/i18n/en-GB.ts`](src/i18n/en-GB.ts) to
  `src/i18n/<language-code>.ts` (e.g. `fr-FR.ts`), translate every value
  (the `Translations` type in [`src/i18n/types.ts`](src/i18n/types.ts) makes
  the TypeScript compiler fail the build if a key is missing or misspelled),
  then import and register the dictionary in the `translations` map in
  [`src/i18n/index.ts`](src/i18n/index.ts).
- **Build-time bundling**: translations live in separate `.ts` source files
  purely for maintainability. QuickJS-NG (the engine the bundled plugin runs
  in) has no runtime module loader or file-system access, so translations are
  never read from disk while the game is running — esbuild inlines every
  language file into the single bundled `dist/staff-manager.js` at build
  time.

---

## Licence

MIT © Johannes Holzhäuer

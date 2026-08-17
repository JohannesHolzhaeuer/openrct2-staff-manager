# Staff Manager

An [OpenRCT2](https://openrct2.org/) plugin that automates park staff management:
it splits your paths (or ride **queues**) among **handymen, security guards and
mascots**, assigns **mechanics** to ride exits, manages **inspection
intervals**, and can automatically **hire, fire and (re)assign** staff as your
park changes — always sending each staff member to their **nearest** free zone.

- **Version:** 1.0.0
- **Type:** local (single‑player / client‑side)
- **Licence:** MIT
- **Min API:** 34 · **Target API:** 77
- **Source:** `staff-manager.ts` (TypeScript, compiles to `dist/staff-manager.js`)

---

## Features

### 🧹 Path staff — Handymen, Security, Mascots
- **One area per staff member.** The park's footpaths are split into equal,
  contiguous patrol areas and one is assigned to each staff member.
- **Nearest‑zone assignment.** Every staff member is matched to the **closest
  free zone** to where they currently stand, minimising walking.
- **Only relevant paths.** Path counting uses a flood‑fill from the **park
  entrance** and keeps only tiles on **park‑owned land** — so unusable public
  streets (e.g. *Bumbly Beach*) are ignored.
- **Configurable density.** A spinner sets how many path tiles each staff
  member should cover; the status line shows *Paths · Needed · Hired · Assignable*.
- **Handymen mowing rule.** Handymen with **grass mowing enabled are left
  alone** — only path‑cleaning handymen are managed.
- **Staff are placed in their area.** Each assigned staff member is moved into
  the centre of its area (onto a real path/queue tile).

### 🎭 Mascots — dedicated options
Mascots have their own controls instead of the generic density spinner:
- **Assign to queue lines** (checkbox): place mascots along ride **queues** to
  keep queuing guests happy, instead of general paths.
- **Queue tiles / mascot** — max queue tiles each mascot covers (queue mode).
- **Path tiles / mascot** — tiles each mascot covers (path mode).
- **Mascots per area** — how many mascots share each area; **> 1 = overlapping**
  (the area grows so the tiles‑per‑mascot density is preserved).

### 🔧 Mechanics
- **One mechanic per ride exit**, each patrolling the exit plus the 3 path tiles leading up to it.
- **Nearest‑mechanic matching:** each uncovered exit gets the closest free,
  non‑busy mechanic.
- **Inspection interval** dropdown (10 min … Never) applied to **all rides**,
  independent of ride type. Newly assigned rides get an inspection triggered.
- **Busy mechanics are protected:** a mechanic currently inspecting/fixing a
  ride is never reassigned or fired.

### 👥 Hire / Fire
- If an assignment needs **more** staff than available, a dialog offers to
  **hire** the shortfall.
- If it needs **fewer**, a dialog offers to **fire** the surplus — **newest
  staff first** (busy mechanics are skipped).
- Dialog wording is grammatically correct per type, e.g. *Hire 1 guard*,
  *Fire 3 mascots*, *Hire 2 mechanics*, *Fire 1 handyman*.

### 🤖 Automatic mode
- **Auto mechanics:** on ride‑exit or staff changes, automatically hire missing
  / fire surplus mechanics and reassign — no dialogs.
- **Per‑type auto toggles** for **handymen, security and mascots** (one switch
  each): automatically right‑size and reassign when **paths, land rights or
  staff** change. These are **debounced** (path‑dragging fires many events) and
  loop‑guarded against the plugin's own hire/fire actions.

### 🔔 Notifications
Park messages report when staff are **hired**, **fired**, or **assigned /
reassigned** to a different spot, e.g.
`Handymen: 5 assigned, 2 reassigned over 130 path tiles.`

### 🖥️ UI & performance
- **Resizable** window with a section (and picture) per staff type; controls
  reflow to the window width.
- All heavy work (whole‑map scan, bulk actions) is **chunked across game
  ticks**, so the game never freezes. *(OpenRCT2 plugin JS is single‑threaded;
  there is no true multithreading — long jobs are spread across ticks.)*
- The map scan is **cached** and shared by all path staff; the density spinners
  recompute *Needed* instantly without rescanning.

---

## Building

This plugin is written in TypeScript against the community-maintained
[`@openrct2/types`](https://www.npmjs.com/package/@openrct2/types) package, which provides
official OpenRCT2 plugin API typings and is installed as a dev dependency via `npm install`
(no vendored `.d.ts` file is checked into this repository).

### Prerequisites

- **[Node.js](https://nodejs.org/) 18+ (LTS recommended) with npm** — required to install
  dependencies and run the TypeScript compiler. Verify with:
  ```powershell
  node -v
  npm -v
  ```
- **OpenRCT2** installed at least once, so the local `plugin` folder (or your own custom
  location) exists to deploy into.
- Optional: **Visual Studio 2022/2026** with the Node.js/JavaScript workload if you want to open
  `openrct2-staff-manager.sln` and build from the IDE instead of the command line (this runs the
  same `npm run build` script under the hood).

1. Install dependencies: `npm install`.
2. Build: `npm run build`.
   - Compiles `staff-manager.ts` to `dist/staff-manager.js`.
   - Then automatically copies (`deploy.js`) that file straight into your
     local OpenRCT2 **plugin** folder:
     - **Windows:** `Documents\OpenRCT2\plugin\`
     - **macOS:** `~/Library/Application Support/OpenRCT2/plugin/`
     - **Linux:** `~/.config/OpenRCT2/plugin/`
   - Override the destination with the `OPENRCT2_PLUGIN_DIR` environment
     variable if your OpenRCT2 user directory is somewhere else.
3. Use `npm run watch` while developing to recompile on save (note: this only
   recompiles; run `npm run build` again, or press the game's plugin
   hot-reload, after a `watch` recompile to redeploy the file).

## Installation

1. Run `npm install` then `npm run build` (see [Building](#building)) — this
   compiles and deploys `staff-manager.js` directly into your OpenRCT2 plugin
   folder.
2. Start OpenRCT2 (or, in single‑player, use the plugin **hot‑reload**).
3. Open it from the **map / red‑toolbox button → “Staff Manager”**.

---

## Usage

1. **Open the window** from the toolbox menu.
2. For each path‑staff section (Handymen / Security / Mascots):
   - Set the **density** (path tiles per staff; for mascots, the queue/path
     tiles‑per‑mascot and mascots‑per‑area, plus the queue‑lines toggle).
   - Click **Calculate & assign … areas**. If you don't have enough (or have
     too many) staff, confirm the **Hire/Fire** dialog.
   - Optionally tick **Auto** to keep that type managed automatically.
3. In the **Mechanics** section:
   - Pick an **Inspection interval** (applies to all rides).
   - Click **Assign mechanics to exits now** (offers to hire/fire as needed).
   - Optionally tick **Auto mechanics** for hands‑off management.

---

## How it decides which tiles count

1. **Scan** every tile for footpaths (incl. queue flag), surface ownership and
   the park entrance (chunked across ticks).
2. **Flood‑fill** from the park entrance across connected footpath **edges**.
3. **Keep** only reachable tiles on **owned land**, split into **paths** and
   **queues**.
4. **Match** staff to the **nearest** zone of the appropriate set (paths, or
   queues for mascots in queue mode), or into fixed‑size overlapping areas for
   mascots.

If the entrance can't be found, it falls back to seeding from owned path tiles.

---

## Notes & limitations

- **Mechanic dispatch:** the scripting API doesn't expose which ride a mechanic
  is dispatched to, so “busy” is inferred from the mechanic standing on a ride
  (track/exit) tile.
- **`staffhire` reliability:** hiring can occasionally be rejected by the game
  (money/limits); the plugin reports how many actually succeeded and assigns
  whatever exists.
- **Icons:** each section shows the built‑in staff icon. Distinct per‑type
  sprites aren't stable numeric constants across builds, so the same
  guaranteed‑valid staff icon is used for all types (editable at the top of the
  file via `STAFF_SPRITE`).
- **Reachability vs. connection:** a mechanic/handyman can only work paths/exits
  that are actually **connected** to the network.
- **Matching cost:** nearest‑zone matching is O(n²) per pass — fine for the
  usual dozens of staff; extreme counts (hundreds of one type) would be slower.
- **Single‑player focus:** actions are skipped on network clients.

---

## Configuration (in‑file)

Near the top of `staff-manager.ts` you can tweak:

| Constant | Purpose |
| --- | --- |
| `STAFF_SPRITE` | Icon sprite id per staff type |
| `STAFF_ORDERS` | Default staff orders on hire (e.g. handyman = sweep+water+bins, no mowing) |
| `SCAN_ROWS_PER_TICK` | Map‑scan chunk size (responsiveness vs. speed) |
| `ACTIONS_PER_TICK` | Bulk game‑action chunk size |
| `AUTO_PATH_DEBOUNCE_MS` | Debounce delay for auto path‑staff runs |

---

## Changelog (recent)

- **1.0.0** – Initial release.

---

## Licence

MIT © Johannes

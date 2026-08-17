# Staff Manager Plus

An [OpenRCT2](https://openrct2.org/) plugin that automates park staff management:
it splits your paths among **handymen, security guards and mascots**, assigns
**mechanics** to ride exits, manages **inspection intervals**, and can
automatically **hire, fire and (re)assign** staff as your park changes.

- **Version:** 2.15.0
- **Type:** local (single‑player / client‑side)
- **Licence:** MIT
- **Min API:** 34 · **Target API:** 77
- **File:** `staff-manager-plus.js`

---

## Features

### 🧹 Path staff — Handymen, Security, Mascots
- **One area per staff member.** The park's footpaths are split into equal,
  contiguous patrol areas and one is assigned to each staff member.
- **Only relevant paths.** Path counting uses a flood‑fill from the **park
  entrance** and keeps only tiles on **park‑owned land** — so unusable public
  streets (e.g. *Bumbly Beach*) are ignored. Queue paths are excluded.
- **Configurable density.** A spinner sets how many path tiles each staff
  member should cover; the window shows *Paths · Needed · Hired · Assignable*.
- **Handymen mowing rule.** Handymen with **grass mowing enabled are left
  alone** — only path‑cleaning handymen are managed.
- **Staff are placed in their area.** Each assigned staff member is moved into
  the middle of its area (onto a real path tile).

### 🎭 Mascots — overlapping areas (optional)
- **Overlap mode:** group paths into fixed‑size areas and place **several
  mascots per area** (they share the area).
- **Area size** and **mascots per area** spinners control the layout.

### 🔧 Mechanics
- **One mechanic per ride exit**, each with a 4×4 patrol area at the exit.
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
  *Fire 3 mascots*, *Hire 2 mechanics*.

### 🤖 Automatic mode
- **Auto mechanics:** on ride‑exit or staff changes, automatically hire missing
  / fire surplus mechanics and reassign — no dialogs.
- **Per‑type auto toggles** for handymen, security and mascots: automatically
  right‑size and reassign when **paths, land rights or staff** change. These are
  **debounced** (path‑dragging fires many events) and loop‑guarded.

### 🔔 Notifications
Park messages report when staff are **hired**, **fired**, or **assigned /
reassigned** to a different spot, e.g.
`Handymen: 5 assigned, 2 reassigned over 130 path tiles.`

### 🖥️ UI & performance
- Resizable window with a section (and picture) per staff type.
- All heavy work (whole‑map scan, bulk actions) is **chunked across game
  ticks**, so the game never freezes. *(OpenRCT2 plugin JS is single‑threaded;
  there is no true multithreading.)*

---

## Installation

1. Download **`staff-manager-plus.js`**.
2. Copy it into your OpenRCT2 **plugin** folder:
   - **Windows:** `Documents\OpenRCT2\plugin\`
   - **macOS:** `~/Library/Application Support/OpenRCT2/plugin/`
   - **Linux:** `~/.config/OpenRCT2/plugin/`
3. Start OpenRCT2 (or, in single‑player, use the plugin **hot‑reload**).
4. Open it from the **map/red‑toolbox button → “Staff Manager Plus”**.

---

## Usage

1. **Open the window** from the toolbox menu.
2. For each path‑staff section (Handymen / Security / Mascots):
   - Set **Path tiles per staff** (and, for mascots, overlap options).
   - Click **Calculate & assign … areas**. If you don't have enough (or have
     too many) staff, confirm the **Hire/Fire** dialog.
   - Optionally tick **Auto** to keep that type managed automatically.
3. In the **Mechanics** section:
   - Pick an **Inspection interval** (applies to all rides).
   - Click **Assign mechanics to exits now** (offers to hire/fire as needed).
   - Optionally tick **Auto mechanics** for hands‑off management.

---

## How it decides which paths count

1. **Scan** every tile for footpaths, surface ownership and the park entrance
   (chunked across ticks).
2. **Flood‑fill** from the park entrance across connected footpath **edges**.
3. **Keep** only reachable, **non‑queue** tiles that are on **owned land**.
4. **Split** those tiles evenly among the eligible staff (or into fixed‑size
   overlapping areas for mascots).

If the entrance can't be found, it falls back to seeding from owned path tiles.

---

## Notes & limitations

- **Staff type detection / dispatch:** the scripting API does not expose which
  ride a mechanic is dispatched to, so “busy” is inferred from the mechanic
  standing on a ride (track/exit) tile.
- **`staffhire` reliability:** hiring can occasionally be rejected by the game
  (money/limits); the plugin reports how many actually succeeded and assigns
  whatever exists.
- **Icons:** each section shows the built‑in staff icon. Distinct per‑type
  sprites aren't stable numeric constants across builds, so the same
  guaranteed‑valid staff icon is used for all types (editable at the top of the
  file via `STAFF_SPRITE`).
- **Reachability vs. connection:** a mechanic/handyman can only work paths/exits
  that are actually **connected** to the network.
- **Single‑player focus:** actions are skipped on network clients.

---

## Configuration (in‑file)

Near the top of `staff-manager-plus.js` you can tweak:

| Constant | Purpose |
| --- | --- |
| `STAFF_SPRITE` | Icon sprite id per staff type |
| `STAFF_ORDERS` | Default staff orders on hire (e.g. handyman = sweep+water+bins, no mowing) |
| `SCAN_ROWS_PER_TICK` | Map‑scan chunk size (responsiveness vs. speed) |
| `ACTIONS_PER_TICK` | Bulk game‑action chunk size |
| `AUTO_PATH_DEBOUNCE_MS` | Debounce delay for auto path‑staff runs |

---

## Changelog (recent)

- **2.15.0** – Messages for hired / fired / (re)assigned staff.
- **2.14.0** – Separate auto toggles per path‑staff type.
- **2.13.0** – Auto hire/fire + assign for handymen, security and mascots.
- **2.12.0** – Auto mechanics now hire/fire as well as assign.
- **2.11.x** – Fire surplus (newest first); busy mechanics protected.
- **2.10.0** – Hire dialogs when short‑staffed (all types).
- **2.9.0** – Staff‑type pictures and nicer layout.
- **2.8.0** – Mascot overlapping‑area options.
- **2.7.0** – Security and mascot path management.
- **2.5–2.6** – Resizable window; non‑blocking chunked scan.
- **2.4.0** – Reachable‑from‑entrance + owned‑land path filtering.

---

## Licence

MIT © Johannes

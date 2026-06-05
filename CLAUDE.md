# Footprint

Footprint is a personal travel-map app: import your Google Maps Timeline export,
and it lights up every country, region, and city you've visited on an interactive
map. It runs both as a **static web app** (deployed to GitHub Pages, read-only) and
as a **native macOS desktop app** (built with Tauri, read/write).

## Tech stack

- **Frontend:** TypeScript (strict) + Vite 6, no UI framework — plain DOM, ES
  modules. Entry point is `src/main.ts`, wired up against the static markup in
  `index.html`.
- **Map:** [MapLibre GL](https://maplibre.org/) with CARTO raster basemaps
  (Positron for light, Dark Matter for dark).
- **Geo:** [Turf.js](https://turfjs.org/) for point-in-polygon and
  nearest-city math. Reference geometry lives in `public/data/*.geojson`
  (Natural Earth countries, states/provinces, populated places).
- **Desktop shell:** [Tauri 2](https://tauri.app/) (Rust) in `src-tauri/`. The
  Rust side is intentionally thin — one command, `get_data_dir`.
- **Persistence:** a single `visited.json` file (no database).

## Commands

```bash
npm run dev          # Vite dev server at http://127.0.0.1:5173 (browser, read-only)
npm run build        # Type-check (tsc) + production build to dist/
npm run preview      # Preview the production build
npm run tauri:dev    # Run the native macOS app (read/write) — requires Rust toolchain
npm run tauri:build  # Build the distributable .app bundle
```

There is **no test suite and no linter** configured yet. `npm run build` runs
`tsc` first, so a successful build is the current bar for "type-safe and
compiles." `tsconfig.json` is strict (`noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`).

## Architecture & data flow

The import pipeline is the heart of the app:

1. **Import** (`src/import/`) — `dropzone.ts` takes a dropped/selected JSON file;
   `parser.ts` normalizes it into `{ points, visits }`. The parser handles
   **multiple Google Timeline formats**: legacy Records (`locations`), legacy
   Semantic (`timelineObjects`), on-device export (`semanticSegments` / bare
   array), and `rawSignals`. Coordinates arrive as E7 ints, `geo:` strings, or
   `lat,lng` strings depending on format — hence the several small parse helpers.
2. **Spatial join** (`src/geo/spatialJoin.ts`) — each visit is matched to its
   containing country and state polygon (bbox pre-filter, then Turf
   `booleanPointInPolygon`) and to the nearest city within 25 km. Returns sets of
   visited IDs.
3. **Persistence** (`src/store/visitedFile.ts`) — merges new visits into the
   existing set and writes `visited.json`. **Saving only works in the Tauri
   (desktop) build**; in the browser the store is read-only and `saveVisited`
   throws. Raw imports are also archived to `timeline-raw/` (gitignored — they
   contain precise GPS history).
4. **Render** (`src/map/` + `src/ui/`) — `layers.ts` tags every reference feature
   with `visited: 0|1` and drives MapLibre fill/line/circle layers; `sidebar.ts`
   renders the stats. Three view layers: Countries, Regions (states), Cities.

### Reference data & ID schemes (`src/geo/datasets.ts`)

GeoJSON datasets are lazy-loaded and cached. Each feature is reduced to a stable
ID used as the "visited" key:

- **Country:** `ISO_A3`, falling back through `ADM0_A3` → `SOV_A3` → `ADMIN`
  (Natural Earth uses `-99` for missing codes).
- **State/region:** `iso_3166_2`, falling back to `adm1_code` or
  `admin|name`.
- **City:** composite `ADM0_A3|ADM1NAME|NAMEASCII`.

`countCountries()` collapses **dependent territories onto their parent**
(via the `TERRITORY_PARENT` map) so the headline "Countries" stat counts sovereign
nations, not territories — but the territory polygons still render as visited.

## Storage locations

- **Desktop app** reads/writes `~/Documents/Claude/Footprint/public/data/visited.json`
  (path defined in `src-tauri/src/lib.rs::get_data_dir`). This is the user's live
  data, separate from the repo.
- **Web app** fetches the `public/data/visited.json` that's committed to the repo
  (read-only snapshot).
- `scripts/sync-visited.sh` commits and pushes the repo's `visited.json` — the
  bridge for publishing your desktop data to the web build.

## Deployment

`.github/workflows/deploy.yml` builds on push to `main` and deploys to GitHub
Pages with base path `/footprint/`. Anything that depends on the deployed URL must
respect `import.meta.env.BASE_URL` (the data-fetch URLs already do).

## Conventions & gotchas

- **No framework, no JSX.** Keep to plain TypeScript + direct DOM manipulation to
  match the existing style. State lives in module-level variables in `main.ts`.
- **Browser vs. Tauri:** feature-detect with `isTauri()` (checks
  `__TAURI_INTERNALS__`). Any save/write path must guard against browser mode.
- **MapLibre resize quirk:** the map needs nudged `resize()` calls after sidebar
  transitions and via a `ResizeObserver` — flex children settle late. Don't remove
  these without testing the sidebar toggle.
- **CSP is strict** in both `index.html` and `tauri.conf.json`. Adding any new
  external resource (tiles, fonts, APIs) means updating both Content-Security-Policy
  declarations.
- **Privacy:** raw timeline exports (`public/data/timeline-raw/`) are gitignored on
  purpose — they hold precise location history and must never be committed.
- The "states" layer is labeled **"Regions"** in the UI; the internal name remains
  `states` throughout the code and `visited.json`.
</content>
</invoke>

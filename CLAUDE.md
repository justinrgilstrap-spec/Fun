# Footprint

Footprint is a personal travel-map app: import your Google Maps Timeline export,
and it lights up every country, region, and city you've visited on an interactive
map. It runs both as a **static web app** (deployed to GitHub Pages, read-only) and
as a **native macOS desktop app** (built with Tauri, read/write).

## Tech stack

- **Frontend:** TypeScript (strict) + Vite 6, no UI framework — plain DOM, ES
  modules. Entry point is `src/main.ts`, wired up against the static markup in
  `index.html`.
- **Map:** [MapLibre GL](https://maplibre.org/) with CARTO **vector** basemaps
  (Positron for light, Dark Matter for dark). The GL styles are **vendored** to
  `public/basemap/{positron,dark-matter}.json` — copied from CARTO with the
  `place_continent` label layer stripped (the only label we don't want; country/
  state/city labels there already use `{name_en}`, so text is English). Tiles,
  glyphs, and sprites load from `tiles.basemaps.cartocdn.com`, covered by the
  existing CSP `*.basemaps.cartocdn.com` wildcard — so vendoring needs **no CSP
  change**. `src/map/map.ts` points the style at the local JSON; the visited
  fills/dots are inserted *beneath the first symbol (label) layer* via `beforeId`
  in `layers.ts` so place labels stay legible above the shading.
- **Geo:** [Turf.js](https://turfjs.org/) for point-in-polygon and nearest-city
  math — imported as the specific sub-packages used (`@turf/boolean-point-in-polygon`,
  `@turf/distance`, `@turf/helpers`), not the `@turf/turf` umbrella. Reference
  geometry lives in `public/data/*.geojson` (Natural Earth countries,
  states/provinces, populated places), pre-shrunk by `scripts/trim-geojson.mjs`
  (5-decimal coordinate precision + a property allowlist; **no geometric
  simplification**, so polygons look identical at every zoom) — roughly
  11 / 2 / 26 MB for countries / cities / states (states ≈ 8.5 MB gzipped).
  The repo copies carry **only allowlisted properties**; if a new feature needs
  another Natural Earth field, add it to the script's `KEEP` map and re-run the
  script against a fresh NE download.
- **Desktop shell:** [Tauri 2](https://tauri.app/) (Rust) in `src-tauri/`. The
  Rust side is intentionally thin — one command, `get_data_dir`.
- **Persistence:** a single `visited.json` file (no database).
- **PWA:** installable to the iOS/Android home screen via
  `public/manifest.webmanifest`, an `apple-touch-icon`, and `apple-mobile-web-app-*`
  meta tags in `index.html` (icons in `public/icons/`). The read-only web build is
  what gets installed. `public/sw.js` (registered by `main.ts` in production
  browser builds only — never dev or Tauri) makes it work offline: precached app
  shell, stale-while-revalidate for `visited.json` + reference GeoJSON (new data
  shows on the *next* open), capped cache-first for CARTO tiles. Bump `VERSION`
  in `sw.js` when its caching logic changes.

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
`noFallthroughCasesInSwitch`). `.github/workflows/ci.yml` runs `npm run build`
on every PR, so that bar is enforced before merge.

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
   renders the stats (raw counts + World / Continents / U.S.-states completion
   bars). Three view layers: Countries, Regions (states), Cities. Only countries
   load at startup; **states and cities are lazy-loaded** the first time their
   view is opened (`setLayer` → `ensure*`), with a spinner on the toggle.
   Switching back to a loaded layer just flips visibility — `setData` re-tags a
   source only when the visited sets change (e.g. after an import).
   `initInteractions()` wires click-to-inspect popups + a hover cursor **once**,
   keyed by layer id so the listeners survive the style rebuild a theme change
   triggers (don't move these into the per-layer `ensure*` functions, or each
   theme toggle re-registers a duplicate handler).
5. **Search** (`src/ui/search.ts`) — the sidebar search box indexes the same
   three reference datasets (built on first focus, which also triggers the lazy
   states/cities downloads), so every result is a feature the map can render and
   (on desktop) mark visited — deliberately no external geocoder. Selecting a
   result switches to that layer (`activateLayer` in `main.ts`), flies to it
   (`flyToFeature`), and opens the standard inspect popup (`openFeaturePopup`,
   both in `layers.ts`). Polygon fly-tos anchor on the Natural Earth label point
   and fall back to bbox center; antimeridian-spanning countries (Russia, Fiji,
   USA) get the label-point path because their bbox is near-global.

### Reference data & ID schemes (`src/geo/datasets.ts`)

`datasets.ts` fetches each GeoJSON once and caches it at module scope. The map
requests only countries at startup; states/cities are fetched on demand (see
Render, above). Each feature is reduced to a stable ID used as the "visited" key:

- **Country:** `ISO_A3`, falling back through `ADM0_A3` → `SOV_A3` → `ADMIN`
  (Natural Earth uses `-99` for missing codes).
- **State/region:** `iso_3166_2`, falling back to `adm1_code` or
  `admin|name`.
- **City:** composite `ADM0_A3|ADM1NAME|NAMEASCII`.
- **National Park:** `UNIT_CODE`, the NPS 4-letter unit code (e.g. `YELL`) — no
  fallback needed, it's the boundary dataset's own stable primary key.

`countCountries()` collapses **dependent territories onto their parent**
(via the `TERRITORY_PARENT` map) so the headline "Countries" stat counts sovereign
nations, not territories — but the territory polygons still render as visited.

### Parks layer (`public/data/parks.geojson`)

A fourth view alongside Countries/Regions/Cities: the 63 units the NPS
designates "National Park" (Congaree counts, Gateway National Recreation Area
doesn't — see the UNIT_TYPE filter this was built from). Unlike the other three
datasets it isn't Natural Earth or lazy-loaded — it's a small (63-feature),
always-loaded dataset from the NPS Land Resources Division's official boundary
polygons. Visited state is set two ways, same as every other layer:

- **Auto-detect:** `joinVisits()` in `src/geo/spatialJoin.ts` runs the same
  bbox-prefiltered `booleanPointInPolygon` join used for countries/states
  against the park polygons.
- **Manual override:** the same click-to-inspect popup + "Mark/Unmark visited"
  button every layer already has (desktop write-mode) works for parks with no
  extra code — `visitedId()`/`featureKey()`/`contentFor()` in `src/map/layers.ts`
  just gained a `"parks"` case each. Search (`src/ui/search.ts`) indexes parks
  too, so a tiny park (Hot Springs, Congaree) is one search away from a
  "Mark visited" click even if its on-map fill is a hard target to hit at low zoom.

Regenerating `parks.geojson`: fetch the official NPS boundary service
(`https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer`,
see `irma.nps.gov/App/Reference/Profile/2196725` for the dataset profile),
filter features to `UNIT_TYPE == "National Park"`, merge multi-polygon records
per unit into one Feature (see `parks.geojson`'s existing shape), attach a
centroid as `LABEL_X`/`LABEL_Y`, then run `scripts/trim-geojson.mjs`. Current
file size is ~11.8 MB after trimming — several of the 63 (Wrangell-St. Elias,
Glacier Bay, Channel Islands) are large, highly detailed coastal/cadastral
polygons, meaningfully bigger per-feature than a Natural Earth state. Unlike
countries/states, geometric simplification hasn't been ruled out here (see
"Decided against" — that decision was about Natural Earth data specifically);
worth revisiting with `mapshaper` if the bundle size becomes a problem, since
this is cadastral-grade precision doing a basemap's job.

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
respect `import.meta.env.BASE_URL` (the data-fetch URLs already do). The PWA
manifest sidesteps the base path with **relative** internal paths
(`start_url`/`scope`/icon `src`), and Vite rebases the manifest/`apple-touch-icon`
hrefs in `index.html` at build time — so the same files work under `/footprint/`
(Pages) and `/` (desktop/dev). `deploy.yml` only triggers on push to `main`;
PRs instead run `.github/workflows/ci.yml` (`npm run build`) as a merge gate —
there is **no PR preview deploy**, so the live site is the first place merged UI
renders.

## Conventions & gotchas

- **No framework, no JSX.** Keep to plain TypeScript + direct DOM manipulation to
  match the existing style. State lives in module-level variables in `main.ts`.
- **Browser vs. Tauri:** feature-detect with `isTauri()` (checks
  `__TAURI_INTERNALS__`). Any save/write path must guard against browser mode.
  Browser imports are **session-only previews**: the pipeline runs in memory,
  the map updates, and a "Preview — not saved" badge shows until reload —
  nothing is persisted and the raw file is not archived.
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
- **Lazy-loaded datasets:** don't revert `layers.ts` to eagerly loading all three
  GeoJSON — `states.geojson` is ~8.5 MB gzipped, so eager loading badly slows
  startup (especially on mobile). Add new heavy layers via the same `ensure*` +
  `setLayer` pattern.
- **Turf imports:** import from specific `@turf/*` sub-packages, never the
  `@turf/turf` umbrella, to keep the installed dependency tree small.

## Decided against

- **Time dimension** (year slider / "new this year"). Scrapped June 2026, not
  just deferred: the user's Google Timeline data only starts ~Sept 2025, so
  lifetime "first visited" semantics would be misleading, and the per-visit
  timestamp plumbing isn't worth carrying for a feature that may never ship.
  Nothing irreversible is lost — raw imports are archived to `timeline-raw/`,
  so timestamps can be re-derived by re-importing if older history is ever
  backfilled. Don't re-propose without that backfill.
- **Geometric simplification** of the reference GeoJSON (vertex removal).
  Coordinate-precision trimming and property pruning are done (see
  `scripts/trim-geojson.mjs`); simplification would coarsen polygon boundaries
  when zoomed in, and the user wants city-level map quality kept intact.

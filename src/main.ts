import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/styles.css";
import maplibregl from "maplibre-gl";
import { setupDropzone } from "./import/dropzone";
import { joinVisits, nearestCity } from "./geo/spatialJoin";
import { loadVisited, saveVisited, saveRawImport, mergeVisited, isTauri } from "./store/visitedFile";
import { createMap, setMapTheme, setProjection, type MapTheme, type MapProjection } from "./map/map";
import { initLayers, setLayer, applyLayer, initInteractions, setToggleHandler, setVenueStateHandler, setHomeHandler, setHomePoint, flyToFeature, openFeaturePopup } from "./map/layers";
import { renderStats } from "./ui/sidebar";
import { initSearch } from "./ui/search";
import { initChecklist } from "./ui/checklist";
import { showToast } from "./ui/toast";
import { saveSnapshot } from "./ui/snapshot";
import { countCountries, countContinents, countsByContinent, cityExtremes, furthestCities, maxCityDistance, loadCities } from "./geo/datasets";
import type { LayerKind, BinaryLayerKind, VenueState, VisitedFile } from "./types";

const THEME_KEY = "footprint.theme";
const SIDEBAR_KEY = "footprint.sidebar";
const PROJECTION_KEY = "footprint.projection";
const MOBILE_BREAKPOINT = 768;

function loadTheme(): MapTheme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "dark" ? "dark" : "light";
}
function saveTheme(theme: MapTheme) {
  localStorage.setItem(THEME_KEY, theme);
}
function applyThemeToDocument(theme: MapTheme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function loadProjection(): MapProjection {
  return localStorage.getItem(PROJECTION_KEY) === "globe" ? "globe" : "flat";
}
function saveProjection(projection: MapProjection) {
  localStorage.setItem(PROJECTION_KEY, projection);
}

let currentTheme = loadTheme();
applyThemeToDocument(currentTheme);
let currentProjection = loadProjection();

const appEl = document.getElementById("app") as HTMLElement;
const sidebarToggleBtn = document.getElementById("sidebar-toggle") as HTMLButtonElement;
const sidebarBackdrop = document.getElementById("sidebar-backdrop") as HTMLElement;

function isMobile(): boolean {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

function initialSidebarState(): "open" | "closed" {
  if (isMobile()) return "closed";
  const saved = localStorage.getItem(SIDEBAR_KEY);
  return saved === "closed" ? "closed" : "open";
}

function setSidebar(state: "open" | "closed", persist = true) {
  appEl.setAttribute("data-sidebar", state);
  sidebarToggleBtn.setAttribute("aria-expanded", state === "open" ? "true" : "false");
  if (persist && !isMobile()) {
    localStorage.setItem(SIDEBAR_KEY, state);
  }
}

setSidebar(initialSidebarState(), false);

function nudgeMapResize() {
  // Resize during and after the CSS transition so MapLibre fills the new container.
  requestAnimationFrame(() => map?.resize());
  setTimeout(() => map?.resize(), 150);
  setTimeout(() => map?.resize(), 300);
}

sidebarToggleBtn.addEventListener("click", () => {
  const next = appEl.getAttribute("data-sidebar") === "open" ? "closed" : "open";
  setSidebar(next);
  nudgeMapResize();
});

sidebarBackdrop.addEventListener("click", () => {
  setSidebar("closed");
  nudgeMapResize();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isMobile() && appEl.getAttribute("data-sidebar") === "open") {
    setSidebar("closed");
    nudgeMapResize();
  }
});

let wasMobile = isMobile();
window.addEventListener("resize", () => {
  const nowMobile = isMobile();
  if (nowMobile !== wasMobile) {
    wasMobile = nowMobile;
    setSidebar(nowMobile ? "closed" : (localStorage.getItem(SIDEBAR_KEY) === "closed" ? "closed" : "open"), false);
  }
  nudgeMapResize();
});

const dropzoneEl = document.getElementById("dropzone") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const statsEl = document.getElementById("stats") as HTMLElement;
const togglesEl = document.getElementById("layer-toggles") as HTMLElement;
const mapEl = document.getElementById("map") as HTMLElement;

const previewBadge = document.getElementById("preview-badge") as HTMLElement;

const map = createMap(mapEl, currentTheme);
const themeToggleBtn = document.getElementById("theme-toggle") as HTMLButtonElement;
const globeToggleBtn = document.getElementById("globe-toggle") as HTMLButtonElement;
const snapshotBtn = document.getElementById("snapshot-btn") as HTMLButtonElement;

// Apply the current projection to the map and reflect it on the toggle button.
// Called on first load and re-called after each theme change, since setStyle
// resets the projection to mercator (projection is part of the style).
function applyProjection() {
  setProjection(map, currentProjection);
  globeToggleBtn.setAttribute("aria-pressed", currentProjection === "globe" ? "true" : "false");
}

let mapReady = false;
const onMapReady = new Promise<void>((resolve) => {
  map.on("load", () => {
    mapReady = true;
    map.resize();
    applyProjection();
    resolve();
  });
});

// Pin the map's canvas to the live container size — flex children sometimes
// settle at the wrong dimensions before MapLibre's internal observer fires.
new ResizeObserver(() => map.resize()).observe(mapEl);

let current: VisitedFile = { countries: [], states: [], cities: [], parks: [], fbs: {}, fcs: {}, mlb: [], updatedAt: 0 };

// US states use ISO 3166-2 "US-XX" codes; DC isn't a state, so it's excluded.
// Returns null when none are visited, which hides the U.S. progress row.
function countUsStates(states: string[]): number | null {
  let n = 0;
  for (const s of states) {
    if (s.startsWith("US-") && s !== "US-DC") n++;
  }
  return n > 0 ? n : null;
}

// Uniform "is this id visited" check across all LayerKinds, used by search
// results and the checklist. fbs/fcs are tri-state records (presence of the
// key means visited, regardless of which of the 3 states), everything else is
// a plain string[] membership check.
function isVisitedAny(kind: LayerKind, id: string): boolean {
  if (kind === "fbs") return id in current.fbs;
  if (kind === "fcs") return id in current.fcs;
  return current[kind].includes(id);
}

function statsFrom(file: VisitedFile) {
  return {
    countries: countCountries(file.countries),
    states: file.states.length,
    cities: file.cities.length,
    parks: file.parks.length,
    // Any of the 3 VenueStates counts toward the totalizer — "been to campus"
    // still means the stadium's been visited, same as "been to a game there".
    // FCS/MLB deliberately have no equivalent stat (search/mark-only, per Justin).
    fbs: Object.keys(file.fbs).length,
    continents: countContinents(file.countries),
    usStates: countUsStates(file.states),
    continentBreakdown: countsByContinent(file.countries),
    extremes: cityExtremes(file.cities),
    furthest: furthestCities(file.home, file.cities),
    maxDistance: maxCityDistance(file.cities),
  };
}

async function renderFromCurrent() {
  // Toggle the empty-state onboarding up front (before the map finishes loading)
  // so first-run guidance shows immediately; hidden as soon as any data exists.
  const hasData =
    current.countries.length > 0 || current.states.length > 0 || current.cities.length > 0 || current.parks.length > 0 ||
    Object.keys(current.fbs).length > 0 || Object.keys(current.fcs).length > 0 || current.mlb.length > 0;
  appEl.setAttribute("data-empty", hasData ? "false" : "true");
  if (!mapReady) await onMapReady;
  await initLayers(map, {
    visitedCountries: new Set(current.countries),
    visitedStates: new Set(current.states),
    visitedCities: new Set(current.cities),
    visitedParks: new Set(current.parks),
    visitedMlb: new Set(current.mlb),
    fbsState: new Map(Object.entries(current.fbs) as [string, VenueState][]),
    fcsState: new Map(Object.entries(current.fcs) as [string, VenueState][]),
  });
  if (hasData) {
    renderStats(statsEl, statsFrom(current));
    togglesEl.hidden = false;
    snapshotBtn.hidden = false;
  }
  updateHomeMarker();
  // Keep the layer module's home state current so popups can show a "Your home"
  // badge on the home city instead of a redundant "Set as home" button.
  setHomePoint(current.home ?? null);
  // No-op if the "Browse & mark" modal isn't open; keeps its checkboxes/counts
  // in sync if it's left open across an import or a map-popup toggle.
  checklist.refresh();
}

// A house marker at the home pin. Markers live in the map's DOM container, not the
// GL style, so they survive the style rebuild a theme toggle triggers — this just
// keeps position/label in sync (and removes the marker if home is cleared).
let homeMarker: maplibregl.Marker | null = null;
function updateHomeMarker() {
  if (!current.home) {
    homeMarker?.remove();
    homeMarker = null;
    return;
  }
  const { lon, lat, label } = current.home;
  if (!homeMarker) {
    const el = document.createElement("div");
    el.className = "fp-home-marker";
    el.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path fill="currentColor" d="M12 3 3 10.2V21h6v-6h6v6h6V10.2L12 3z"/>
    </svg>`;
    homeMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  } else {
    homeMarker.setLngLat([lon, lat]);
  }
  homeMarker.getElement().title = `Home: ${label}`;
}

// Snap a clicked point to the nearest dataset city and persist it as home. The
// snap is the privacy coarsening — what's stored is a public city centroid, not
// the raw click. Desktop write-mode only (the popup button is hidden in browser).
async function setHome(lng: number, lat: number): Promise<void> {
  const home = await nearestCity(lat, lng);
  if (!home) {
    showToast("Couldn't find a nearby city to set as home.", { variant: "error" });
    return;
  }
  current = await saveVisited({
    countries: current.countries,
    states: current.states,
    cities: current.cities,
    parks: current.parks,
    fbs: current.fbs,
    fcs: current.fcs,
    mlb: current.mlb,
    home,
  });
  await renderFromCurrent();
  showToast(`Home set to ${home.label}.`, { variant: "success" });
}

// Manually flip a place's visited state from its map popup (desktop write-mode).
// Replaces hand-editing visited.json to fix spatial-join misses. `LayerKind`
// values match the VisitedFile keys 1:1, so `kind` indexes the set directly.
// `saveVisited` is desktop-only and the toggle button is hidden in the browser,
// so this never runs in read-only mode. Returns the new visited state.
async function toggleVisited(kind: BinaryLayerKind, id: string): Promise<boolean> {
  const set = new Set(current[kind]);
  const nowVisited = !set.has(id);
  if (nowVisited) set.add(id);
  else set.delete(id);
  current = await saveVisited({
    countries: kind === "countries" ? [...set] : current.countries,
    states: kind === "states" ? [...set] : current.states,
    cities: kind === "cities" ? [...set] : current.cities,
    parks: kind === "parks" ? [...set] : current.parks,
    fbs: current.fbs,
    fcs: current.fcs,
    mlb: kind === "mlb" ? [...set] : current.mlb,
    home: current.home,
  });
  await renderFromCurrent();
  return nowVisited;
}

// Sports Venues (FBS/FCS) tri-state equivalent of toggleVisited: sets `id`'s
// VenueState, or clears it if it's already set to `state` (re-picking the
// active option undoes it — same "click again to unmark" idea the binary
// toggle uses, just with 3 options instead of 1). Returns the new state, or
// null if cleared.
async function setVenueState(kind: "fbs" | "fcs", id: string, state: VenueState): Promise<VenueState | null> {
  const record = { ...current[kind] };
  const cleared = record[id] === state;
  if (cleared) delete record[id];
  else record[id] = state;
  current = await saveVisited({
    countries: current.countries,
    states: current.states,
    cities: current.cities,
    parks: current.parks,
    fbs: kind === "fbs" ? record : current.fbs,
    fcs: kind === "fcs" ? record : current.fcs,
    mlb: current.mlb,
    home: current.home,
  });
  await renderFromCurrent();
  return cleared ? null : state;
}

async function bootstrap() {
  // Offline support, web/PWA build only: sw.js caches the app shell and serves
  // data stale-while-revalidate. Skipped in dev (would fight HMR) and in Tauri
  // (files are already local). Registration is non-blocking and non-fatal.
  if (import.meta.env.PROD && !isTauri() && "serviceWorker" in navigator) {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.error("Service worker registration failed:", err));
  }
  current = await loadVisited();
  await renderFromCurrent();
  initInteractions(map);
  setToggleHandler(toggleVisited);
  setVenueStateHandler(setVenueState);
  setHomeHandler(setHome);
  // Background-prefetch the cities dataset so the city-coordinate stats (extremes,
  // and later furthest-from-home) can compute. Until it resolves `cityExtremes`
  // returns null and those rows stay hidden; once loaded we re-render the stats.
  // This also warms the Cities view. Non-blocking and non-fatal on failure.
  void prefetchCityStats();
}

async function prefetchCityStats() {
  try {
    await loadCities();
  } catch (err) {
    console.error("City-stats prefetch failed:", err);
    return;
  }
  const hasData =
    current.countries.length > 0 || current.states.length > 0 || current.cities.length > 0 || current.parks.length > 0 ||
    Object.keys(current.fbs).length > 0 || Object.keys(current.fcs).length > 0 || current.mlb.length > 0;
  if (hasData) renderStats(statsEl, statsFrom(current));
}

// Human-readable summary of how many *new* places an import added, e.g.
// "Added 4 countries and 11 cities." Returns an "up to date" line when the file
// only contained places already on the map.
function importSummary(added: { countries: number; states: number; cities: number; parks: number }): string {
  const parts: string[] = [];
  if (added.countries) parts.push(countLabel(added.countries, "country", "countries"));
  if (added.states) parts.push(countLabel(added.states, "region", "regions"));
  if (added.cities) parts.push(countLabel(added.cities, "city", "cities"));
  if (added.parks) parts.push(countLabel(added.parks, "national park", "national parks"));
  if (parts.length === 0) return "Already up to date — no new places found.";
  return `Added ${joinClauses(parts)}.`;
}

function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Joins clauses naturally: "a", "a and b", or "a, b, and c".
function joinClauses(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

setupDropzone(dropzoneEl, fileInput, async (result, fileName) => {
  if (result.visits.length === 0 && result.points.length === 0) {
    showToast(`No visits found in ${fileName} — is it a Google Timeline export?`, {
      variant: "error",
      duration: 7000,
    });
    return;
  }
  const joined = await joinVisits(result.visits);
  const merged = mergeVisited(current, {
    countries: joined.visitedCountries,
    states: joined.visitedStates,
    cities: joined.visitedCities,
    parks: joined.visitedParks,
  });
  // Deltas vs. the previous data — computed before `current` is overwritten.
  const added = {
    countries: merged.countries.length - current.countries.length,
    states: merged.states.length - current.states.length,
    cities: merged.cities.length - current.cities.length,
    parks: merged.parks.length - current.parks.length,
  };
  if (isTauri()) {
    current = await saveVisited(merged);
    await saveRawImport(fileName, {
      source: fileName,
      importedAt: Date.now(),
      visits: result.visits,
      points: result.points,
    });
    await renderFromCurrent();
    showToast(importSummary(added), { variant: "success" });
  } else {
    // The browser build can't persist — render the import in-memory as a
    // session-only preview (the Timeline export is created on the phone, so
    // this is the one place it can be seen right away). A persistent badge
    // marks the state as ephemeral; reload returns to the published data.
    current = { ...merged, updatedAt: Date.now() };
    previewBadge.hidden = false;
    await renderFromCurrent();
    showToast(`${importSummary(added)} Preview only — open the desktop app to save.`, {
      variant: "success",
      duration: 7000,
    });
  }
});

const layerInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="layer"]'));

// Switch the map to a view layer, keeping the radio toggles in sync. Driven by
// the radios themselves and by search-result selection. Returns false when the
// dataset failed to load (the caller shouldn't fly to a feature that isn't there).
async function activateLayer(kind: LayerKind): Promise<boolean> {
  const input = layerInputs.find((i) => i.value === kind);
  if (input && !input.checked) input.checked = true;
  const label = input?.closest("label");
  // The dataset isn't on the map yet on first selection (or after a theme
  // rebuild), so show a spinner and lock the toggles while it loads.
  const needsLoad = !map.getSource(kind);
  if (needsLoad) {
    label?.classList.add("loading");
    layerInputs.forEach((i) => (i.disabled = true));
  }
  try {
    await setLayer(map, kind);
    return true;
  } catch (err) {
    console.error(`Failed to load ${kind} layer:`, err);
    showToast(`Could not load the ${kind} map data. Check your connection and try again.`, {
      variant: "error",
    });
    return false;
  } finally {
    if (needsLoad) {
      label?.classList.remove("loading");
      layerInputs.forEach((i) => (i.disabled = false));
    }
  }
}

layerInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    void activateLayer(input.value as LayerKind);
  });
});

// Place search: results come from the same reference datasets the map renders,
// so a selection switches to that result's view, flies to it, and opens the
// standard inspect popup (with the write-mode "Mark visited" button on desktop).
initSearch({
  isVisited: isVisitedAny,
  onSelect: async (hit) => {
    // On mobile the sidebar overlays the whole map — get it out of the way.
    if (isMobile()) {
      setSidebar("closed");
      nudgeMapResize();
    }
    if (!mapReady) await onMapReady;
    if (!(await activateLayer(hit.kind))) return;
    flyToFeature(map, hit.kind, hit.feature);
    // Opened immediately: the popup is anchored geographically, so it glides
    // with the fly-to animation instead of popping in afterwards.
    openFeaturePopup(map, hit.kind, hit.feature);
  },
});

// "Browse & mark visited" list view: Countries and National Parks in full,
// plus North American Regions (Regions worldwide and Cities are too large
// for a usable checklist — 4,596 and 7,342 entries respectively — and stay
// map-click + search only). Every checkbox is just another door into the
// same toggleVisited() persistence the map popups use.
const checklist = initChecklist({
  isVisited: isVisitedAny,
  onToggle: toggleVisited,
  venueState: (kind, id) => current[kind][id],
  onSetVenueState: setVenueState,
  canToggle: isTauri,
});

themeToggleBtn.addEventListener("click", async () => {
  themeToggleBtn.disabled = true;
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  saveTheme(currentTheme);
  applyThemeToDocument(currentTheme);
  await setMapTheme(map, currentTheme);
  // setStyle resets the projection to mercator — restore the chosen one.
  applyProjection();
  await renderFromCurrent();
  themeToggleBtn.disabled = false;
});

globeToggleBtn.addEventListener("click", () => {
  currentProjection = currentProjection === "globe" ? "flat" : "globe";
  saveProjection(currentProjection);
  applyProjection();
});

snapshotBtn.addEventListener("click", async () => {
  snapshotBtn.disabled = true;
  try {
    await captureWorldSnapshot();
  } finally {
    snapshotBtn.disabled = false;
  }
});

// Resolve once the map fires `event`, or after `timeoutMs` as a fallback so a
// snapshot never hangs if `idle` is slow to fire (tiles already cached, etc.).
function mapOnce(event: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    map.once(event, finish);
    setTimeout(finish, timeoutMs);
  });
}

// The world framing for the snapshot: full longitude, latitude trimmed to cut
// most of the empty Arctic/Antarctic that Mercator stretches. Aspect ≈ 1.76, so
// the fixed capture canvas below uses a matching landscape ratio.
const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-180, -60],
  [180, 78],
];
// Fixed off-screen capture size (CSS px), aspect-matched to WORLD_BOUNDS so the
// world fills it with negligible margin. Independent of the live pane, so the
// card frames identically on phone, tablet, and desktop. Backing pixels scale by
// devicePixelRatio, keeping the export crisp.
const SNAP_W = 1200;
const SNAP_H = 680;

// Snapshot always shows the whole flat world with countries filled — the most
// legible, consistent share card, regardless of the live view (globe, a city
// zoom, the Regions layer…). We render the map at a fixed off-screen landscape
// size (a phone's narrow canvas literally can't fit the world at min zoom, so
// cropping the live pane can't work), force the countries layer + flat
// projection, capture, then restore the user's exact view. An overlay hides the
// brief reframe.
async function captureWorldSnapshot(): Promise<void> {
  const cam = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
  const prevLayer = (document.querySelector<HTMLInputElement>('input[name="layer"]:checked')
    ?.value ?? "countries") as LayerKind;
  const mapEl = map.getContainer();
  const prevCss = mapEl.style.cssText;

  const overlay = document.createElement("div");
  overlay.className = "snap-overlay";
  overlay.textContent = "Preparing snapshot…";
  document.body.appendChild(overlay);

  try {
    // Fixed landscape canvas, positioned off to the side and hidden by the
    // overlay. The WebGL buffer still renders and is readable (preserveDrawingBuffer).
    mapEl.style.cssText = `position:fixed;top:0;left:0;width:${SNAP_W}px;height:${SNAP_H}px;`;
    map.resize();

    applyLayer(map, "countries");
    setProjection(map, "flat");
    map.fitBounds(WORLD_BOUNDS, { animate: false, padding: 0 });
    await mapOnce("idle");

    await saveSnapshot(map, {
      // Headline countries = sovereign count, matching the sidebar number.
      countries: countCountries(current.countries),
      states: current.states.length,
      cities: current.cities.length,
    });
  } finally {
    // Restore the live pane size, the user's layer, projection (+ handlers and
    // button state), and the exact camera they were looking at.
    mapEl.style.cssText = prevCss;
    map.resize();
    applyLayer(map, prevLayer);
    applyProjection();
    map.jumpTo(cam);
    overlay.remove();
  }
}

void bootstrap();

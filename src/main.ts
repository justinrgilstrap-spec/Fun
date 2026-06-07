import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/styles.css";
import maplibregl from "maplibre-gl";
import { setupDropzone } from "./import/dropzone";
import { joinVisits, nearestCity } from "./geo/spatialJoin";
import { loadVisited, saveVisited, saveRawImport, mergeVisited } from "./store/visitedFile";
import { createMap, setMapTheme, setProjection, type MapTheme, type MapProjection } from "./map/map";
import { initLayers, setLayer, initInteractions, setToggleHandler, setHomeHandler, setHomePoint } from "./map/layers";
import { renderStats } from "./ui/sidebar";
import { showToast } from "./ui/toast";
import { countCountries, countContinents, countsByContinent, cityExtremes, furthestCity, loadCities } from "./geo/datasets";
import type { LayerKind, VisitedFile } from "./types";

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

const map = createMap(mapEl, currentTheme);
const themeToggleBtn = document.getElementById("theme-toggle") as HTMLButtonElement;
const globeToggleBtn = document.getElementById("globe-toggle") as HTMLButtonElement;

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

let current: VisitedFile = { countries: [], states: [], cities: [], updatedAt: 0 };

// US states use ISO 3166-2 "US-XX" codes; DC isn't a state, so it's excluded.
// Returns null when none are visited, which hides the U.S. progress row.
function countUsStates(states: string[]): number | null {
  let n = 0;
  for (const s of states) {
    if (s.startsWith("US-") && s !== "US-DC") n++;
  }
  return n > 0 ? n : null;
}

function statsFrom(file: VisitedFile) {
  return {
    countries: countCountries(file.countries),
    states: file.states.length,
    cities: file.cities.length,
    continents: countContinents(file.countries),
    usStates: countUsStates(file.states),
    continentBreakdown: countsByContinent(file.countries),
    extremes: cityExtremes(file.cities),
    furthest: furthestCity(file.home, file.cities),
  };
}

async function renderFromCurrent() {
  // Toggle the empty-state onboarding up front (before the map finishes loading)
  // so first-run guidance shows immediately; hidden as soon as any data exists.
  const hasData =
    current.countries.length > 0 || current.states.length > 0 || current.cities.length > 0;
  appEl.setAttribute("data-empty", hasData ? "false" : "true");
  if (!mapReady) await onMapReady;
  await initLayers(map, {
    visitedCountries: new Set(current.countries),
    visitedStates: new Set(current.states),
    visitedCities: new Set(current.cities),
  });
  if (hasData) {
    renderStats(statsEl, statsFrom(current));
    togglesEl.hidden = false;
  }
  updateHomeMarker();
  // Keep the layer module's home state current so popups can show a "Your home"
  // badge on the home city instead of a redundant "Set as home" button.
  setHomePoint(current.home ?? null);
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
async function toggleVisited(kind: LayerKind, id: string): Promise<boolean> {
  const set = new Set(current[kind]);
  const nowVisited = !set.has(id);
  if (nowVisited) set.add(id);
  else set.delete(id);
  current = await saveVisited({
    countries: kind === "countries" ? [...set] : current.countries,
    states: kind === "states" ? [...set] : current.states,
    cities: kind === "cities" ? [...set] : current.cities,
    home: current.home,
  });
  await renderFromCurrent();
  return nowVisited;
}

async function bootstrap() {
  current = await loadVisited();
  await renderFromCurrent();
  initInteractions(map);
  setToggleHandler(toggleVisited);
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
    current.countries.length > 0 || current.states.length > 0 || current.cities.length > 0;
  if (hasData) renderStats(statsEl, statsFrom(current));
}

// Human-readable summary of how many *new* places an import added, e.g.
// "Added 4 countries and 11 cities." Returns an "up to date" line when the file
// only contained places already on the map.
function importSummary(added: { countries: number; states: number; cities: number }): string {
  const parts: string[] = [];
  if (added.countries) parts.push(countLabel(added.countries, "country", "countries"));
  if (added.states) parts.push(countLabel(added.states, "region", "regions"));
  if (added.cities) parts.push(countLabel(added.cities, "city", "cities"));
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
  });
  // Deltas vs. the previous data — computed before `current` is overwritten.
  const added = {
    countries: merged.countries.length - current.countries.length,
    states: merged.states.length - current.states.length,
    cities: merged.cities.length - current.cities.length,
  };
  current = await saveVisited(merged);
  await saveRawImport(fileName, {
    source: fileName,
    importedAt: Date.now(),
    visits: result.visits,
    points: result.points,
  });
  await renderFromCurrent();
  showToast(importSummary(added), { variant: "success" });
});

const layerInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="layer"]'));
layerInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    if (!input.checked) return;
    const kind = input.value as LayerKind;
    const label = input.closest("label");
    // The dataset isn't on the map yet on first selection (or after a theme
    // rebuild), so show a spinner and lock the toggles while it loads.
    const needsLoad = !map.getSource(kind);
    if (needsLoad) {
      label?.classList.add("loading");
      layerInputs.forEach((i) => (i.disabled = true));
    }
    try {
      await setLayer(map, kind);
    } catch (err) {
      console.error(`Failed to load ${kind} layer:`, err);
      alert(`Could not load the ${kind} map data. Check your connection and try again.`);
    } finally {
      if (needsLoad) {
        label?.classList.remove("loading");
        layerInputs.forEach((i) => (i.disabled = false));
      }
    }
  });
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

void bootstrap();

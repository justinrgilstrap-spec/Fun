import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/styles.css";
import { setupDropzone } from "./import/dropzone";
import { joinVisits } from "./geo/spatialJoin";
import { loadVisited, saveVisited, saveRawImport, mergeVisited } from "./store/visitedFile";
import { createMap, setMapTheme, type MapTheme } from "./map/map";
import { initLayers, setLayer, initInteractions } from "./map/layers";
import { renderStats } from "./ui/sidebar";
import { showToast } from "./ui/toast";
import { countCountries, countContinents } from "./geo/datasets";
import type { LayerKind, VisitedFile } from "./types";

const THEME_KEY = "footprint.theme";
const SIDEBAR_KEY = "footprint.sidebar";
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

let currentTheme = loadTheme();
applyThemeToDocument(currentTheme);

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
let mapReady = false;
const onMapReady = new Promise<void>((resolve) => {
  map.on("load", () => {
    mapReady = true;
    map.resize();
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
}

async function bootstrap() {
  current = await loadVisited();
  await renderFromCurrent();
  initInteractions(map);
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
  await renderFromCurrent();
  themeToggleBtn.disabled = false;
});

void bootstrap();

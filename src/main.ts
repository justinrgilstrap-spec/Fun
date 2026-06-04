import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./ui/styles.css";
import { setupDropzone } from "./import/dropzone";
import { joinVisits } from "./geo/spatialJoin";
import { loadVisited, saveVisited, saveRawImport, mergeVisited } from "./store/visitedFile";
import { createMap, setMapTheme, type MapTheme } from "./map/map";
import { initLayers, applyLayer } from "./map/layers";
import { renderStats } from "./ui/sidebar";
import { countCountries } from "./geo/datasets";
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

function statsFrom(file: VisitedFile) {
  return {
    countries: countCountries(file.countries),
    states: file.states.length,
    cities: file.cities.length,
  };
}

async function renderFromCurrent() {
  if (!mapReady) await onMapReady;
  await initLayers(map, {
    visitedCountries: new Set(current.countries),
    visitedStates: new Set(current.states),
    visitedCities: new Set(current.cities),
  });
  if (current.countries.length || current.states.length || current.cities.length) {
    renderStats(statsEl, statsFrom(current));
    togglesEl.hidden = false;
  }
}

async function bootstrap() {
  current = await loadVisited();
  await renderFromCurrent();
}

setupDropzone(dropzoneEl, fileInput, async (result, fileName) => {
  console.log(`Imported ${fileName}: ${result.visits.length} visits, ${result.points.length} points`);
  if (result.visits.length === 0 && result.points.length === 0) {
    alert(`Could not find any visits or location points in ${fileName}.\nMake sure this is a Google Timeline export.`);
    return;
  }
  const joined = await joinVisits(result.visits);
  const merged = mergeVisited(current, {
    countries: joined.visitedCountries,
    states: joined.visitedStates,
    cities: joined.visitedCities,
  });
  current = await saveVisited(merged);
  await saveRawImport(fileName, {
    source: fileName,
    importedAt: Date.now(),
    visits: result.visits,
    points: result.points,
  });
  await renderFromCurrent();
});

document.querySelectorAll<HTMLInputElement>('input[name="layer"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) applyLayer(map, input.value as LayerKind);
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

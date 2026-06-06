import maplibregl, { type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from "geojson";
import { loadCountries, loadStates, loadCities, countryIso, stateIso, cityId } from "../geo/datasets";
import type { LayerKind } from "../types";

interface LayerState {
  visitedCountries: Set<string>;
  visitedStates: Set<string>;
  visitedCities: Set<string>;
}

let currentLayer: LayerKind = "countries";

// Latest visited sets, kept at module scope so lazily-loaded layers (and layers
// rebuilt after a theme change) can be tagged with the right data.
let layerState: LayerState = {
  visitedCountries: new Set(),
  visitedStates: new Set(),
  visitedCities: new Set(),
};

const VISITED_FILL = "#CC6B49";
const VISITED_OUTLINE = "#A85436";
const NOT_VISITED_FILL = "#1E5F8A";
const NOT_VISITED_OUTLINE = "#3D7BA8";

const visitedFillExpr = ["case", ["==", ["get", "visited"], 1], VISITED_FILL, NOT_VISITED_FILL] as unknown as maplibregl.PropertyValueSpecification<string>;
const visitedOutlineExpr = ["case", ["==", ["get", "visited"], 1], VISITED_OUTLINE, NOT_VISITED_OUTLINE] as unknown as maplibregl.PropertyValueSpecification<string>;
const visitedOpacityExpr = ["case", ["==", ["get", "visited"], 1], 0.55, 0.0] as unknown as maplibregl.PropertyValueSpecification<number>;

function tagVisited<T extends Feature<Polygon | MultiPolygon> | Feature<Point>>(
  features: T[],
  visited: Set<string>,
  getId: (f: Feature) => string,
): T[] {
  return features.map((f) => ({
    ...f,
    properties: { ...(f.properties ?? {}), visited: visited.has(getId(f)) ? 1 : 0 },
  }));
}

// Build a tagged FeatureCollection from the (cached) dataset and current visited
// sets. The loader caches the heavy GeoJSON, so these are cheap after first call.
async function taggedCountries(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const countries = await loadCountries();
  return { type: "FeatureCollection", features: tagVisited(countries.features, layerState.visitedCountries, countryIso) };
}
async function taggedStates(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const states = await loadStates();
  return { type: "FeatureCollection", features: tagVisited(states.features, layerState.visitedStates, stateIso) };
}
async function taggedCities(): Promise<FeatureCollection<Point>> {
  const cities = await loadCities();
  return { type: "FeatureCollection", features: tagVisited(cities.features, layerState.visitedCities, cityId) };
}

// Add a dataset's source + layers if they aren't on the map yet; no-op when they
// already exist, so switching back to a loaded layer is instant. The first call
// for states/cities is what triggers their (lazy) download.
// The vector basemap stacks all its text in symbol layers on top. Insert our
// choropleth fills/dots just beneath the first of them so place labels stay
// legible above the visited shading. Returns undefined if the style has no symbol
// layer (then addLayer appends on top, which is still fine).
function labelBeforeId(map: MlMap): string | undefined {
  return map.getStyle().layers?.find((l: maplibregl.LayerSpecification) => l.type === "symbol")?.id;
}

async function ensureCountries(map: MlMap): Promise<void> {
  if (map.getSource("countries")) return;
  map.addSource("countries", { type: "geojson", data: await taggedCountries() });
  const before = labelBeforeId(map);
  map.addLayer({
    id: "countries-fill",
    type: "fill",
    source: "countries",
    paint: { "fill-color": visitedFillExpr, "fill-opacity": visitedOpacityExpr },
  }, before);
  map.addLayer({
    id: "countries-line",
    type: "line",
    source: "countries",
    paint: { "line-color": visitedOutlineExpr, "line-width": 0.6, "line-opacity": 0.8 },
  }, before);
}
async function ensureStates(map: MlMap): Promise<void> {
  if (map.getSource("states")) return;
  map.addSource("states", { type: "geojson", data: await taggedStates() });
  const before = labelBeforeId(map);
  map.addLayer({
    id: "states-fill",
    type: "fill",
    source: "states",
    paint: { "fill-color": visitedFillExpr, "fill-opacity": visitedOpacityExpr },
  }, before);
  map.addLayer({
    id: "states-line",
    type: "line",
    source: "states",
    paint: { "line-color": visitedOutlineExpr, "line-width": 0.4, "line-opacity": 0.6 },
  }, before);
}
async function ensureCities(map: MlMap): Promise<void> {
  if (map.getSource("cities")) return;
  map.addSource("cities", { type: "geojson", data: await taggedCities() });
  map.addLayer({
    id: "cities-circle",
    type: "circle",
    source: "cities",
    filter: ["==", ["get", "visited"], 1],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 6, 6, 10, 10],
      "circle-color": VISITED_FILL,
      "circle-stroke-color": VISITED_OUTLINE,
      "circle-stroke-width": 1,
      "circle-opacity": 0.85,
    },
  }, labelBeforeId(map));
}

const ENSURE: Record<LayerKind, (map: MlMap) => Promise<void>> = {
  countries: ensureCountries,
  states: ensureStates,
  cities: ensureCities,
};

// Push the latest visited sets into whatever sources are already on the map
// (e.g. after an import adds new places). Datasets not yet loaded stay lazy.
async function refreshLoadedData(map: MlMap): Promise<void> {
  const countries = map.getSource("countries") as maplibregl.GeoJSONSource | undefined;
  if (countries) countries.setData(await taggedCountries());
  const states = map.getSource("states") as maplibregl.GeoJSONSource | undefined;
  if (states) states.setData(await taggedStates());
  const cities = map.getSource("cities") as maplibregl.GeoJSONSource | undefined;
  if (cities) cities.setData(await taggedCities());
}

export async function initLayers(map: MlMap, state: LayerState): Promise<void> {
  layerState = state;
  // Countries supply the base outline shown in every view, so always load them.
  await ensureCountries(map);
  // Restore a non-default selection (e.g. after a theme change rebuilds the style).
  if (currentLayer !== "countries") {
    await ENSURE[currentLayer](map);
  }
  // Reflect updated visited sets in any already-loaded sources.
  await refreshLoadedData(map);
  applyLayer(map, currentLayer);
}

/**
 * Switch to a layer, lazily fetching its dataset the first time it's needed.
 * The heavy states/cities GeoJSON is only downloaded when the user opens that view.
 */
export async function setLayer(map: MlMap, kind: LayerKind): Promise<void> {
  // A pinned popup describes a feature in the layer that was active when it was
  // opened; once the view changes it's stale (the same spot now resolves to a
  // different feature), so dismiss it. A theme toggle deliberately keeps the
  // popup — it changes how the map is drawn, not what's being inspected.
  popup?.remove();
  popup = null;
  await ensureCountries(map);
  if (kind !== "countries") {
    await ENSURE[kind](map);
  }
  applyLayer(map, kind);
}

const ALL_LAYER_IDS = [
  "countries-fill",
  "countries-line",
  "states-fill",
  "states-line",
  "cities-circle",
];

const VISIBLE_BY_LAYER: Record<LayerKind, string[]> = {
  countries: ["countries-fill", "countries-line"],
  states: ["countries-line", "states-fill", "states-line"],
  cities: ["countries-line", "cities-circle"],
};

export function applyLayer(map: MlMap, kind: LayerKind): void {
  currentLayer = kind;
  const visible = new Set(VISIBLE_BY_LAYER[kind]);
  for (const id of ALL_LAYER_IDS) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, "visibility", visible.has(id) ? "visible" : "none");
  }
}

// --- Click-to-inspect popups ------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function popupHTML(title: string, subtitle: string, visited: boolean): string {
  const sub = subtitle ? `<div class="fp-popup-sub">${escapeHtml(subtitle)}</div>` : "";
  const status = visited
    ? `<div class="fp-popup-status is-visited">Visited</div>`
    : `<div class="fp-popup-status">Not visited yet</div>`;
  return `<div class="fp-popup"><div class="fp-popup-title">${escapeHtml(title)}</div>${sub}${status}</div>`;
}

function str(props: Record<string, unknown> | null, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(", ");
}

// A stable identity for a clicked feature, so a second click on the same
// feature can toggle its popup shut. Keyed on the same properties the popup
// renders, prefixed by layer kind so ids never collide across layers.
function featureKey(kind: LayerKind, props: Record<string, unknown> | null): string {
  if (kind === "countries") {
    return `countries:${str(props, "NAME") || str(props, "ADMIN")}`;
  }
  if (kind === "states") {
    return `states:${joinParts([str(props, "name"), str(props, "admin")])}`;
  }
  return `cities:${joinParts([str(props, "NAMEASCII") || str(props, "NAME"), str(props, "ADM1NAME"), str(props, "ADM0NAME")])}`;
}

// Builds the popup body for a clicked feature, per layer's property scheme.
function contentFor(kind: LayerKind, props: Record<string, unknown> | null): string {
  const visited = props?.visited === 1;
  if (kind === "countries") {
    const continent = str(props, "CONTINENT");
    return popupHTML(
      str(props, "NAME") || str(props, "ADMIN") || "Unknown",
      continent === "Seven seas (open ocean)" ? "" : continent,
      visited,
    );
  }
  if (kind === "states") {
    return popupHTML(
      str(props, "name") || "Unknown",
      joinParts([str(props, "type_en"), str(props, "admin")]),
      visited,
    );
  }
  return popupHTML(
    str(props, "NAME") || str(props, "NAMEASCII") || "Unknown",
    joinParts([str(props, "ADM1NAME"), str(props, "ADM0NAME")]),
    visited,
  );
}

let popup: maplibregl.Popup | null = null;
// Identity of the feature whose popup is currently pinned, so re-clicking it
// closes rather than re-pins. Cleared whenever the popup closes (✕, empty-map
// click, theme rebuild).
let pinnedId: string | null = null;
let interactionsReady = false;

// Wire click + hover-cursor handlers once. Registering by layer id works even
// before the (lazy) layer exists, and the listeners live on the Map, so they
// survive the style rebuild a theme change triggers — hence register-once.
const CLICK_LAYERS: Array<[string, LayerKind]> = [
  ["countries-fill", "countries"],
  ["states-fill", "states"],
  ["cities-circle", "cities"],
];

export function initInteractions(map: MlMap): void {
  if (interactionsReady) return;
  interactionsReady = true;

  // The most recent click an open-popup handled, so the map-level close handler
  // below can tell "clicked off onto empty map" (close) from "a feature handler
  // already dealt with this click" (leave it alone). Both fire on one click and
  // share the same event object, so identity comparison is reliable.
  let handledClick: unknown = null;

  for (const [layerId, kind] of CLICK_LAYERS) {
    map.on("click", layerId, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      handledClick = e;
      const id = featureKey(kind, feature.properties as Record<string, unknown> | null);
      // Re-click on the already-pinned feature: dismiss it, don't re-pin.
      if (id === pinnedId) {
        popup?.remove();
        return;
      }
      // Point features sit on a precise spot; anchor the popup there. Polygons
      // are anchored at the click location.
      const lngLat =
        feature.geometry.type === "Point"
          ? (feature.geometry.coordinates as [number, number])
          : e.lngLat;
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "240px" })
        .setLngLat(lngLat)
        .setHTML(contentFor(kind, feature.properties as Record<string, unknown> | null))
        .addTo(map);
      pinnedId = id;
      // Keep pinnedId in sync however the popup closes (✕, re-click, replaced).
      popup.on("close", () => {
        if (pinnedId === id) pinnedId = null;
      });
    });
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  // Replaces MapLibre's closeOnClick: clicking empty map dismisses the popup,
  // but a click already handled by a feature layer above is left alone. This
  // handler is registered after the layer handlers, so it sees their result.
  map.on("click", (e) => {
    if (e === handledClick) return;
    popup?.remove();
  });
}

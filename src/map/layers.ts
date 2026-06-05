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
async function ensureCountries(map: MlMap): Promise<void> {
  if (map.getSource("countries")) return;
  map.addSource("countries", { type: "geojson", data: await taggedCountries() });
  map.addLayer({
    id: "countries-fill",
    type: "fill",
    source: "countries",
    paint: { "fill-color": visitedFillExpr, "fill-opacity": visitedOpacityExpr },
  });
  map.addLayer({
    id: "countries-line",
    type: "line",
    source: "countries",
    paint: { "line-color": visitedOutlineExpr, "line-width": 0.6, "line-opacity": 0.8 },
  });
}
async function ensureStates(map: MlMap): Promise<void> {
  if (map.getSource("states")) return;
  map.addSource("states", { type: "geojson", data: await taggedStates() });
  map.addLayer({
    id: "states-fill",
    type: "fill",
    source: "states",
    paint: { "fill-color": visitedFillExpr, "fill-opacity": visitedOpacityExpr },
  });
  map.addLayer({
    id: "states-line",
    type: "line",
    source: "states",
    paint: { "line-color": visitedOutlineExpr, "line-width": 0.4, "line-opacity": 0.6 },
  });
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
  });
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

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from "geojson";
import { loadCountries, loadStates, loadCities, countryIso, stateIso, cityId } from "../geo/datasets";
import { isTauri } from "../store/visitedFile";
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
// Fill opacity, lifted a touch on hover. Hovering a visited place brightens it;
// hovering an unvisited one fades in a faint wash so the whole map feels live.
// The resting (non-hover) values are unchanged from before.
const visitedOpacityExpr = [
  "case",
  ["boolean", ["feature-state", "hover"], false],
  ["case", ["==", ["get", "visited"], 1], 0.72, 0.18],
  ["case", ["==", ["get", "visited"], 1], 0.55, 0.0],
] as unknown as maplibregl.PropertyValueSpecification<number>;

function tagVisited<T extends Feature<Polygon | MultiPolygon> | Feature<Point>>(
  features: T[],
  visited: Set<string>,
  getId: (f: Feature) => string,
): T[] {
  // The index doubles as the feature id so hover feature-state can target it.
  return features.map((f, i) => ({
    ...f,
    id: i,
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
  // No `visited` filter: unvisited cities stay in the layer so they're clickable
  // for marking (desktop write-mode). They're kept invisible (radius 0) until
  // zoomed in, then fade in as faint, small dots — a circle with radius 0 isn't
  // hit-tested, so zoomed-out clicks can't accidentally land on a hidden city.
  // Visited dots are unchanged: visible and clickable at every zoom.
  map.addLayer({
    id: "cities-circle",
    type: "circle",
    source: "cities",
    paint: {
      // One top-level zoom curve (MapLibre allows only one, and `zoom` can't sit
      // inside a `case`). Each stop's value is a per-feature `case`: visited dots
      // keep the original 3→10 curve; unvisited stay at radius 0 until zoom 6,
      // then grow to a small dot. Radius 0 means invisible AND not hit-tested, so
      // zoomed out there are no stray click targets.
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        1, ["case", ["==", ["get", "visited"], 1], 3, 0],
        6, ["case", ["==", ["get", "visited"], 1], 6, 0],
        7.5, ["case", ["==", ["get", "visited"], 1], 7.5, 3],
        10, ["case", ["==", ["get", "visited"], 1], 10, 4.5],
        12, ["case", ["==", ["get", "visited"], 1], 10, 5.5],
      ],
      // Unvisited dots use the brighter outline blue as their fill so they read
      // against the dark basemap (the dimmer NOT_VISITED_FILL is near-invisible here).
      "circle-color": ["case", ["==", ["get", "visited"], 1], VISITED_FILL, NOT_VISITED_OUTLINE],
      "circle-stroke-color": ["case", ["==", ["get", "visited"], 1], VISITED_OUTLINE, NOT_VISITED_OUTLINE],
      "circle-stroke-width": ["case", ["==", ["get", "visited"], 1], 1, 0.5],
      // Constant per-state opacity — unvisited dots are subdued but findable. No
      // zoom term needed: the radius curve already keeps them hidden below zoom 6.
      "circle-opacity": ["case", ["==", ["get", "visited"], 1], 0.85, 0.6],
      "circle-stroke-opacity": ["case", ["==", ["get", "visited"], 1], 0.85, 0.6],
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

function popupHTML(title: string, subtitle: string, visited: boolean, canToggle: boolean): string {
  const sub = subtitle ? `<div class="fp-popup-sub">${escapeHtml(subtitle)}</div>` : "";
  const status = visited
    ? `<div class="fp-popup-status is-visited">Visited</div>`
    : `<div class="fp-popup-status">Not visited yet</div>`;
  // Desktop write-mode only: a button to manually fix spatial-join misses without
  // re-importing. Hidden in the read-only browser build (`canToggle` is false).
  const toggle = canToggle
    ? `<button type="button" class="fp-popup-toggle">${visited ? "Unmark visited" : "Mark visited"}</button>`
    : "";
  return `<div class="fp-popup"><div class="fp-popup-title">${escapeHtml(title)}</div>${sub}${status}${toggle}</div>`;
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
function contentFor(kind: LayerKind, props: Record<string, unknown> | null, canToggle: boolean): string {
  const visited = props?.visited === 1;
  if (kind === "countries") {
    const continent = str(props, "CONTINENT");
    return popupHTML(
      str(props, "NAME") || str(props, "ADMIN") || "Unknown",
      continent === "Seven seas (open ocean)" ? "" : continent,
      visited,
      canToggle,
    );
  }
  if (kind === "states") {
    return popupHTML(
      str(props, "name") || "Unknown",
      joinParts([str(props, "type_en"), str(props, "admin")]),
      visited,
      canToggle,
    );
  }
  return popupHTML(
    str(props, "NAME") || str(props, "NAMEASCII") || "Unknown",
    joinParts([str(props, "ADM1NAME"), str(props, "ADM0NAME")]),
    visited,
    canToggle,
  );
}

// The "visited" key for a feature — the same ID scheme used by the visited sets,
// so a toggle flips the exact entry an import would have added. (featureKey above
// is for popup-open identity; this is the persisted dataset ID.)
function visitedId(kind: LayerKind, feature: Feature): string {
  if (kind === "countries") return countryIso(feature);
  if (kind === "states") return stateIso(feature);
  return cityId(feature);
}

// Registered by main.ts (which owns the persisted `current` file). Flips the ID,
// saves, re-tags the map + stats, and resolves to the new visited state so the
// popup can re-render. Null in the browser build (no toggle button is shown).
type ToggleHandler = (kind: LayerKind, id: string) => Promise<boolean>;
let toggleHandler: ToggleHandler | null = null;
export function setToggleHandler(fn: ToggleHandler): void {
  toggleHandler = fn;
}

// Bind the popup's Mark/Unmark button. After a toggle, `setHTML` rebuilds the
// popup DOM with the flipped state, so we re-wire (the `{ once: true }` listener
// has already spent itself). The handler re-tags the map + stats; here we only
// refresh the popup so its button + status flip immediately.
function wirePopupToggle(p: maplibregl.Popup, kind: LayerKind, feature: Feature): void {
  const btn = p.getElement()?.querySelector<HTMLButtonElement>(".fp-popup-toggle");
  if (!btn) return;
  btn.addEventListener(
    "click",
    async () => {
      if (!toggleHandler) return;
      btn.disabled = true;
      const nowVisited = await toggleHandler(kind, visitedId(kind, feature));
      const props = { ...(feature.properties ?? {}), visited: nowVisited ? 1 : 0 };
      p.setHTML(contentFor(kind, props, true));
      wirePopupToggle(p, kind, feature);
    },
    { once: true },
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
      const canToggle = isTauri();
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "240px" })
        .setLngLat(lngLat)
        .setHTML(contentFor(kind, feature.properties as Record<string, unknown> | null, canToggle))
        .addTo(map);
      pinnedId = id;
      if (canToggle) wirePopupToggle(popup, kind, feature as unknown as Feature);
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

  // Subtle hover highlight via feature-state. The polygon fills read
  // ["feature-state","hover"] in their opacity expression, so we just flag the
  // feature under the cursor. Cities are small dots, so only countries/regions
  // get the effect. Only the active layer is visible, so at most one fires.
  const HOVER_LAYERS: Array<[string, string]> = [
    ["countries-fill", "countries"],
    ["states-fill", "states"],
  ];
  let hovered: { source: string; id: string | number } | null = null;
  const clearHover = () => {
    if (hovered) {
      map.setFeatureState(hovered, { hover: false });
      hovered = null;
    }
  };
  for (const [layerId, source] of HOVER_LAYERS) {
    map.on("mousemove", layerId, (e) => {
      const f = e.features?.[0];
      if (f == null || f.id == null) return;
      if (hovered && hovered.source === source && hovered.id === f.id) return;
      clearHover();
      hovered = { source, id: f.id };
      map.setFeatureState(hovered, { hover: true });
    });
    map.on("mouseleave", layerId, clearHover);
  }

  // Replaces MapLibre's closeOnClick: clicking empty map dismisses the popup,
  // but a click already handled by a feature layer above is left alone. This
  // handler is registered after the layer handlers, so it sees their result.
  map.on("click", (e) => {
    if (e === handledClick) return;
    popup?.remove();
  });
}

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from "geojson";
import {
  loadCountries, loadStates, loadCities, loadParks, loadFbs, loadFcs, loadMlb,
  countryIso, stateIso, cityId, parkId,
  fbsId, fcsId, mlbId,
} from "../geo/datasets";
import { isTauri } from "../store/visitedFile";
import type { LayerKind, BinaryLayerKind, HomePoint, VenueState } from "../types";

interface LayerState {
  visitedCountries: Set<string>;
  visitedStates: Set<string>;
  visitedCities: Set<string>;
  visitedParks: Set<string>;
  visitedMlb: Set<string>;
  // Sports Venues tri-state: presence in the map means a state is set, absence
  // means unvisited. Unlike the Sets above there's no "toggle" — main.ts's
  // setVenueState either sets an entry to a specific VenueState or deletes it.
  fbsState: Map<string, VenueState>;
  fcsState: Map<string, VenueState>;
}

// Maps a *binary* LayerKind to its LayerState Set key, so code that has to loop
// over "every binary kind" (initLayers below) doesn't need a hand-written
// ternary per kind. fbs/fcs are deliberately excluded — their tri-state maps
// are handled by their own dedicated logic throughout this file.
const KIND_SET: Record<BinaryLayerKind, keyof Pick<LayerState, "visitedCountries" | "visitedStates" | "visitedCities" | "visitedParks" | "visitedMlb">> = {
  countries: "visitedCountries",
  states: "visitedStates",
  cities: "visitedCities",
  parks: "visitedParks",
  mlb: "visitedMlb",
};

let currentLayer: LayerKind = "countries";

// Latest visited sets, kept at module scope so lazily-loaded layers (and layers
// rebuilt after a theme change) can be tagged with the right data.
let layerState: LayerState = {
  visitedCountries: new Set(),
  visitedStates: new Set(),
  visitedCities: new Set(),
  visitedParks: new Set(),
  visitedMlb: new Set(),
  fbsState: new Map(),
  fcsState: new Map(),
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
async function taggedParks(): Promise<FeatureCollection<Polygon | MultiPolygon>> {
  const parks = await loadParks();
  return { type: "FeatureCollection", features: tagVisited(parks.features, layerState.visitedParks, parkId) };
}
async function taggedMlb(): Promise<FeatureCollection<Point>> {
  const mlb = await loadMlb();
  return { type: "FeatureCollection", features: tagVisited(mlb.features, layerState.visitedMlb, mlbId) };
}

// Sports Venues (FBS/FCS) color coding, per Justin: yellow = been to campus,
// blue = been inside the stadium, purple = been to a game there. Not-visited
// uses a neutral gray rather than the app's usual NOT_VISITED_FILL/OUTLINE
// blues, because "stadium" is already blue here — reusing the geography
// layers' not-visited blue would make an unvisited school and a
// been-in-the-stadium school look identical at a glance.
const VENUE_COLOR: Record<VenueState, string> = {
  campus: "#D9B84A",
  stadium: "#3D7BA8",
  game: "#8E5FBF",
};
const VENUE_NEUTRAL = "#6B7280";
const VENUE_STATE_CODE: Record<VenueState, number> = { campus: 1, stadium: 2, game: 3 };

function venueStateExpr(colorFor: (code: number) => string) {
  return [
    "case",
    ["==", ["get", "state"], 1], colorFor(1),
    ["==", ["get", "state"], 2], colorFor(2),
    ["==", ["get", "state"], 3], colorFor(3),
    colorFor(0),
  ] as unknown as maplibregl.PropertyValueSpecification<string>;
}
const venueFillExpr = venueStateExpr((code) =>
  code === 1 ? VENUE_COLOR.campus : code === 2 ? VENUE_COLOR.stadium : code === 3 ? VENUE_COLOR.game : VENUE_NEUTRAL,
);

// Tags each feature with a `state` property: 0 (unvisited) or the VENUE_STATE_CODE
// for whatever VenueState is recorded for that id. Parallel to tagVisited, but
// reading a Map<string,VenueState> instead of a Set<string>.
function tagVenueState<T extends Feature<Point>>(
  features: T[],
  state: Map<string, VenueState>,
  getId: (f: Feature) => string,
): T[] {
  return features.map((f, i) => {
    const v = state.get(getId(f));
    return {
      ...f,
      id: i,
      properties: { ...(f.properties ?? {}), state: v ? VENUE_STATE_CODE[v] : 0 },
    };
  });
}

async function taggedFbs(): Promise<FeatureCollection<Point>> {
  const fbs = await loadFbs();
  return { type: "FeatureCollection", features: tagVenueState(fbs.features, layerState.fbsState, fbsId) };
}
async function taggedFcs(): Promise<FeatureCollection<Point>> {
  const fcs = await loadFcs();
  return { type: "FeatureCollection", features: tagVenueState(fcs.features, layerState.fcsState, fcsId) };
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
async function ensureParks(map: MlMap): Promise<void> {
  if (map.getSource("parks")) return;
  map.addSource("parks", { type: "geojson", data: await taggedParks() });
  const before = labelBeforeId(map);
  map.addLayer({
    id: "parks-fill",
    type: "fill",
    source: "parks",
    paint: { "fill-color": visitedFillExpr, "fill-opacity": visitedOpacityExpr },
  }, before);
  map.addLayer({
    id: "parks-line",
    type: "line",
    source: "parks",
    paint: { "line-color": visitedOutlineExpr, "line-width": 0.8, "line-opacity": 0.85 },
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
      // inside a `case`). Each stop's value is a per-feature `case`. Unvisited dots
      // stay at radius 0 until ~zoom 5, then fade in larger than before so missed
      // cities are easy to spot and tap without zooming way in (the rendered radius
      // is also the click target). Radius 0 means invisible AND not hit-tested, so
      // zoomed out there are no stray click targets.
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        1, ["case", ["==", ["get", "visited"], 1], 3, 0],
        4, ["case", ["==", ["get", "visited"], 1], 4.5, 0],
        5, ["case", ["==", ["get", "visited"], 1], 6, 4.5],
        7, ["case", ["==", ["get", "visited"], 1], 8, 6],
        12, ["case", ["==", ["get", "visited"], 1], 11, 9],
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

async function ensureMlb(map: MlMap): Promise<void> {
  if (map.getSource("mlb")) return;
  map.addSource("mlb", { type: "geojson", data: await taggedMlb() });
  map.addLayer({
    id: "mlb-circle",
    type: "circle",
    source: "mlb",
    paint: {
      "circle-radius": 6,
      "circle-color": ["case", ["==", ["get", "visited"], 1], "#8E5FBF", VENUE_NEUTRAL],
      "circle-stroke-color": "#1a1a1a",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
      "circle-stroke-opacity": 0.5,
    },
  }, labelBeforeId(map));
}

// FBS/FCS: same circle-marker treatment, colored by the 3-way state instead of
// a binary visited flag. Identical paint besides which source/id they read.
async function ensureFbs(map: MlMap): Promise<void> {
  if (map.getSource("fbs")) return;
  map.addSource("fbs", { type: "geojson", data: await taggedFbs() });
  map.addLayer({
    id: "fbs-circle",
    type: "circle",
    source: "fbs",
    paint: {
      "circle-radius": 6,
      "circle-color": venueFillExpr,
      "circle-stroke-color": "#1a1a1a",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
      "circle-stroke-opacity": 0.5,
    },
  }, labelBeforeId(map));
}
async function ensureFcs(map: MlMap): Promise<void> {
  if (map.getSource("fcs")) return;
  map.addSource("fcs", { type: "geojson", data: await taggedFcs() });
  map.addLayer({
    id: "fcs-circle",
    type: "circle",
    source: "fcs",
    paint: {
      "circle-radius": 5,
      "circle-color": venueFillExpr,
      "circle-stroke-color": "#1a1a1a",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
      "circle-stroke-opacity": 0.5,
    },
  }, labelBeforeId(map));
}

const ENSURE: Record<LayerKind, (map: MlMap) => Promise<void>> = {
  countries: ensureCountries,
  states: ensureStates,
  cities: ensureCities,
  parks: ensureParks,
  fbs: ensureFbs,
  fcs: ensureFcs,
  mlb: ensureMlb,
};

const TAGGED: Record<LayerKind, () => Promise<FeatureCollection>> = {
  countries: taggedCountries,
  states: taggedStates,
  cities: taggedCities,
  parks: taggedParks,
  fbs: taggedFbs,
  fcs: taggedFcs,
  mlb: taggedMlb,
};

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function venueMapsEqual(a: Map<string, VenueState>, b: Map<string, VenueState>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export async function initLayers(map: MlMap, state: LayerState): Promise<void> {
  // Work out which visited sets actually changed *before* adopting the new
  // state, so only those sources get re-uploaded below. setData re-parses the
  // whole GeoJSON (states is ~26 MB), so pushing unchanged data on every save
  // made each "Mark visited" click visibly hitch once Regions had been opened.
  const changed: LayerKind[] = (Object.keys(KIND_SET) as BinaryLayerKind[]).filter(
    (kind) => !setsEqual(state[KIND_SET[kind]], layerState[KIND_SET[kind]]),
  );
  if (!venueMapsEqual(state.fbsState, layerState.fbsState)) changed.push("fbs");
  if (!venueMapsEqual(state.fcsState, layerState.fcsState)) changed.push("fcs");
  // Sources created by the ensure* calls below are tagged with the new state
  // already — only sources that predate this call can hold stale data.
  const preexisting = new Set(changed.filter((kind) => map.getSource(kind)));
  layerState = state;
  // Countries supply the base outline shown in every view, so always load them.
  await ensureCountries(map);
  // Restore a non-default selection (e.g. after a theme change rebuilds the style).
  if (currentLayer !== "countries") {
    await ENSURE[currentLayer](map);
  }
  for (const kind of preexisting) {
    const src = map.getSource(kind) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(await TAGGED[kind]());
  }
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
  "parks-fill",
  "parks-line",
  "fbs-circle",
  "fcs-circle",
  "mlb-circle",
];

const VISIBLE_BY_LAYER: Record<LayerKind, string[]> = {
  countries: ["countries-fill", "countries-line"],
  states: ["countries-line", "states-fill", "states-line"],
  cities: ["countries-line", "cities-circle"],
  parks: ["countries-line", "parks-fill", "parks-line"],
  fbs: ["countries-line", "fbs-circle"],
  fcs: ["countries-line", "fcs-circle"],
  mlb: ["countries-line", "mlb-circle"],
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

function popupHTML(
  title: string,
  subtitle: string,
  visited: boolean,
  canToggle: boolean,
  isHome: boolean,
): string {
  const sub = subtitle ? `<div class="fp-popup-sub">${escapeHtml(subtitle)}</div>` : "";
  const status = visited
    ? `<div class="fp-popup-status is-visited">Visited</div>`
    : `<div class="fp-popup-status">Not visited yet</div>`;
  // When this place is already the home pin, show a badge instead of the (now
  // redundant) "Set as home" button. Visible in any build — it just reflects state.
  const homeBadge = isHome ? `<div class="fp-popup-home-badge">🏠 Your home</div>` : "";
  // Desktop write-mode only: quiet ghost buttons to fix spatial-join misses and
  // set the home pin without re-importing/hand-editing. Hidden in the read-only
  // browser build (`canToggle` is false). The "Set as home" button is omitted when
  // this place already is home (the badge stands in for it).
  const toggleBtn = canToggle
    ? `<button type="button" class="fp-popup-toggle">${visited ? "Unmark visited" : "Mark visited"}</button>`
    : "";
  const homeBtn =
    canToggle && !isHome ? `<button type="button" class="fp-popup-home">Set as home</button>` : "";
  const actions = toggleBtn || homeBtn ? `<div class="fp-popup-actions">${toggleBtn}${homeBtn}</div>` : "";
  return `<div class="fp-popup"><div class="fp-popup-title">${escapeHtml(title)}</div>${sub}${status}${homeBadge}${actions}</div>`;
}

function str(props: Record<string, unknown> | null, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}

// Sports Venues (FBS/FCS) popup: a 3-way pick instead of a single toggle.
// `state` is the currently-recorded VenueState, or null if unvisited. Each
// button is labeled with its own state name; the active one is marked
// data-active so CSS can highlight it. Clicking the active button again clears
// it (handled in wireVenuePopupActions, matching "re-pick to undo").
function popupVenueHTML(
  title: string,
  subtitle: string,
  state: VenueState | null,
  canToggle: boolean,
): string {
  const sub = subtitle ? `<div class="fp-popup-sub">${escapeHtml(subtitle)}</div>` : "";
  const statusText =
    state === "campus" ? "Been to campus" : state === "stadium" ? "Been in the stadium" : state === "game" ? "Been to a game here" : "Not visited yet";
  const status = `<div class="fp-popup-status${state ? " is-visited" : ""}">${statusText}</div>`;
  const btn = (value: VenueState, label: string) =>
    canToggle
      ? `<button type="button" class="fp-popup-venue-btn${state === value ? " is-active" : ""}" data-venue-state="${value}">${label}</button>`
      : "";
  const actions = canToggle
    ? `<div class="fp-popup-venue-actions">${btn("campus", "Campus")}${btn("stadium", "Stadium")}${btn("game", "Game")}</div>`
    : "";
  return `<div class="fp-popup"><div class="fp-popup-title">${escapeHtml(title)}</div>${sub}${status}${actions}</div>`;
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
  if (kind === "parks") {
    return `parks:${str(props, "UNIT_NAME")}`;
  }
  if (kind === "fbs" || kind === "fcs" || kind === "mlb") {
    return `${kind}:${str(props, "SCHOOL_ID") || str(props, "TEAM_ID")}`;
  }
  return `cities:${joinParts([str(props, "NAMEASCII") || str(props, "NAME"), str(props, "ADM1NAME"), str(props, "ADM0NAME")])}`;
}

// Builds the popup body for a clicked feature, per layer's property scheme.
function contentFor(
  kind: LayerKind,
  props: Record<string, unknown> | null,
  canToggle: boolean,
  isHome: boolean,
): string {
  const visited = props?.visited === 1;
  if (kind === "countries") {
    const continent = str(props, "CONTINENT");
    return popupHTML(
      str(props, "NAME") || str(props, "ADMIN") || "Unknown",
      continent === "Seven seas (open ocean)" ? "" : continent,
      visited,
      canToggle,
      isHome,
    );
  }
  if (kind === "states") {
    return popupHTML(
      str(props, "name") || "Unknown",
      joinParts([str(props, "type_en"), str(props, "admin")]),
      visited,
      canToggle,
      isHome,
    );
  }
  if (kind === "parks") {
    return popupHTML(
      str(props, "UNIT_NAME") || "Unknown",
      str(props, "STATE"),
      visited,
      canToggle,
      isHome,
    );
  }
  if (kind === "fbs" || kind === "fcs") {
    const raw = props?.state;
    const code = typeof raw === "number" ? raw : 0;
    const state: VenueState | null = code === 1 ? "campus" : code === 2 ? "stadium" : code === 3 ? "game" : null;
    return popupVenueHTML(str(props, "SCHOOL") || "Unknown", str(props, "CONFERENCE"), state, canToggle);
  }
  if (kind === "mlb") {
    return popupHTML(str(props, "TEAM") || "Unknown", str(props, "STADIUM"), visited, canToggle, isHome);
  }
  return popupHTML(
    str(props, "NAME") || str(props, "NAMEASCII") || "Unknown",
    joinParts([str(props, "ADM1NAME"), str(props, "ADM0NAME")]),
    visited,
    canToggle,
    isHome,
  );
}

// Latest home pin, kept in sync by main.ts so popups can tell whether a clicked
// place already is home. Compared by coordinate: a city feature's point IS its
// centroid, and "Set as home" stores that snapped centroid, so they match.
let currentHome: HomePoint | null = null;
export function setHomePoint(home: HomePoint | null): void {
  currentHome = home;
}

const HOME_EPS = 1e-4;
function isHomeFeature(kind: LayerKind, feature: Feature): boolean {
  if (kind !== "cities" || !currentHome || feature.geometry.type !== "Point") return false;
  const [lon, lat] = feature.geometry.coordinates as [number, number];
  return Math.abs(lon - currentHome.lon) < HOME_EPS && Math.abs(lat - currentHome.lat) < HOME_EPS;
}

// The "visited" key for a feature — the same ID scheme used by the visited sets,
// so a toggle flips the exact entry an import would have added. (featureKey above
// is for popup-open identity; this is the persisted dataset ID.)
function visitedId(kind: LayerKind, feature: Feature): string {
  if (kind === "countries") return countryIso(feature);
  if (kind === "states") return stateIso(feature);
  if (kind === "parks") return parkId(feature);
  if (kind === "fbs") return fbsId(feature);
  if (kind === "fcs") return fcsId(feature);
  if (kind === "mlb") return mlbId(feature);
  return cityId(feature);
}

// Registered by main.ts (which owns the persisted `current` file). Flips the ID,
// saves, re-tags the map + stats, and resolves to the new visited state so the
// popup can re-render. Null in the browser build (no toggle button is shown).
// Scoped to BinaryLayerKind — fbs/fcs use venueStateHandler below instead.
type ToggleHandler = (kind: BinaryLayerKind, id: string) => Promise<boolean>;
let toggleHandler: ToggleHandler | null = null;
export function setToggleHandler(fn: ToggleHandler): void {
  toggleHandler = fn;
}

// Registered by main.ts. Sets (or, re-picking the active state, clears) a
// school's VenueState, saves, re-tags the map + stats, and resolves to the new
// state (null if cleared) so the popup can re-render. Null in the browser build.
type VenueStateHandler = (kind: "fbs" | "fcs", id: string, state: VenueState) => Promise<VenueState | null>;
let venueStateHandler: VenueStateHandler | null = null;
export function setVenueStateHandler(fn: VenueStateHandler): void {
  venueStateHandler = fn;
}

// Registered by main.ts. Snaps the given point to the nearest city and persists
// it as the home pin, then re-renders the map (home marker) + stats. Null in the
// browser build (no "Set as home" button is shown).
type HomeHandler = (lng: number, lat: number) => Promise<void>;
let homeHandler: HomeHandler | null = null;
export function setHomeHandler(fn: HomeHandler): void {
  homeHandler = fn;
}

// Sports Venues (FBS/FCS) popup wiring: three state buttons instead of one
// toggle. Clicking a button sets that state; clicking the already-active one
// clears it back to unvisited (mirrors the "re-click to unmark" pattern the
// binary toggle button uses elsewhere).
function wireVenuePopupActions(
  p: maplibregl.Popup,
  kind: "fbs" | "fcs",
  feature: Feature,
  ll: [number, number],
): void {
  const root = p.getElement();
  if (!root) return;
  const buttons = root.querySelectorAll<HTMLButtonElement>(".fp-popup-venue-btn");
  buttons.forEach((btn) => {
    btn.addEventListener(
      "click",
      async () => {
        if (!venueStateHandler) return;
        buttons.forEach((b) => (b.disabled = true));
        const state = btn.dataset.venueState as VenueState;
        await venueStateHandler(kind, visitedId(kind, feature), state);
        // Re-read the just-saved state from wherever main.ts stashed it
        // (layerState.fbsState/fcsState, updated by the caller's re-render)
        // rather than trusting the handler's return blindly — same pattern
        // openFeaturePopup uses to derive `visited` from layerState.
        const stateMap = kind === "fbs" ? layerState.fbsState : layerState.fcsState;
        const newState = stateMap.get(visitedId(kind, feature)) ?? null;
        const code = newState ? VENUE_STATE_CODE[newState] : 0;
        const props = { ...(feature.properties ?? {}), state: code };
        p.setHTML(contentFor(kind, props, true, false));
        wireVenuePopupActions(p, kind, feature, ll);
      },
      { once: true },
    );
  });
}

// Bind the popup's write-mode buttons (Mark/Unmark + Set as home). After a toggle
// `setHTML` rebuilds the popup DOM, spending the `{ once: true }` listeners, so we
// re-wire. `ll` is the [lng, lat] the popup is anchored at — what "Set as home"
// snaps from.
function wirePopupActions(
  p: maplibregl.Popup,
  kind: LayerKind,
  feature: Feature,
  ll: [number, number],
  isHome: boolean,
): void {
  if (kind === "fbs" || kind === "fcs") {
    wireVenuePopupActions(p, kind, feature, ll);
    return;
  }
  const root = p.getElement();
  if (!root) return;

  const toggleBtn = root.querySelector<HTMLButtonElement>(".fp-popup-toggle");
  if (toggleBtn && toggleHandler) {
    toggleBtn.addEventListener(
      "click",
      async () => {
        toggleBtn.disabled = true;
        const nowVisited = await toggleHandler!(kind as BinaryLayerKind, visitedId(kind, feature));
        const props = { ...(feature.properties ?? {}), visited: nowVisited ? 1 : 0 };
        p.setHTML(contentFor(kind, props, true, isHome));
        wirePopupActions(p, kind, feature, ll, isHome);
      },
      { once: true },
    );
  }

  const homeBtn = root.querySelector<HTMLButtonElement>(".fp-popup-home");
  if (homeBtn && homeHandler) {
    homeBtn.addEventListener(
      "click",
      async () => {
        homeBtn.disabled = true;
        homeBtn.textContent = "Setting…";
        await homeHandler!(ll[0], ll[1]);
        homeBtn.textContent = "Home set ✓";
      },
      { once: true },
    );
  }
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
  ["parks-fill", "parks"],
  ["fbs-circle", "fbs"],
  ["fcs-circle", "fcs"],
  ["mlb-circle", "mlb"],
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
      // are anchored at the click location. Kept as a [lng, lat] tuple so it can
      // double as the snap origin for "Set as home".
      const ll: [number, number] =
        feature.geometry.type === "Point"
          ? (feature.geometry.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];
      const canToggle = isTauri();
      const home = isHomeFeature(kind, feature as unknown as Feature);
      popup?.remove();
      popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "240px" })
        .setLngLat(ll)
        .setHTML(contentFor(kind, feature.properties as Record<string, unknown> | null, canToggle, home))
        .addTo(map);
      pinnedId = id;
      if (canToggle) wirePopupActions(popup, kind, feature as unknown as Feature, ll, home);
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
    ["parks-fill", "parks"],
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

// --- Search fly-to + popup ----------------------------------------------------

function geomBbox(geom: Feature["geometry"]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const [x, y] = c as [number, number];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else {
      for (const child of c as unknown[]) visit(child);
    }
  };
  visit((geom as Polygon | MultiPolygon | Point).coordinates);
  return [minX, minY, maxX, maxY];
}

// Geographic anchor for a feature: cities use their point; polygons use the
// Natural Earth label point (kept by scripts/trim-geojson.mjs), which sits on
// the mainland — better than a bbox center, which overseas islands can drag
// into open ocean. Bbox center is the fallback.
function anchorFor(kind: LayerKind, feature: Feature): [number, number] {
  if (feature.geometry.type === "Point") {
    return feature.geometry.coordinates as [number, number];
  }
  const props = feature.properties ?? {};
  const lon = kind === "countries" || kind === "parks" ? props.LABEL_X : props.longitude;
  const lat = kind === "countries" || kind === "parks" ? props.LABEL_Y : props.latitude;
  if (typeof lon === "number" && typeof lat === "number") return [lon, lat];
  const [minX, minY, maxX, maxY] = geomBbox(feature.geometry);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// A search pick should land the place in the middle of the screen quickly. The
// default flyTo arcs out to the whole world and back over ~2.5 s, so for most of
// the animation the target sits off to one side — which reads as "it didn't
// center." A bounded, gentle move settles the place dead-centre fast instead.
// `essential` keeps it running under prefers-reduced-motion (where it collapses
// to an instant, still-centred jump).
const FLY: { duration: number; curve: number; essential: true } = {
  duration: 900,
  curve: 1.2,
  essential: true,
};

/** Fly the camera to a (search-result) feature: cities zoom to a point, polygons fit their bounds. */
export function flyToFeature(map: MlMap, kind: LayerKind, feature: Feature): void {
  if (feature.geometry.type === "Point") {
    const [lon, lat] = feature.geometry.coordinates as [number, number];
    // Zoom 8 comfortably shows the surrounding city dots; never zoom *out* a
    // user who is already closer.
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), ...FLY });
    return;
  }
  const [minX, minY, maxX, maxY] = geomBbox(feature.geometry);
  // Antimeridian-spanning polygons (Russia, Fiji, the Aleutians) produce a
  // near-global bbox; center on the label point at a wide zoom instead.
  if (maxX - minX > 170) {
    map.flyTo({ center: anchorFor(kind, feature), zoom: kind === "countries" ? 2.5 : 4, ...FLY });
    return;
  }
  map.fitBounds([[minX, minY], [maxX, maxY]], {
    padding: 48,
    maxZoom: kind === "countries" ? 6 : 8,
    duration: FLY.duration,
    essential: FLY.essential,
  });
}

/**
 * Open the standard inspect popup for a feature found by search (rather than by
 * click): same content, same write-mode buttons. The raw dataset feature isn't
 * tagged, so the visited flag is computed here from the current visited sets.
 */
export function openFeaturePopup(map: MlMap, kind: LayerKind, feature: Feature): void {
  let props: Record<string, unknown>;
  if (kind === "fbs" || kind === "fcs") {
    const stateMap = kind === "fbs" ? layerState.fbsState : layerState.fcsState;
    const v = stateMap.get(visitedId(kind, feature));
    props = { ...(feature.properties ?? {}), state: v ? VENUE_STATE_CODE[v] : 0 };
  } else {
    const visitedSet = layerState[KIND_SET[kind]];
    props = { ...(feature.properties ?? {}), visited: visitedSet.has(visitedId(kind, feature)) ? 1 : 0 };
  }
  const tagged: Feature = { ...feature, properties: props };
  const ll = anchorFor(kind, feature);
  const canToggle = isTauri();
  const home = isHomeFeature(kind, tagged);
  const id = featureKey(kind, props);
  popup?.remove();
  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "240px" })
    .setLngLat(ll)
    .setHTML(contentFor(kind, props, canToggle, home))
    .addTo(map);
  pinnedId = id;
  if (canToggle) wirePopupActions(popup, kind, tagged, ll, home);
  popup.on("close", () => {
    if (pinnedId === id) pinnedId = null;
  });
}

import type { FeatureCollection, Feature, Polygon, MultiPolygon, Point } from "geojson";
import { distance } from "@turf/distance";
import { point as turfPoint } from "@turf/helpers";
import type { HomePoint, VenueState } from "../types";

const COUNTRIES_URL = `${import.meta.env.BASE_URL}data/countries.geojson`;
const STATES_URL = `${import.meta.env.BASE_URL}data/states.geojson`;
const CITIES_URL = `${import.meta.env.BASE_URL}data/cities.geojson`;
const PARKS_URL = `${import.meta.env.BASE_URL}data/parks.geojson`;
const FBS_URL = `${import.meta.env.BASE_URL}data/fbs.json`;
const FCS_URL = `${import.meta.env.BASE_URL}data/fcs.json`;
const MLB_URL = `${import.meta.env.BASE_URL}data/mlb.json`;

let countries: FeatureCollection<Polygon | MultiPolygon> | null = null;
let states: FeatureCollection<Polygon | MultiPolygon> | null = null;
let cities: FeatureCollection<Point> | null = null;
let parks: FeatureCollection<Polygon | MultiPolygon> | null = null;
let fbs: FeatureCollection<Point> | null = null;
let fcs: FeatureCollection<Point> | null = null;
let mlb: FeatureCollection<Point> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return (await res.json()) as T;
}

export async function loadCountries() {
  if (!countries) {
    countries = await fetchJson<FeatureCollection<Polygon | MultiPolygon>>(COUNTRIES_URL);
    buildContinentLookup(countries);
  }
  return countries;
}

export async function loadStates() {
  if (!states) {
    states = await fetchJson<FeatureCollection<Polygon | MultiPolygon>>(STATES_URL);
  }
  return states;
}

export async function loadCities() {
  if (!cities) {
    cities = await fetchJson<FeatureCollection<Point>>(CITIES_URL);
  }
  return cities;
}

// The 63 official U.S. National Parks, boundaries from the NPS Land Resources
// Division (see scripts/trim-geojson.mjs for provenance). A small, static
// dataset — no lazy-load benefit, but treated the same as the others for
// consistency and because ensureParks()/setLayer() already expect an
// async loader per layer kind.
export async function loadParks() {
  if (!parks) {
    parks = await fetchJson<FeatureCollection<Polygon | MultiPolygon>>(PARKS_URL);
  }
  return parks;
}

// Sports Venues datasets: FBS/FCS school stadiums and MLB ballparks, all plain
// point FeatureCollections (no polygon boundaries to trim/simplify, hence no
// scripts/trim-geojson.mjs entry — each file is a few KB already). See
// CLAUDE.md for provenance and how to regenerate/extend these.
export async function loadFbs() {
  if (!fbs) {
    fbs = await fetchJson<FeatureCollection<Point>>(FBS_URL);
  }
  return fbs;
}

export async function loadFcs() {
  if (!fcs) {
    fcs = await fetchJson<FeatureCollection<Point>>(FCS_URL);
  }
  return fcs;
}

export async function loadMlb() {
  if (!mlb) {
    mlb = await fetchJson<FeatureCollection<Point>>(MLB_URL);
  }
  return mlb;
}

// Dependent territories that Natural Earth assigns their own ISO_A3 code but
// which aren't sovereign nations. Collapse them onto their parent state so the
// "Countries" stat counts political countries, not territories. The polygons are
// still rendered as visited on the map — only the headline count is affected.
const TERRITORY_PARENT: Record<string, string> = {
  // United States
  PRI: "USA", // Puerto Rico
  VIR: "USA", // U.S. Virgin Islands
  GUM: "USA", // Guam
  ASM: "USA", // American Samoa
  MNP: "USA", // Northern Mariana Islands
  // France
  GUF: "FRA", // French Guiana
  GLP: "FRA", // Guadeloupe
  MTQ: "FRA", // Martinique
  MYT: "FRA", // Mayotte
  REU: "FRA", // Réunion
  BLM: "FRA", // Saint Barthélemy
  MAF: "FRA", // Saint Martin
  SPM: "FRA", // Saint Pierre and Miquelon
  NCL: "FRA", // New Caledonia
  PYF: "FRA", // French Polynesia
  WLF: "FRA", // Wallis and Futuna
  // Netherlands
  ABW: "NLD", // Aruba
  CUW: "NLD", // Curaçao
  SXM: "NLD", // Sint Maarten
  BES: "NLD", // Caribbean Netherlands
};

/** Distinct sovereign-country count, collapsing dependent territories onto their parent. */
export function countCountries(isoCodes: Iterable<string>): number {
  const set = new Set<string>();
  for (const code of isoCodes) set.add(TERRITORY_PARENT[code] ?? code);
  return set.size;
}

// Country ISO → continent, built once countries.geojson loads. Used for the
// "continents visited" progress stat. Open-ocean features carry no real continent.
let continentByIso: Map<string, string> | null = null;
function buildContinentLookup(fc: FeatureCollection<Polygon | MultiPolygon>): void {
  const map = new Map<string, string>();
  for (const f of fc.features) {
    const continent = (f.properties?.CONTINENT as string | undefined) ?? "";
    if (continent && continent !== "Seven seas (open ocean)") {
      map.set(countryIso(f), continent);
    }
  }
  continentByIso = map;
}

/** Distinct continents touched by the visited countries (requires countries loaded). */
export function countContinents(isoCodes: Iterable<string>): number {
  if (!continentByIso) return 0;
  const set = new Set<string>();
  for (const code of isoCodes) {
    const continent = continentByIso.get(code) ?? continentByIso.get(TERRITORY_PARENT[code] ?? "");
    if (continent) set.add(continent);
  }
  return set.size;
}

// Natural Earth's seven land continents, in a stable display order. The headline
// "Continents / 7" bar uses this same set (open-ocean features are excluded when
// the lookup is built).
const CONTINENT_ORDER = [
  "Europe",
  "Asia",
  "Africa",
  "North America",
  "South America",
  "Oceania",
  "Antarctica",
];

export interface ContinentCount {
  continent: string;
  count: number;
}

/**
 * Per-continent count of distinct sovereign countries visited, ordered by
 * `CONTINENT_ORDER` and omitting continents with none. Territories collapse onto
 * their parent (matching `countCountries`) so a French-overseas visit doesn't
 * inflate, say, South America on its own.
 */
export function countsByContinent(isoCodes: Iterable<string>): ContinentCount[] {
  if (!continentByIso) return [];
  const sovereign = new Set<string>();
  for (const code of isoCodes) sovereign.add(TERRITORY_PARENT[code] ?? code);
  const counts = new Map<string, number>();
  for (const code of sovereign) {
    const continent = continentByIso.get(code);
    if (!continent) continue;
    counts.set(continent, (counts.get(continent) ?? 0) + 1);
  }
  return CONTINENT_ORDER.filter((c) => counts.has(c)).map((c) => ({
    continent: c,
    count: counts.get(c) as number,
  }));
}

export interface Extreme {
  name: string;
  lat: number;
  lon: number;
}

export interface Extremes {
  north: Extreme;
  south: Extreme;
  east: Extreme;
  west: Extreme;
}

export function cityName(f: Feature): string {
  const props = f.properties ?? {};
  return (props.NAMEASCII as string) || (props.NAME as string) || "?";
}

/**
 * The northernmost / southernmost / easternmost / westernmost visited city, from
 * the city point coords. Returns null until `loadCities()` has resolved (the
 * dataset is lazy/prefetched) or when no visited city is present. East/west are a
 * plain min/max longitude — fine for a personal tracker; no antimeridian wrap.
 */
export function cityExtremes(visited: Iterable<string>): Extremes | null {
  if (!cities) return null;
  const set = visited instanceof Set ? visited : new Set(visited);
  let north: Extreme | null = null;
  let south: Extreme | null = null;
  let east: Extreme | null = null;
  let west: Extreme | null = null;
  for (const f of cities.features) {
    if (!set.has(cityId(f))) continue;
    const [lon, lat] = f.geometry.coordinates;
    const e: Extreme = { name: cityName(f), lat, lon };
    if (!north || lat > north.lat) north = e;
    if (!south || lat < south.lat) south = e;
    if (!east || lon > east.lon) east = e;
    if (!west || lon < west.lon) west = e;
  }
  if (!north || !south || !east || !west) return null;
  return { north, south, east, west };
}

export interface Furthest {
  name: string;
  miles: number;
  /** City coordinates — lets the map drop a marker at each Top-5 entry. */
  lat: number;
  lon: number;
}

const KM_TO_MILES = 0.621371;

/**
 * The top `count` visited cities furthest (great-circle) from home, descending
 * by distance. Returns [] without a home pin, before `loadCities()` resolves,
 * or with no visited cities. Reuses the city point coords + `@turf/distance`
 * (already a dependency); reported in miles.
 */
export function furthestCities(
  home: HomePoint | undefined,
  visited: Iterable<string>,
  count = 5,
): Furthest[] {
  if (!home || !cities) return [];
  const set = visited instanceof Set ? visited : new Set(visited);
  const from = turfPoint([home.lon, home.lat]);
  const all: Furthest[] = [];
  for (const f of cities.features) {
    if (!set.has(cityId(f))) continue;
    const [lon, lat] = f.geometry.coordinates;
    all.push({ name: cityName(f), miles: distance(from, f, { units: "kilometers" }) * KM_TO_MILES, lat, lon });
  }
  all.sort((a, b) => b.miles - a.miles);
  return all.slice(0, count);
}

export interface FurthestPair {
  a: string;
  b: string;
  miles: number;
  /** Coordinates of each end — lets the map drop a marker at both cities. */
  aLat: number;
  aLon: number;
  bLat: number;
  bLon: number;
}

/**
 * The single furthest-apart pair among visited cities (great-circle), in
 * miles. O(n^2) over visited cities — fine at personal-tracker scale (a
 * few hundred visited cities is still instant). Returns null with fewer
 * than 2 visited cities, or before `loadCities()` resolves.
 */
export function maxCityDistance(visited: Iterable<string>): FurthestPair | null {
  if (!cities) return null;
  const set = visited instanceof Set ? visited : new Set(visited);
  const pts: { name: string; feature: Feature<Point> }[] = [];
  for (const f of cities.features) {
    if (set.has(cityId(f))) pts.push({ name: cityName(f), feature: f });
  }
  let best: FurthestPair | null = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const miles = distance(pts[i].feature, pts[j].feature, { units: "kilometers" }) * KM_TO_MILES;
      if (!best || miles > best.miles) {
        const [aLon, aLat] = pts[i].feature.geometry.coordinates;
        const [bLon, bLat] = pts[j].feature.geometry.coordinates;
        best = { a: pts[i].name, b: pts[j].name, miles, aLat, aLon, bLat, bLon };
      }
    }
  }
  return best;
}

export function countryIso(feature: Feature): string {
  const props = feature.properties ?? {};
  const iso = props.ISO_A3 as string | undefined;
  if (iso && iso !== "-99" && iso !== "") return iso;
  const adm0 = props.ADM0_A3 as string | undefined;
  if (adm0 && adm0 !== "-99" && adm0 !== "") return adm0;
  const sov = props.SOV_A3 as string | undefined;
  if (sov && sov !== "-99" && sov !== "") return sov;
  return (props.ADMIN as string) ?? "?";
}

export function stateIso(feature: Feature): string {
  const props = feature.properties ?? {};
  const iso = props.iso_3166_2 as string | undefined;
  if (iso && iso !== "-99" && iso !== "") return iso;
  const code = props.adm1_code as string | undefined;
  if (code) return code;
  const admin = (props.admin as string) ?? "?";
  const name = (props.name as string) ?? "?";
  return `${admin}|${name}`;
}

export function cityId(feature: Feature): string {
  const props = feature.properties ?? {};
  const a3 = (props.ADM0_A3 as string) ?? "?";
  const name = (props.NAMEASCII as string) ?? (props.NAME as string) ?? "?";
  const adm1 = (props.ADM1NAME as string) ?? "";
  return `${a3}|${adm1}|${name}`;
}

// The NPS 4-letter unit code (e.g. "YELL") — stable, unique, and already the
// primary key the boundary dataset ships with, so no fallback chain needed.
export function parkId(feature: Feature): string {
  const props = feature.properties ?? {};
  return (props.UNIT_CODE as string) ?? "?";
}

export function parkName(feature: Feature): string {
  const props = feature.properties ?? {};
  return (props.UNIT_NAME as string) ?? "?";
}

// FBS/FCS schools and MLB teams all share the same {SCHOOL_ID|TEAM_ID, SCHOOL|TEAM,
// CONFERENCE, STADIUM, CITY, STATE} property shape (see the build script noted in
// CLAUDE.md), so one set of accessors covers all three.
export function fbsId(feature: Feature): string {
  return ((feature.properties ?? {}).SCHOOL_ID as string) ?? "?";
}
export function fbsName(feature: Feature): string {
  return ((feature.properties ?? {}).SCHOOL as string) ?? "?";
}
export function fbsConference(feature: Feature): string {
  return ((feature.properties ?? {}).CONFERENCE as string) ?? "";
}

export function fcsId(feature: Feature): string {
  return ((feature.properties ?? {}).SCHOOL_ID as string) ?? "?";
}
export function fcsName(feature: Feature): string {
  return ((feature.properties ?? {}).SCHOOL as string) ?? "?";
}
export function fcsConference(feature: Feature): string {
  return ((feature.properties ?? {}).CONFERENCE as string) ?? "";
}

export function mlbId(feature: Feature): string {
  return ((feature.properties ?? {}).TEAM_ID as string) ?? "?";
}
export function mlbName(feature: Feature): string {
  return ((feature.properties ?? {}).TEAM as string) ?? "?";
}

// The four Power Conference schools + the two FBS independents (Notre Dame,
// UConn) — the subset that counts toward the sidebar's "Power 4 Stadiums"
// totalizer. Everything else in FBS (Group of Five) and all of FCS remain
// fully trackable (map/search/checklist), they just don't move this stat —
// matching how FCS/MLB already work, per Justin.
const POWER4_CONFERENCES = new Set(["ACC", "Big 12", "Big Ten", "SEC"]);

/**
 * Count of visited FBS schools (any VenueState) whose conference is Power 4
 * or Independent. Returns 0 until `loadFbs()` has resolved (see
 * `prefetchFbsStats()` in main.ts, which warms this in the background so the
 * stat is right from the first render, not just after the FBS view/checklist
 * tab has been opened once).
 */
export function countPowerFbs(visited: Record<string, VenueState>): number {
  if (!fbs) return 0;
  let n = 0;
  for (const f of fbs.features) {
    const id = fbsId(f);
    if (!(id in visited)) continue;
    const conf = fbsConference(f);
    if (conf === "Independent" || POWER4_CONFERENCES.has(conf)) n++;
  }
  return n;
}

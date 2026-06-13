import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { distance } from "@turf/distance";
import { point as turfPoint } from "@turf/helpers";
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point } from "geojson";
import type { Visit } from "../types";
import {
  loadCountries,
  loadStates,
  loadCities,
  countryIso,
  stateIso,
  cityId,
  cityName,
} from "./datasets";
import type { HomePoint } from "../types";

interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

function bboxOf(geom: Polygon | MultiPolygon): BBox {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

function inBBox(lat: number, lon: number, b: BBox): boolean {
  return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
}

interface PolyIndex {
  features: Feature<Polygon | MultiPolygon>[];
  bboxes: BBox[];
}

function buildIndex(fc: FeatureCollection<Polygon | MultiPolygon>): PolyIndex {
  const bboxes = fc.features.map((f) => bboxOf(f.geometry));
  return { features: fc.features, bboxes };
}

function findContaining(index: PolyIndex, lat: number, lon: number): Feature<Polygon | MultiPolygon> | null {
  const pt = turfPoint([lon, lat]);
  for (let i = 0; i < index.features.length; i++) {
    if (!inBBox(lat, lon, index.bboxes[i])) continue;
    if (booleanPointInPolygon(pt, index.features[i])) return index.features[i];
  }
  return null;
}

function findNearestCity(cities: FeatureCollection<Point>, lat: number, lon: number, maxKm = 25): Feature<Point> | null {
  const pt = turfPoint([lon, lat]);
  let best: Feature<Point> | null = null;
  let bestD = Infinity;
  for (const city of cities.features) {
    const [clon, clat] = (city.geometry as Point).coordinates;
    const dlat = clat - lat;
    const dlon = clon - lon;
    if (Math.abs(dlat) > 1 || Math.abs(dlon) > 1.5) continue;
    const d = distance(pt, city, { units: "kilometers" });
    if (d < bestD) {
      bestD = d;
      best = city;
    }
  }
  return bestD <= maxKm ? best : null;
}

/**
 * Snap an arbitrary point to the nearest dataset city, returning that city's
 * centroid + name as a HomePoint. Uncapped (unlike the 25 km import match) so a
 * home click always resolves to *some* city — the snap is what coarsens the
 * stored coordinate to a public, city-level location. Full scan over ~7,300
 * cities, which is instant for a one-off click.
 */
export async function nearestCity(lat: number, lon: number): Promise<HomePoint | null> {
  const cities = await loadCities();
  const pt = turfPoint([lon, lat]);
  let best: Feature<Point> | null = null;
  let bestD = Infinity;
  for (const city of cities.features) {
    const d = distance(pt, city, { units: "kilometers" });
    if (d < bestD) {
      bestD = d;
      best = city;
    }
  }
  if (!best) return null;
  const [clon, clat] = (best.geometry as Point).coordinates;
  return { lat: clat, lon: clon, label: cityName(best) };
}

export interface JoinedResult {
  visitedCountries: Set<string>;
  visitedStates: Set<string>;
  visitedCities: Set<string>;
}

export async function joinVisits(visits: Visit[]): Promise<JoinedResult> {
  const [countries, states, cities] = await Promise.all([
    loadCountries(),
    loadStates(),
    loadCities(),
  ]);
  const countryIdx = buildIndex(countries);
  const stateIdx = buildIndex(states);

  const visitedCountries = new Set<string>();
  const visitedStates = new Set<string>();
  const visitedCities = new Set<string>();

  // Timeline exports contain the same places over and over (every trip home is
  // a visit). Two visits within the same ~110 m bucket resolve to the same
  // country/state/city, so join each bucket once — typically an order of
  // magnitude fewer polygon scans on a real export.
  const seen = new Set<string>();
  for (const v of visits) {
    const key = `${v.lat.toFixed(3)},${v.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const country = findContaining(countryIdx, v.lat, v.lon);
    const state = findContaining(stateIdx, v.lat, v.lon);
    const city = findNearestCity(cities, v.lat, v.lon);

    if (country) visitedCountries.add(countryIso(country));
    if (state) visitedStates.add(stateIso(state));
    if (city) visitedCities.add(cityId(city));
  }

  return { visitedCountries, visitedStates, visitedCities };
}

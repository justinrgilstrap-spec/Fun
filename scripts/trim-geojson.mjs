#!/usr/bin/env node
// Shrink public/data/*.geojson without touching what renders. Two passes:
//
// 1. Coordinate precision trim to 5 decimal places (~1.1 m at the equator).
//    The Natural Earth 1:10m source geometry is far coarser than that, so this
//    is visually lossless at every zoom the app supports — it only strips
//    meaningless digits (the files ship ~15-decimal doubles). Consecutive
//    vertices that become identical after rounding are deduplicated; rings are
//    re-closed and left untouched if deduping would drop them below 4 points.
//    No geometric simplification: every meaningful vertex is kept.
//
// 2. Property pruning to the allowlists below. Natural Earth ships 100+ fields
//    per feature (multilingual names, wikidata ids, …) and they dominate the
//    file size — cities.geojson is ~95% properties. Geometry is untouched, so
//    this changes nothing visual. If a new feature needs another field, add it
//    to the allowlist here and re-run against a fresh Natural Earth download
//    (pruning is destructive to the repo copy; the source data is public).
//
// parks.geojson isn't Natural Earth: it's the official boundary polygons from
// the NPS Land Resources Division (https://irma.nps.gov/App/Reference/Profile/2196725),
// filtered to the 63 units NPS designates "National Park" and combined
// multi-polygon records into one Feature per park, the same way countries/states
// already work. LABEL_X/LABEL_Y come from the companion NPS boundary-centroids
// file, not a bbox center, so search fly-to lands on the same anchor point NPS
// itself uses.
//
// Usage: node scripts/trim-geojson.mjs
// Idempotent — safe to re-run after replacing a dataset.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data");

// Every property the app reads (IDs, popup text, stats, search), per dataset.
const KEEP = {
  "countries.geojson": [
    "ISO_A3", "ADM0_A3", "SOV_A3", // countryIso fallback chain
    "ADMIN", "NAME", "CONTINENT", // popups + continent stats
    "LABEL_X", "LABEL_Y", // label point: search fly-to anchor
  ],
  "states.geojson": [
    "iso_3166_2", "adm1_code", // stateIso fallback chain
    "admin", "name", "type_en", // popups + search context
    "name_alt", // alternate names, matched by search
    "longitude", "latitude", // label point: search fly-to anchor
  ],
  "cities.geojson": [
    "ADM0_A3", "ADM1NAME", "NAMEASCII", // cityId composite
    "NAME", "ADM0NAME", // popups + search context
    "POP_MAX", // search result ranking
  ],
  "parks.geojson": [
    "UNIT_CODE", // parkId — the NPS 4-letter unit code, stable and unique
    "UNIT_NAME", "STATE", // popups + search context
    "LABEL_X", "LABEL_Y", // label point (NPS boundary-dataset centroid): search fly-to anchor
  ],
};
const FILES = Object.keys(KEEP);
const FACTOR = 1e5; // 5 decimal places

function round(v) {
  return Math.round(v * FACTOR) / FACTOR;
}

function roundPosition(pos) {
  // Positions may carry altitude as a third element; round everything.
  return pos.map(round);
}

// Round a LineString / ring, dropping consecutive duplicates the rounding
// creates. Rings (closed=true) are re-closed and must keep >= 4 positions.
function roundLine(coords, closed) {
  const rounded = coords.map(roundPosition);
  const out = [rounded[0]];
  for (let i = 1; i < rounded.length; i++) {
    const prev = out[out.length - 1];
    const cur = rounded[i];
    if (cur[0] !== prev[0] || cur[1] !== prev[1]) out.push(cur);
  }
  if (closed) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
    if (out.length < 4) return rounded; // degenerate after dedupe — keep all vertices
  }
  return out;
}

function roundGeometry(geom) {
  if (!geom) return geom;
  switch (geom.type) {
    case "Point":
      return { ...geom, coordinates: roundPosition(geom.coordinates) };
    case "MultiPoint":
      return { ...geom, coordinates: geom.coordinates.map(roundPosition) };
    case "LineString":
      return { ...geom, coordinates: roundLine(geom.coordinates, false) };
    case "MultiLineString":
      return { ...geom, coordinates: geom.coordinates.map((l) => roundLine(l, false)) };
    case "Polygon":
      return { ...geom, coordinates: geom.coordinates.map((r) => roundLine(r, true)) };
    case "MultiPolygon":
      return {
        ...geom,
        coordinates: geom.coordinates.map((poly) => poly.map((r) => roundLine(r, true))),
      };
    case "GeometryCollection":
      return { ...geom, geometries: geom.geometries.map(roundGeometry) };
    default:
      throw new Error(`Unhandled geometry type: ${geom.type}`);
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

for (const name of FILES) {
  const path = resolve(DATA_DIR, name);
  const before = statSync(path).size;
  const fc = JSON.parse(readFileSync(path, "utf8"));
  const keep = KEEP[name];
  for (const f of fc.features) {
    f.geometry = roundGeometry(f.geometry);
    const props = {};
    for (const key of keep) {
      if (f.properties[key] !== undefined) props[key] = f.properties[key];
    }
    f.properties = props;
  }
  writeFileSync(path, JSON.stringify(fc));
  const after = statSync(path).size;
  console.log(
    `${name}: ${mb(before)} -> ${mb(after)} (${Math.round((1 - after / before) * 100)}% smaller, ${fc.features.length} features)`,
  );
}

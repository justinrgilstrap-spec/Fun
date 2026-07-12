import type { ContinentCount, Extremes, Furthest, FurthestPair } from "../geo/datasets";

interface Stats {
  countries: number;
  states: number;
  cities: number;
  /** National Parks visited (0–63). */
  parks: number;
  /** FBS schools with any VenueState set (campus/stadium/game all count), 0–138.
   *  FCS and MLB deliberately have no equivalent totalizer — search/mark-only. */
  fbs: number;
  /** Distinct continents touched (0–7). */
  continents: number;
  /** US states visited, or null when none — hides the US row for non-US users. */
  usStates: number | null;
  /** Per-continent country counts, ordered, omitting empty continents. */
  continentBreakdown: ContinentCount[];
  /** Compass extremes of visited cities; null until the cities dataset loads. */
  extremes: Extremes | null;
  /** Top 5 furthest visited cities from home, descending; [] without a home
   *  or before cities load. */
  furthest: Furthest[];
  /** The single furthest-apart pair of visited cities; null with fewer than
   *  2 visited cities or before cities load. */
  maxDistance: FurthestPair | null;
}

// Display abbreviations for the two long continent names — keeps chips compact in
// the 320px sidebar without abbreviating the short names.
const CONTINENT_ABBR: Record<string, string> = {
  "North America": "N. America",
  "South America": "S. America",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function continentBreakdown(items: ContinentCount[]): string {
  if (items.length === 0) return "";
  const chips = items
    .map(
      ({ continent, count }) => `
      <span class="continent-chip">
        <span class="continent-name">${escapeHtml(CONTINENT_ABBR[continent] ?? continent)}</span>
        <span class="continent-count">${count}</span>
      </span>`,
    )
    .join("");
  // The "all 7" badge lands the milestone the per-continent chips build toward.
  const badge =
    items.length === CONTINENTS ? `<span class="badge">🌍 All 7 continents</span>` : "";
  return `
    <div class="continent-section">
      <div class="continent-list">${chips}</div>
      ${badge}
    </div>
  `;
}

// Denominators for the completion bars.
const WORLD_COUNTRIES = 195; // UN members + observer states, the common traveler's total
const CONTINENTS = 7;
const US_STATES = 50;
const NATIONAL_PARKS = 63; // congressionally-designated "National Park" units, matching public/data/parks.geojson
const FBS_SCHOOLS = 138; // FBS membership for the 2026 season, matching public/data/fbs.json

function progressRow(label: string, value: number, total: number): string {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return `
    <div class="progress-row">
      <div class="progress-head">
        <span class="progress-label">${label}</span>
        <span class="progress-frac">${value}<span class="progress-total"> / ${total}</span></span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width: ${pct}%"></div></div>
    </div>
  `;
}

function extremesSection(ex: Extremes | null): string {
  if (!ex) return "";
  const row = (dir: string, place: string) => `
    <div class="extreme-row">
      <span class="extreme-dir">${dir}</span>
      <span class="extreme-place">${escapeHtml(place)}</span>
    </div>`;
  return `
    <div class="extremes-section">
      <h3 class="stat-subhead">Extremes</h3>
      <div class="extremes">
        ${row("N", ex.north.name)}
        ${row("S", ex.south.name)}
        ${row("E", ex.east.name)}
        ${row("W", ex.west.name)}
      </div>
    </div>
  `;
}

function furthestSection(list: Furthest[]): string {
  if (list.length === 0) return "";
  const rows = list
    .map(
      (f, i) => `
      <div class="furthest-row">
        <span class="furthest-rank">${i + 1}</span>
        <span class="furthest-name">${escapeHtml(f.name)}</span>
        <span class="furthest-dist">${Math.round(f.miles).toLocaleString()} mi</span>
      </div>`,
    )
    .join("");
  return `
    <div class="furthest-section">
      <h3 class="stat-subhead">Furthest from home</h3>
      <div class="furthest-list">${rows}</div>
    </div>
  `;
}

function maxDistanceSection(pair: FurthestPair | null): string {
  if (!pair) return "";
  const miles = Math.round(pair.miles).toLocaleString();
  return `
    <div class="max-distance">
      <span class="max-distance-label">Furthest apart</span>
      <span class="max-distance-value">${escapeHtml(pair.a)} \u2194 ${escapeHtml(pair.b)} · ${miles} mi</span>
    </div>
  `;
}

export function renderStats(el: HTMLElement, stats: Stats): void {
  el.hidden = false;
  const usRow = stats.usStates !== null ? progressRow("U.S. states", stats.usStates, US_STATES) : "";
  const parksRow = stats.parks > 0 ? progressRow("National Parks", stats.parks, NATIONAL_PARKS) : "";
  const fbsRow = stats.fbs > 0 ? progressRow("FBS Stadiums", stats.fbs, FBS_SCHOOLS) : "";
  el.innerHTML = `
    <h2>Your footprint</h2>
    <div class="stat-grid">
      <div class="stat-cell">
        <span class="stat-value">${stats.countries}</span>
        <span class="stat-label">Countries</span>
      </div>
      <div class="stat-cell">
        <span class="stat-value">${stats.states}</span>
        <span class="stat-label">Regions</span>
      </div>
      <div class="stat-cell">
        <span class="stat-value">${stats.cities}</span>
        <span class="stat-label">Cities</span>
      </div>
    </div>
    ${continentBreakdown(stats.continentBreakdown)}
    <div class="progress-list">
      ${progressRow("Countries", stats.countries, WORLD_COUNTRIES)}
      ${progressRow("Continents", stats.continents, CONTINENTS)}
      ${usRow}
      ${parksRow}
      ${fbsRow}
    </div>
    ${extremesSection(stats.extremes)}
    ${furthestSection(stats.furthest)}
    ${maxDistanceSection(stats.maxDistance)}
  `;
}

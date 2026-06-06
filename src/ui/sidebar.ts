import type { ContinentCount } from "../geo/datasets";

interface Stats {
  countries: number;
  states: number;
  cities: number;
  /** Distinct continents touched (0–7). */
  continents: number;
  /** US states visited, or null when none — hides the US row for non-US users. */
  usStates: number | null;
  /** Per-continent country counts, ordered, omitting empty continents. */
  continentBreakdown: ContinentCount[];
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

export function renderStats(el: HTMLElement, stats: Stats): void {
  el.hidden = false;
  const usRow = stats.usStates !== null ? progressRow("U.S. states", stats.usStates, US_STATES) : "";
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
    <div class="progress-list">
      ${progressRow("Countries", stats.countries, WORLD_COUNTRIES)}
      ${progressRow("Continents", stats.continents, CONTINENTS)}
      ${usRow}
    </div>
    ${continentBreakdown(stats.continentBreakdown)}
  `;
}

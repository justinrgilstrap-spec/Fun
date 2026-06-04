interface Stats {
  countries: number;
  states: number;
  cities: number;
}

export function renderStats(el: HTMLElement, stats: Stats): void {
  el.hidden = false;
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
  `;
}

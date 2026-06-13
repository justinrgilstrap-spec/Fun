import type { Feature } from "geojson";
import { loadCountries, loadStates, loadCities, countryIso, stateIso, cityId } from "../geo/datasets";
import type { LayerKind } from "../types";

/**
 * Place search over the three reference datasets — the same features the map
 * renders, so every result can be flown to and (in desktop write-mode) marked
 * visited. No external geocoder: nothing outside the markable universe shows up.
 */
export interface SearchHit {
  kind: LayerKind;
  /** The visited-set ID for this feature (countryIso / stateIso / cityId). */
  id: string;
  name: string;
  /** Where it is, e.g. "Georgia, United States" for a city. */
  context: string;
  feature: Feature;
}

interface Entry extends SearchHit {
  /** Normalized name + alternate names, what queries match against. */
  norm: string;
  /** Population for cities (rank tiebreak); 0 elsewhere. */
  pop: number;
}

export interface SearchOptions {
  onSelect: (hit: SearchHit) => void;
  isVisited: (kind: LayerKind, id: string) => boolean;
}

const MAX_RESULTS = 8;
const KIND_RANK: Record<LayerKind, number> = { countries: 0, states: 1, cities: 2 };
const KIND_LABEL: Record<LayerKind, string> = { countries: "Country", states: "Region", cities: "City" };

// Case- and diacritic-insensitive matching: "sao paulo" finds São Paulo.
function norm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function str(props: Record<string, unknown> | null | undefined, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}

// Flatten the (cached) datasets into one searchable list. Runs once, on first
// use; the awaited loads are what trigger the lazy states/cities downloads.
async function buildIndex(): Promise<Entry[]> {
  const [countries, states, cities] = await Promise.all([loadCountries(), loadStates(), loadCities()]);
  const out: Entry[] = [];
  for (const f of countries.features) {
    const p = f.properties;
    const name = str(p, "NAME") || str(p, "ADMIN");
    if (!name) continue;
    const continent = str(p, "CONTINENT");
    out.push({
      kind: "countries",
      id: countryIso(f),
      name,
      context: continent === "Seven seas (open ocean)" ? "" : continent,
      feature: f,
      norm: norm(`${name}|${str(p, "ADMIN")}`),
      pop: 0,
    });
  }
  for (const f of states.features) {
    const p = f.properties;
    const name = str(p, "name");
    if (!name) continue;
    out.push({
      kind: "states",
      id: stateIso(f),
      name,
      context: str(p, "admin"),
      feature: f,
      norm: norm(`${name}|${str(p, "name_alt")}`),
      pop: 0,
    });
  }
  for (const f of cities.features) {
    const p = f.properties;
    const name = str(p, "NAME") || str(p, "NAMEASCII");
    if (!name) continue;
    const region = str(p, "ADM1NAME");
    const country = str(p, "ADM0NAME");
    out.push({
      kind: "cities",
      id: cityId(f),
      name,
      context: [region, country].filter(Boolean).join(", "),
      feature: f,
      norm: norm(`${name}|${str(p, "NAMEASCII")}`),
      pop: typeof p?.POP_MAX === "number" ? p.POP_MAX : 0,
    });
  }
  return out;
}

// Match tier: prefix beats start-of-word beats mid-word. Null = no match.
function tierOf(entry: Entry, q: string): number | null {
  const idx = entry.norm.indexOf(q);
  if (idx < 0) return null;
  if (idx === 0) return 0;
  return /[a-z0-9]/.test(entry.norm[idx - 1]) ? 2 : 1;
}

function search(entries: Entry[], q: string): SearchHit[] {
  const scored: Array<{ entry: Entry; tier: number }> = [];
  for (const entry of entries) {
    const tier = tierOf(entry, q);
    if (tier !== null) scored.push({ entry, tier });
  }
  scored.sort((a, b) =>
    a.tier - b.tier ||
    KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind] ||
    b.entry.pop - a.entry.pop ||
    a.entry.name.localeCompare(b.entry.name),
  );
  return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
}

export function initSearch(opts: SearchOptions): void {
  const input = document.getElementById("search-input") as HTMLInputElement;
  const resultsEl = document.getElementById("search-results") as HTMLUListElement;

  let entries: Entry[] | null = null;
  let indexPromise: Promise<void> | null = null;
  let hits: SearchHit[] = [];
  let active = -1;

  // Kick the index build on first focus so the heavy datasets are usually ready
  // by the time a query is typed. Retried on the next interaction if it failed.
  function ensureIndex(): void {
    if (entries || indexPromise) return;
    indexPromise = buildIndex().then(
      (e) => {
        entries = e;
        runQuery();
      },
      (err) => {
        indexPromise = null;
        console.error("Search index failed to load:", err);
      },
    );
  }

  function close(): void {
    hits = [];
    active = -1;
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
  }

  function runQuery(): void {
    const q = norm(input.value.trim());
    if (q.length < 2) {
      close();
      return;
    }
    if (!entries) {
      renderLoading();
      return;
    }
    hits = search(entries, q);
    active = -1;
    render();
  }

  function renderLoading(): void {
    const li = document.createElement("li");
    li.className = "search-note";
    li.textContent = "Loading places…";
    resultsEl.replaceChildren(li);
    resultsEl.hidden = false;
  }

  function render(): void {
    if (hits.length === 0) {
      const li = document.createElement("li");
      li.className = "search-note";
      li.textContent = "No places found.";
      resultsEl.replaceChildren(li);
      resultsEl.hidden = false;
      return;
    }
    resultsEl.replaceChildren(
      ...hits.map((hit, i) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.i = String(i);
        btn.className = i === active ? "active" : "";
        const top = document.createElement("span");
        top.className = "search-hit-top";
        const name = document.createElement("span");
        name.className = "search-hit-name";
        name.textContent = hit.name;
        top.append(name);
        if (opts.isVisited(hit.kind, hit.id)) {
          const dot = document.createElement("span");
          dot.className = "search-hit-visited";
          dot.title = "Visited";
          top.append(dot);
        }
        const kind = document.createElement("span");
        kind.className = "search-hit-kind";
        kind.textContent = KIND_LABEL[hit.kind];
        top.append(kind);
        btn.append(top);
        if (hit.context) {
          const ctx = document.createElement("span");
          ctx.className = "search-hit-context";
          ctx.textContent = hit.context;
          btn.append(ctx);
        }
        li.append(btn);
        return li;
      }),
    );
    resultsEl.hidden = false;
  }

  function setActive(i: number): void {
    active = i;
    resultsEl.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.i === String(i));
    });
  }

  function select(i: number): void {
    const hit = hits[i];
    if (!hit) return;
    input.value = hit.name;
    input.blur();
    close();
    opts.onSelect(hit);
  }

  input.addEventListener("focus", () => {
    ensureIndex();
    runQuery();
  });
  input.addEventListener("input", () => {
    ensureIndex();
    runQuery();
  });
  // Close when focus leaves. Result clicks preventDefault on pointerdown, so
  // they never blur the input — this only fires for genuine focus loss.
  input.addEventListener("blur", close);

  input.addEventListener("keydown", (e) => {
    if (resultsEl.hidden || hits.length === 0) {
      if (e.key === "Escape") input.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((active + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((active - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(active >= 0 ? active : 0);
    } else if (e.key === "Escape") {
      input.blur();
    }
  });

  // pointerdown would steal focus from the input and fire its blur handler
  // before the click lands — suppress it so the click below always runs.
  resultsEl.addEventListener("pointerdown", (e) => e.preventDefault());
  resultsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (btn?.dataset.i) select(Number(btn.dataset.i));
  });
}

import {
  loadCountries, loadParks, loadStates, loadFbs, loadFcs, loadMlb,
  countryIso, parkId, parkName, stateIso,
  fbsId, fbsName, fbsConference, fcsId, fcsName, fcsConference, mlbId, mlbName,
} from "../geo/datasets";
import type { LayerKind, BinaryLayerKind, VenueState } from "../types";

/**
 * A "Browse & mark visited" modal. Six list-friendly tabs: Countries, National
 * Parks, and North American Regions (flat, alphabetical); FBS, FCS, and MLB
 * (Sports Venues). Regions worldwide and Cities are left out deliberately, at
 * 4,596 and 7,342 entries respectively a full checklist isn't a usable UI;
 * those stay map-click + search only.
 *
 * FBS/FCS are grouped by conference (alphabetical, schools alphabetical within)
 * rather than one flat list, per how Justin actually wants to browse them —
 * and because each row is a 3-way pick (campus/stadium/game), not a checkbox.
 * MLB is flat + a plain checkbox, same as Countries/Parks/Regions.
 *
 * Every control calls the same toggleVisited()/setVenueState() persistence the
 * map popups already use, so this is just another door into the identical
 * write path — no new storage, no new merge logic.
 */
export type ChecklistKind = "countries" | "parks" | "naRegions" | "fbs" | "mlb";

interface ChecklistEntry {
  id: string;
  name: string;
  context: string;
  /** The real VisitedFile/LayerKind this id persists under — "naRegions" is a
   *  UI-only filter over the same "states" data the full Regions layer uses,
   *  and "fbs" tab rows carry either "fbs" or "fcs" (see the merge below). */
  layerKind: LayerKind;
  /** Conference, for the fbs-tab group headers. Unused elsewhere. */
  conference?: string;
  /**
   * fbs-tab section order: 0 = Power 4 (ACC/Big 12/Big Ten/SEC), 1 = Independent,
   * 2 = the rest of FBS (Group of Five), 3 = FCS. Drives both the section
   * dividers and the sort order — Justin wants Power 4 schools front and
   * center since that's what the sidebar totalizer tracks, with everything
   * else still one tab away for search/browse but visually secondary.
   */
  tier?: number;
}

const POWER4_CONFERENCES = new Set(["ACC", "Big 12", "Big Ten", "SEC"]);

function fbsTier(conference: string): number {
  if (conference === "Independent") return 1;
  return POWER4_CONFERENCES.has(conference) ? 0 : 2;
}

// Natural Earth's exact ADMIN spelling for the three North American countries.
const NA_COUNTRIES = new Set(["United States of America", "Canada", "Mexico"]);

const TAB_LABEL: Record<ChecklistKind, string> = {
  countries: "Countries",
  parks: "National Parks",
  naRegions: "N. America Regions",
  fbs: "FBS",
  mlb: "MLB",
};

// Which control a tab's rows use. "tri" renders 3 small state buttons instead
// of a checkbox, and groups rows under conference headers (+ tier dividers,
// fbs tab only — see buildEntries).
const ROW_KIND: Record<ChecklistKind, "binary" | "tri"> = {
  countries: "binary",
  parks: "binary",
  naRegions: "binary",
  fbs: "tri",
  mlb: "binary",
};

function str(props: Record<string, unknown> | null | undefined, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}

// Built once per kind and cached — only the (small) name/context/id/conference
// fields, never the visited flag, which is always looked up live via
// opts.isVisited()/opts.venueState() so a stale cache can never show the wrong
// checked state.
const entryCache: Partial<Record<ChecklistKind, ChecklistEntry[]>> = {};

async function buildEntries(kind: ChecklistKind): Promise<ChecklistEntry[]> {
  const cached = entryCache[kind];
  if (cached) return cached;

  let entries: ChecklistEntry[];
  if (kind === "countries") {
    const fc = await loadCountries();
    entries = [];
    for (const f of fc.features) {
      const name = str(f.properties, "NAME") || str(f.properties, "ADMIN");
      if (!name) continue;
      const continent = str(f.properties, "CONTINENT");
      entries.push({
        id: countryIso(f),
        name,
        context: continent === "Seven seas (open ocean)" ? "" : continent,
        layerKind: "countries",
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } else if (kind === "parks") {
    const fc = await loadParks();
    entries = fc.features.map((f) => ({
      id: parkId(f),
      name: parkName(f),
      context: str(f.properties, "STATE"),
      layerKind: "parks",
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } else if (kind === "naRegions") {
    const fc = await loadStates();
    entries = [];
    for (const f of fc.features) {
      if (!NA_COUNTRIES.has(str(f.properties, "admin"))) continue;
      const name = str(f.properties, "name");
      if (!name) continue;
      entries.push({
        id: stateIso(f),
        name,
        context: str(f.properties, "admin"),
        layerKind: "states",
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
  } else if (kind === "fbs") {
    // The fbs tab covers both FBS and FCS — Justin wants Power 4 + Independent
    // front and center (that's what the sidebar totalizer tracks), then the
    // rest of FBS, then all of FCS, still one tab away rather than a
    // separate one. tier drives both the sort order and the section dividers
    // renderList inserts between buckets.
    const [fbsFc, fcsFc] = await Promise.all([loadFbs(), loadFcs()]);
    const fbsEntries: ChecklistEntry[] = fbsFc.features.map((f) => {
      const conference = fbsConference(f);
      return {
        id: fbsId(f),
        name: fbsName(f),
        context: conference,
        conference,
        layerKind: "fbs",
        tier: fbsTier(conference),
      };
    });
    const fcsEntries: ChecklistEntry[] = fcsFc.features.map((f) => {
      const conference = fcsConference(f);
      return {
        id: fcsId(f),
        name: fcsName(f),
        context: conference,
        conference,
        layerKind: "fcs",
        tier: 3,
      };
    });
    entries = [...fbsEntries, ...fcsEntries];
    // tier first (Power 4 → Independent → rest of FBS → FCS), conference
    // alphabetical within a tier, school alphabetical within a conference.
    entries.sort(
      (a, b) =>
        (a.tier ?? 0) - (b.tier ?? 0) ||
        (a.conference ?? "").localeCompare(b.conference ?? "") ||
        a.name.localeCompare(b.name),
    );
  } else {
    const fc = await loadMlb();
    entries = fc.features.map((f) => ({
      id: mlbId(f),
      name: mlbName(f),
      context: str(f.properties, "STADIUM"),
      layerKind: "mlb",
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  entryCache[kind] = entries;
  return entries;
}

export interface ChecklistOptions {
  isVisited: (kind: LayerKind, id: string) => boolean;
  /** Same shape as layers.ts's ToggleHandler — flips the entry and persists it.
   *  Used for every binary tab (countries/parks/naRegions/mlb). */
  onToggle: (kind: BinaryLayerKind, id: string) => Promise<boolean>;
  /** The current VenueState for an fbs/fcs id, or undefined if unvisited. */
  venueState: (kind: "fbs" | "fcs", id: string) => VenueState | undefined;
  /** Sets (or, re-picking the active state, clears) an fbs/fcs id's state. */
  onSetVenueState: (kind: "fbs" | "fcs", id: string, state: VenueState) => Promise<VenueState | null>;
  /** Gates whether controls are interactive — false in the read-only browser build. */
  canToggle: () => boolean;
}

export interface ChecklistHandle {
  /** Re-renders the currently open tab against the latest visited state.
   *  Cheap no-op if the modal isn't open. Call after any import/toggle. */
  refresh: () => void;
}

const VENUE_STATE_LABEL: Record<VenueState, string> = { campus: "Campus", stadium: "Stadium", game: "Game" };

export function initChecklist(opts: ChecklistOptions): ChecklistHandle {
  const openBtn = document.getElementById("checklist-open") as HTMLButtonElement;
  const modal = document.getElementById("checklist-modal") as HTMLElement;
  const backdrop = document.getElementById("checklist-backdrop") as HTMLElement;
  const closeBtn = document.getElementById("checklist-close") as HTMLButtonElement;
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".checklist-tab"));
  const searchInput = document.getElementById("checklist-search") as HTMLInputElement;
  const countEl = document.getElementById("checklist-count") as HTMLElement;
  const listEl = document.getElementById("checklist-items") as HTMLUListElement;

  let activeTab: ChecklistKind = "countries";
  let currentEntries: ChecklistEntry[] = [];

  function renderNote(text: string): void {
    const li = document.createElement("li");
    li.className = "checklist-note";
    li.textContent = text;
    listEl.replaceChildren(li);
  }

  function binaryRow(entry: ChecklistEntry, canToggle: boolean): HTMLLIElement {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "checklist-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = opts.isVisited(entry.layerKind, entry.id);
    checkbox.disabled = !canToggle;
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        await opts.onToggle(entry.layerKind as BinaryLayerKind, entry.id);
      } finally {
        renderList(searchInput.value);
      }
    });
    const name = document.createElement("span");
    name.className = "checklist-name";
    name.textContent = entry.name;
    label.append(checkbox, name);
    if (entry.context) {
      const ctx = document.createElement("span");
      ctx.className = "checklist-context";
      ctx.textContent = entry.context;
      label.append(ctx);
    }
    li.append(label);
    return li;
  }

  function triRow(entry: ChecklistEntry, canToggle: boolean): HTMLLIElement {
    const kind = entry.layerKind as "fbs" | "fcs";
    const current = opts.venueState(kind, entry.id);
    const li = document.createElement("li");
    li.className = "checklist-row checklist-row-tri";
    const name = document.createElement("span");
    name.className = "checklist-name";
    name.textContent = entry.name;
    li.append(name);
    const btns = document.createElement("span");
    btns.className = "checklist-venue-btns";
    (Object.keys(VENUE_STATE_LABEL) as VenueState[]).forEach((state) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `checklist-venue-btn${current === state ? " is-active" : ""}`;
      btn.textContent = VENUE_STATE_LABEL[state];
      btn.disabled = !canToggle;
      btn.addEventListener("click", async () => {
        btns.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          await opts.onSetVenueState(kind, entry.id, state);
        } finally {
          renderList(searchInput.value);
        }
      });
      btns.append(btn);
    });
    li.append(btns);
    return li;
  }

  function renderList(query: string): void {
    if (currentEntries.length === 0) {
      countEl.textContent = "";
      renderNote("Loading…");
      return;
    }
    const q = query.trim().toLowerCase();
    const filtered = q ? currentEntries.filter((e) => e.name.toLowerCase().includes(q)) : currentEntries;
    const visitedCount =
      ROW_KIND[activeTab] === "tri"
        ? currentEntries.filter((e) => opts.venueState(e.layerKind as "fbs" | "fcs", e.id) !== undefined).length
        : currentEntries.filter((e) => opts.isVisited(e.layerKind, e.id)).length;
    countEl.textContent = `${visitedCount} / ${currentEntries.length} visited`;

    if (filtered.length === 0) {
      renderNote("No matches.");
      return;
    }
    const canToggle = opts.canToggle();
    if (ROW_KIND[activeTab] === "binary") {
      listEl.replaceChildren(...filtered.map((entry) => binaryRow(entry, canToggle)));
      return;
    }
    // Grouped rendering for the fbs tab: a header row whenever the conference
    // changes as we walk the (already tier + conference-sorted) filtered
    // list, plus a bigger section divider whenever the tier changes (Power 4
    // → Independent → rest of FBS → FCS) so the four buckets read as
    // distinct sections, not just a long run of conference headers.
    const rows: HTMLLIElement[] = [];
    let lastConference: string | undefined;
    let lastTier: number | undefined;
    for (const entry of filtered) {
      if (entry.tier !== undefined && entry.tier !== lastTier) {
        lastTier = entry.tier;
        if (entry.tier === 2 || entry.tier === 3) {
          const divider = document.createElement("li");
          divider.className = "checklist-section-divider";
          divider.textContent = entry.tier === 2 ? "Group of Five" : "FCS";
          rows.push(divider);
        }
      }
      if (entry.conference !== lastConference) {
        lastConference = entry.conference;
        const header = document.createElement("li");
        header.className = "checklist-group-header";
        header.textContent = entry.conference || "Independent";
        rows.push(header);
      }
      rows.push(triRow(entry, canToggle));
    }
    listEl.replaceChildren(...rows);
  }

  async function activateTab(kind: ChecklistKind): Promise<void> {
    activeTab = kind;
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
    currentEntries = [];
    renderList("");
    currentEntries = await buildEntries(kind);
    // A tab switch mid-fetch could have moved on by the time this resolves;
    // only render if we're still looking at the tab that triggered it.
    if (activeTab === kind) renderList(searchInput.value);
  }

  function open(): void {
    modal.hidden = false;
    searchInput.value = "";
    void activateTab(activeTab);
    searchInput.focus();
  }
  function close(): void {
    modal.hidden = true;
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });
  searchInput.addEventListener("input", () => renderList(searchInput.value));
  tabButtons.forEach((btn) => {
    btn.textContent = TAB_LABEL[btn.dataset.kind as ChecklistKind];
    btn.addEventListener("click", () => void activateTab(btn.dataset.kind as ChecklistKind));
  });

  return {
    refresh: () => {
      if (!modal.hidden) renderList(searchInput.value);
    },
  };
}

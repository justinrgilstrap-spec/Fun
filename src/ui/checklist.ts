import { loadCountries, loadParks, loadStates, countryIso, parkId, parkName, stateIso } from "../geo/datasets";
import type { LayerKind } from "../types";

/**
 * A "Browse & mark visited" modal: three list-friendly tabs (Countries,
 * National Parks, and North American Regions — Regions worldwide and Cities
 * are left out deliberately, at 4,596 and 7,342 entries respectively a full
 * checklist isn't a usable UI; those stay map-click + search only). Every
 * checkbox calls the same toggleVisited() persistence the map popups already
 * use, so this is just another way to reach the identical write path — no new
 * storage, no new merge logic.
 */
export type ChecklistKind = "countries" | "parks" | "naRegions";

interface ChecklistEntry {
  id: string;
  name: string;
  context: string;
  /** The real VisitedFile/LayerKind this id persists under — "naRegions" is a
   *  UI-only filter over the same "states" data the full Regions layer uses. */
  layerKind: LayerKind;
}

// Natural Earth's exact ADMIN spelling for the three North American countries.
const NA_COUNTRIES = new Set(["United States of America", "Canada", "Mexico"]);

const TAB_LABEL: Record<ChecklistKind, string> = {
  countries: "Countries",
  parks: "National Parks",
  naRegions: "N. America Regions",
};

function str(props: Record<string, unknown> | null | undefined, key: string): string {
  const v = props?.[key];
  return typeof v === "string" ? v : "";
}

// Built once per kind and cached — only the (small) name/context/id fields,
// never the visited flag, which is always looked up live via opts.isVisited()
// so a stale cache can never show the wrong checked state.
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
  } else if (kind === "parks") {
    const fc = await loadParks();
    entries = fc.features.map((f) => ({
      id: parkId(f),
      name: parkName(f),
      context: str(f.properties, "STATE"),
      layerKind: "parks",
    }));
  } else {
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
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entryCache[kind] = entries;
  return entries;
}

export interface ChecklistOptions {
  isVisited: (kind: LayerKind, id: string) => boolean;
  /** Same shape as layers.ts's ToggleHandler — flips the entry and persists it. */
  onToggle: (kind: LayerKind, id: string) => Promise<boolean>;
  /** Gates whether checkboxes are interactive — false in the read-only browser build. */
  canToggle: () => boolean;
}

export interface ChecklistHandle {
  /** Re-renders the currently open tab against the latest visited state.
   *  Cheap no-op if the modal isn't open. Call after any import/toggle. */
  refresh: () => void;
}

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

  function renderList(query: string): void {
    if (currentEntries.length === 0) {
      countEl.textContent = "";
      renderNote("Loading…");
      return;
    }
    const q = query.trim().toLowerCase();
    const filtered = q ? currentEntries.filter((e) => e.name.toLowerCase().includes(q)) : currentEntries;
    const visitedCount = currentEntries.filter((e) => opts.isVisited(e.layerKind, e.id)).length;
    countEl.textContent = `${visitedCount} / ${currentEntries.length} visited`;

    if (filtered.length === 0) {
      renderNote("No matches.");
      return;
    }
    const canToggle = opts.canToggle();
    listEl.replaceChildren(
      ...filtered.map((entry) => {
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
            await opts.onToggle(entry.layerKind, entry.id);
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
      }),
    );
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

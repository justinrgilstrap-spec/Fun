import { readTextFile, writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { HomePoint, RawTimelineImport, VisitedFile } from "../types";

const VISITED_URL = `${import.meta.env.BASE_URL}data/visited.json`;

const EMPTY: VisitedFile = { countries: [], states: [], cities: [], updatedAt: 0 };

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let dataDirCache: string | null = null;
async function getDataDir(): Promise<string> {
  if (dataDirCache) return dataDirCache;
  dataDirCache = await invoke<string>("get_data_dir");
  return dataDirCache;
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_") || "import.json";
  return cleaned.endsWith(".json") ? cleaned : `${cleaned}.json`;
}

// A home pin is only kept if it's well-formed: numeric coords + a string label.
// Anything else (old files, hand-edits) is dropped, leaving `home` undefined.
function normalizeHome(home: unknown): HomePoint | undefined {
  if (!home || typeof home !== "object") return undefined;
  const h = home as Record<string, unknown>;
  if (typeof h.lat !== "number" || !Number.isFinite(h.lat)) return undefined;
  if (typeof h.lon !== "number" || !Number.isFinite(h.lon)) return undefined;
  return { lat: h.lat, lon: h.lon, label: typeof h.label === "string" ? h.label : "" };
}

function normalizeVisitedShape(data: Partial<VisitedFile>): VisitedFile {
  const home = normalizeHome(data.home);
  return {
    countries: Array.isArray(data.countries) ? data.countries : [],
    states: Array.isArray(data.states) ? data.states : [],
    cities: Array.isArray(data.cities) ? data.cities : [],
    ...(home ? { home } : {}),
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
  };
}

export async function loadVisited(): Promise<VisitedFile> {
  if (isTauri()) {
    try {
      const dir = await getDataDir();
      const path = `${dir}/visited.json`;
      if (!(await exists(path))) return { ...EMPTY };
      const text = await readTextFile(path);
      return normalizeVisitedShape(JSON.parse(text) as Partial<VisitedFile>);
    } catch (err) {
      console.error("loadVisited (Tauri) failed:", err);
      return { ...EMPTY };
    }
  }

  try {
    const res = await fetch(`${VISITED_URL}?t=${Date.now()}`);
    if (!res.ok) return { ...EMPTY };
    return normalizeVisitedShape((await res.json()) as Partial<VisitedFile>);
  } catch {
    return { ...EMPTY };
  }
}

export async function saveVisited(merged: Omit<VisitedFile, "updatedAt">): Promise<VisitedFile> {
  if (!isTauri()) {
    throw new Error("Save is not supported in browser mode. Open the Footprint app to save changes.");
  }
  const dir = await getDataDir();
  const path = `${dir}/visited.json`;
  const payload: VisitedFile = {
    countries: Array.from(new Set(merged.countries)).sort(),
    states: Array.from(new Set(merged.states)).sort(),
    cities: Array.from(new Set(merged.cities)).sort(),
    ...(merged.home ? { home: merged.home } : {}),
    updatedAt: Date.now(),
  };
  await mkdir(dir, { recursive: true });
  await writeTextFile(path, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

export async function saveRawImport(filename: string, data: RawTimelineImport): Promise<void> {
  if (!isTauri()) {
    throw new Error("Raw import save is not supported in browser mode.");
  }
  const dir = await getDataDir();
  const rawDir = `${dir}/timeline-raw`;
  const safe = sanitizeFilename(filename);
  await mkdir(rawDir, { recursive: true });
  await writeTextFile(`${rawDir}/${safe}`, JSON.stringify(data, null, 2) + "\n");
}

export function mergeVisited(
  base: VisitedFile,
  add: { countries?: Iterable<string>; states?: Iterable<string>; cities?: Iterable<string> },
): Omit<VisitedFile, "updatedAt"> {
  // Carry the existing home through — an import adds places, it must never wipe it.
  return {
    countries: Array.from(new Set([...base.countries, ...(add.countries ?? [])])).sort(),
    states: Array.from(new Set([...base.states, ...(add.states ?? [])])).sort(),
    cities: Array.from(new Set([...base.cities, ...(add.cities ?? [])])).sort(),
    ...(base.home ? { home: base.home } : {}),
  };
}

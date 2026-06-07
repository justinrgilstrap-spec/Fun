import type { Map as MlMap } from "maplibre-gl";
import { showToast } from "./toast";

export interface SnapshotStats {
  countries: number;
  states: number;
  cities: number;
}

// Composite the live map canvas with a headline-stats caption strip into a PNG
// and trigger a download. Relies on the map being created with
// preserveDrawingBuffer:true (see createMap) so getCanvas() still holds pixels.
// Colours and fonts are read from the active theme's CSS variables, so the card
// matches light/dark and the in-app type.
export async function saveSnapshot(map: MlMap, stats: SnapshotStats): Promise<void> {
  const src = map.getCanvas();
  // Work in device pixels so the export stays crisp on HiDPI screens.
  const w = src.width;
  const h = src.height;
  const scale = src.clientWidth ? w / src.clientWidth : 1;

  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const panel = v("--panel", "#ffffff");
  const text = v("--text", "#1a1614");
  const muted = v("--muted", "#6b6b6b");
  const accent = v("--accent", "#cc6b49");
  const border = v("--border", "#e8dfd0");
  const fontSans = v("--font-sans", "sans-serif");
  const fontSerif = v("--font-serif", "serif");

  const stripH = Math.round(96 * scale);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h + stripH;
  const ctx = out.getContext("2d");
  if (!ctx) {
    showToast("Couldn't create the snapshot.", { variant: "error" });
    return;
  }

  // Ensure the variable fonts are loaded before drawing text into the canvas,
  // otherwise the headline can fall back to a system font.
  try {
    await document.fonts.ready;
  } catch {
    /* non-fatal — fall back to whatever's available */
  }

  // Map image on top.
  ctx.drawImage(src, 0, 0, w, h);

  // Caption strip below the map.
  ctx.fillStyle = panel;
  ctx.fillRect(0, h, w, stripH);
  ctx.fillStyle = border;
  ctx.fillRect(0, h, w, Math.max(1, Math.round(scale)));

  const cx = w / 2;

  // Small accent rule as a brand flourish above the headline.
  const ruleW = Math.round(30 * scale);
  ctx.fillStyle = accent;
  ctx.fillRect(cx - ruleW / 2, h + Math.round(20 * scale), ruleW, Math.max(1, Math.round(2 * scale)));

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Headline in the serif used for the big sidebar numbers.
  ctx.fillStyle = text;
  ctx.font = `500 ${Math.round(22 * scale)}px ${fontSerif}`;
  ctx.fillText(headline(stats), cx, h + Math.round(50 * scale));

  // Footer.
  ctx.fillStyle = muted;
  ctx.font = `500 ${Math.round(12 * scale)}px ${fontSans}`;
  ctx.fillText("Made with Footprint", cx, h + Math.round(76 * scale));

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
  if (!blob) {
    showToast("Couldn't create the snapshot.", { variant: "error" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "footprint.png";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Snapshot saved.", { variant: "success" });
}

function headline(s: SnapshotStats): string {
  const c = `${s.countries} ${plural(s.countries, "country", "countries")}`;
  const r = `${s.states} ${plural(s.states, "region", "regions")}`;
  const t = `${s.cities} ${plural(s.cities, "city", "cities")}`;
  return `${c} · ${r} · ${t}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

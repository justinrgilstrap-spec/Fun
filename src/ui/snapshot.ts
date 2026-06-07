import type { Map as MlMap } from "maplibre-gl";
import { showToast } from "./toast";

export interface SnapshotStats {
  countries: number;
  states: number;
  cities: number;
}

// A sub-rectangle of the map canvas, in device pixels. When passed, only this
// region is drawn onto the card — used to crop the export to the exact world
// bounds so the card is always landscape and edge-to-edge, regardless of the
// live map pane's shape. Omit to use the whole canvas.
export interface SnapshotCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// Composite the live map canvas with a headline-stats caption strip into a PNG
// and trigger a download. Relies on the map being created with
// preserveDrawingBuffer:true (see createMap) so getCanvas() still holds pixels.
// Colours and fonts are read from the active theme's CSS variables, so the card
// matches light/dark and the in-app type.
export async function saveSnapshot(
  map: MlMap,
  stats: SnapshotStats,
  crop?: SnapshotCrop,
): Promise<void> {
  const src = map.getCanvas();
  // Work in device pixels so the export stays crisp on HiDPI screens.
  const scale = src.clientWidth ? src.width / src.clientWidth : 1;
  // The map area of the card: the crop if given, else the whole canvas.
  const sx = crop ? crop.sx : 0;
  const sy = crop ? crop.sy : 0;
  const w = Math.round(crop ? crop.sw : src.width);
  const h = Math.round(crop ? crop.sh : src.height);

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

  // Map image on top — the cropped world region (or whole canvas) at 1:1.
  ctx.drawImage(src, sx, sy, w, h, 0, 0, w, h);

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

  const file = new File([blob], "footprint.png", { type: "image/png" });

  // Prefer the native share sheet (Web Share API) when the browser can share a
  // file — iOS Safari, Android Chrome, macOS Safari, the Tauri WebKit shell. No
  // native app or developer account needed. Falls back to a plain download where
  // file-sharing isn't supported (desktop Firefox, some desktop Chrome configs).
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "My Footprint",
        text: `${headline(stats)} — mapped with Footprint`,
      });
      return; // The OS share sheet is its own confirmation.
    } catch (err) {
      // User dismissed the sheet — not an error, nothing more to do.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Any other failure (e.g. share unavailable at call time): fall through to
      // the download so the action still does something.
    }
  }

  downloadBlob(blob);
  showToast("Snapshot saved.", { variant: "success" });
}

function downloadBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "footprint.png";
  a.click();
  URL.revokeObjectURL(url);
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

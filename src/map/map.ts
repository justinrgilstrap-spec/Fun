import maplibregl, { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapTheme = "light" | "dark";
export type MapProjection = "flat" | "globe";

// Vendored CARTO vector basemaps (Positron for light, Dark Matter for dark),
// served from public/basemap/. They're the upstream CARTO GL styles with the
// `place_continent` layer stripped — that's the only label we don't want. Country
// /state/city labels in these styles already use {name_en}, so text renders in
// English (the multilingual sprawl only existed in the raster `*_all` tiles).
// Tiles, glyphs, and sprites load from tiles.basemaps.cartocdn.com, which the
// existing CSP wildcard already covers, so bundling the style needs no CSP change.
function styleUrl(theme: MapTheme): string {
  const file = theme === "dark" ? "dark-matter" : "positron";
  return `${import.meta.env.BASE_URL}basemap/${file}.json`;
}

export function createMap(container: HTMLElement, theme: MapTheme): MlMap {
  const map = new maplibregl.Map({
    container,
    style: styleUrl(theme),
    center: [0, 25],
    zoom: 1.4,
    minZoom: 1,
    maxZoom: 16,
    renderWorldCopies: false,
    // Retain the WebGL backbuffer so the snapshot feature can read pixels off the
    // canvas (getCanvas().toDataURL / drawImage) at any time, not just mid-frame.
    // In MapLibre v5 this lives under canvasContextAttributes.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  return map;
}

// Switch between the flat mercator map and the 3D globe. The map is constructed
// fully locked down (no rotate/pitch — see createMap); globe mode selectively
// unlocks drag-rotate + tilt so the sphere feels alive, and flat mode re-locks it.
// Projection lives in the style, so a theme change (setStyle) resets it to
// mercator — main.ts re-applies the chosen projection after every theme switch.
export function setProjection(map: MlMap, projection: MapProjection): void {
  if (projection === "globe") {
    map.setMaxPitch(85);
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.setProjection({ type: "globe" });
  } else {
    // Undo any bearing/tilt the globe allowed before re-locking, so the flat map
    // never ends up rotated or pitched.
    map.jumpTo({ bearing: 0, pitch: 0 });
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.setMaxPitch(0);
    map.setProjection({ type: "mercator" });
  }
}

export function setMapTheme(map: MlMap, theme: MapTheme): Promise<void> {
  return new Promise((resolve) => {
    const onStyleLoad = () => {
      map.off("style.load", onStyleLoad);
      resolve();
    };
    map.on("style.load", onStyleLoad);
    map.setStyle(styleUrl(theme));
  });
}

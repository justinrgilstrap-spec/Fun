import maplibregl, { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapTheme = "light" | "dark";

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

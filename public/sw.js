// Offline support for the web/PWA build. Registered by main.ts in production
// browser builds only (never in dev or the Tauri shell).
//
// Strategy:
// - App shell ("./", manifest, basemap styles, logo): precached at install;
//   navigations are network-first with the cached shell as offline fallback.
// - Reference data + visited.json: stale-while-revalidate — served instantly
//   from cache (this is what makes offline work), refreshed in the background
//   so the next open shows newly synced data. The background fetch rides the
//   HTTP cache's validators, so an unchanged 26 MB GeoJSON costs a 304.
// - Hashed /assets/ bundles + fonts: cache-first (immutable by construction).
// - CARTO basemap tiles/glyphs/sprites: cache-first, capped — recently viewed
//   areas keep their basemap detail offline; everything else still renders
//   from the local GeoJSON (fills, outlines, dots).
//
// Bump VERSION whenever the caching logic here changes — it drops old caches.

const VERSION = "v1";
const CACHE = `footprint-${VERSION}`;
const TILE_CACHE = `footprint-tiles-${VERSION}`;
const TILE_LIMIT = 600;

const PRECACHE = [
  "./",
  "./manifest.webmanifest",
  "./logo.svg",
  "./basemap/positron.json",
  "./basemap/dark-matter.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // visited.json is fetched with a ?t= cache-buster — key it by pathname so
    // every load updates the same entry instead of growing the cache.
    if (url.pathname.endsWith("/data/visited.json")) {
      event.respondWith(staleWhileRevalidate(req, url.pathname));
      return;
    }
    if (url.pathname.endsWith(".geojson") || url.pathname.includes("/basemap/")) {
      event.respondWith(staleWhileRevalidate(req, req));
      return;
    }
    if (req.mode === "navigate") {
      event.respondWith(
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("./", copy));
            return res;
          })
          .catch(() => caches.match("./")),
      );
      return;
    }
    event.respondWith(cacheFirst(req, CACHE));
    return;
  }

  if (url.hostname.endsWith(".basemaps.cartocdn.com")) {
    event.respondWith(tileCacheFirst(req));
  }
});

async function staleWhileRevalidate(req, cacheKey) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey);
  const refresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(cacheKey, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached ?? refresh;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    trimTiles(cache); // async, best-effort — never blocks the response
  }
  return res;
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  // cache.keys() is insertion-ordered: drop the oldest overflow.
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
}

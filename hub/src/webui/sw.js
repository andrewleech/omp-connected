// Service worker for the installed dashboard. It only handles top-level page
// loads: network first, and when the hub can't be reached (device off the
// tailnet, hub stopped) it serves a cached offline page instead of the
// browser's generic error. Assets, API, WebSocket and the embedded Collab
// guest frame are never intercepted, so live data always comes from the hub.
//
// build-webui.ts replaces __OFFLINE_HASH__ with a hash of offline.html, so a
// changed offline page changes this script and triggers a worker update.
const CACHE = "ompc-offline-__OFFLINE_HASH__";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate" || request.destination !== "document") return;
  event.respondWith(
    fetch(request).catch(
      async () => (await caches.match(OFFLINE_URL)) ?? Response.error(),
    ),
  );
});

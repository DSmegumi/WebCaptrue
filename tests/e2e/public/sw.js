self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
self.addEventListener("message", event => {
  if (event.data === "capture-fetch") event.waitUntil(fetch("/api/items?from=service-worker"));
});

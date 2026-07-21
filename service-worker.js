const CACHE = "crypto-hourly-desk-v4-social";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./icon.svg", "./data/market-opportunities-hourly-latest.json", "./data/market-opportunities-daily-latest.json", "./data/market-opportunities-long-term-latest.json"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => { if (event.request.method !== "GET") return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });

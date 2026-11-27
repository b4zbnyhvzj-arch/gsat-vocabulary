const VERSION = "v0.8.1";
const scope = new URL(self.registration.scope);
const cachePrefix = `gsat-vocabulary:${scope.href}:`;
const cacheName = cachePrefix + VERSION;
const ocrRuntime=new URL("./ocr-runtime/",scope);
const ocrCache="gsat-photo-ocr:"+ocrRuntime.href+":paddle-0.4.2-r1";
const index = new URL("./index.html", scope);
const assets = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./quiz.js",
  "./storage.js",
  "./bank.js",
  "./photo-import-ui.js",
  "./photo-batch.js",
  "./photo-ocr.js",
  "./ocr-assets.js",
  "./ocr-lab/selection.js",
  "./ocr-lab/black-selection.js",
  "./ocr-lab/entry-bands.js",
  "./ocr-lab/local-recovery.js",
  "./ocr-lab/page-records.js",
  "./ocr-lab/entry-parser.js",
  "./ocr-lab/entry-forms.js",
  "./ocr-lab/entry-review.js",
  "./ocr-lab/entry-candidate.js",
  "./ocr-lab/selection-review.js",
  "./data/units.json",
  "./data/words.json",
  "./data/quiz-settings.json",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
].map(path => new URL(path, scope).href);
const assetUrls = new Set(assets);

self.addEventListener("install", event => {
  // An incomplete release must fail installation and leave the active worker intact.
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(assets.map(url => new Request(url, { cache: "reload", redirect: "error" })));
  })());
});

self.addEventListener("activate", event => {
  // No skipWaiting: an installed update waits until existing clients are closed.
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.href.startsWith(ocrRuntime.href)) {
    event.respondWith(caches.match(url.href,{cacheName:ocrCache}).then(response=>response??fetch(event.request)));
    return;
  }
  const appNavigation = event.request.mode === "navigate" && url.origin === scope.origin &&
    (url.pathname === scope.pathname || url.pathname === index.pathname);
  if (!appNavigation && !assetUrls.has(url.href)) return;

  const cachedUrl = appNavigation ? index.href : url.href;
  event.respondWith(caches.match(cachedUrl, { cacheName }).then(response => response ?? fetch(event.request)));
});

self.addEventListener("message", event => {
  const reply = event.ports[0];
  if (event.data?.type !== "GSAT_CHECK_OFFLINE" || !reply) return;

  event.waitUntil((async () => {
    let ready = false;
    try {
      const responses = await Promise.all(assets.map(url => caches.match(url, { cacheName })));
      ready = responses.every(response => response?.ok);
    } catch {
      // A cache read failure cannot be reported as offline ready.
    }
    reply.postMessage({ ready });
  })());
});

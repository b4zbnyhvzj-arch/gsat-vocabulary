const scope = new URL(self.registration.scope);
const cacheName = `gsat-ocr-lab:${scope.pathname}:v0.7.1`;
const manifestURL = new URL("assets.json", scope).href;
const names = new Set(["paddle", "tesseract"]);
const assetURL = path => {
  const url = new URL(path, scope);
  if (!url.href.startsWith(scope.href)) throw new Error("資源路徑超出 OCR Lab。");
  return url.href;
};

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const manifest = await fetch(manifestURL, { cache: "reload" });
    if (!manifest.ok) throw new Error("缺少 OCR 資源清單。");
    const info = await manifest.clone().json();
    if (info.version !== "0.7.1") throw new Error("OCR 資源版本不符。");
    const cache = await caches.open(cacheName);
    await cache.addAll(info.shell.map(asset => new Request(assetURL(asset.path), { cache: "reload" })));
    await cache.put(manifestURL, manifest);
  })());
});
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

let downloading;
self.addEventListener("message", event => {
  const { action, engine } = event.data ?? {};
  const reply = event.ports[0];
  if (!reply || !names.has(engine) || !["status", "download"].includes(action)) return;
  event.waitUntil((async () => {
    try {
      if (action === "download" && downloading) throw new Error("已有資源正在下載。");
      if (action === "download") downloading = true;
      try {
        const cache = await caches.open(cacheName);
        const manifest = await (await cache.match(manifestURL)).json();
        const items = manifest.engines[engine];
        const total = items.reduce((sum, item) => sum + item.bytes, 0);
        let received = 0;
        for (const {path, bytes} of items) {
          const url = assetURL(path);
          if (await cache.match(url)) received += bytes;
          else if (action === "download") {
            reply.postMessage({type:"progress", received, total, path});
            const response = await fetch(url, { signal: AbortSignal.timeout(150000) });
            if (!response.ok) throw new Error(`HTTP ${response.status} · ${path}`);
            await cache.put(url, response);
            received += bytes;
            reply.postMessage({type:"progress", received, total, path});
          }
        }
        reply.postMessage({type:"done", ready:received===total, received, total});
      } finally {
        if (action === "download") downloading = false;
      }
    } catch (error) { reply.postMessage({type:"error", message:error.message}); }
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || !event.request.url.startsWith(scope.href)) return;
  const url = new URL(event.request.url);
  const home = event.request.mode === "navigate" &&
    (url.pathname === scope.pathname || url.pathname === new URL("index.html",scope).pathname);
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(home ? assetURL("index.html") : event.request) ?? fetch(event.request);
  })());
});

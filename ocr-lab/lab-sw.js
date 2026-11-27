const scope = new URL(self.registration.scope);
const cacheName = `gsat-ocr-lab:${scope.pathname}:v0.7.5`;
const manifestURL = new URL("assets.json", scope).href;
const names = new Set(["paddle", "tesseract"]);
const assetURL = path => {
  const url = new URL(path, scope);
  if (!url.href.startsWith(scope.href)) throw new Error("資源路徑超出 OCR Lab。");
  return url.href;
};

const hex = data => Array.from(new Uint8Array(data), byte=>byte.toString(16).padStart(2,"0")).join("");
async function reuseEngineAssets(cache, info) {
  // The stable public release and the previous local build share this scope,
  // but have different shell caches. Never consult the formal App caches.
  const known=new Set(await caches.keys());
  const entries=[...new Map(Object.values(info.engines).flat().map(item=>[item.path,item])).values()];
  for(const version of ["v0.7.4","v0.7.3","v0.7.2","v0.7.1"]){
    const label=`gsat-ocr-lab:${scope.pathname}:${version}`;
    if(!known.has(label))continue;
    const old=await caches.open(label);
    const manifest=await old.match(manifestURL);
    if(!manifest)continue;
    const prior=await manifest.json().catch(()=>null);
    if(prior?.version!==version.slice(1))continue;
    const declared=new Map(Object.values(prior.engines??{}).flat().map(item=>[item.path,item]));
    for(const item of entries){
      const previous=declared.get(item.path);
      if(previous?.sha256!==item.sha256||previous.bytes!==item.bytes)continue;
      const url=assetURL(item.path);
      if(await cache.match(url))continue;
      const response=await old.match(url);
      if(!response?.ok)continue;
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength!==item.bytes||hex(await crypto.subtle.digest("SHA-256",bytes))!==item.sha256)continue;
      // Cache writes can fail on quota-limited devices. Keep the old
      // installed release available if migration cannot complete.
      try {
        await cache.put(url,new Response(bytes,{headers:{"Content-Type":response.headers.get("Content-Type")??"application/octet-stream"}}));
      } catch(error) {
        if(error.name!=="QuotaExceededError")throw error;
        return;
      }
    }
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const manifest = await fetch(manifestURL, { cache: "reload" });
    if (!manifest.ok) throw new Error("缺少 OCR 資源清單。");
    const info = await manifest.clone().json();
    if (info.version !== "0.7.5") throw new Error("OCR 資源版本不符。");
    const cache = await caches.open(cacheName);
    await cache.addAll(info.shell.map(asset => new Request(assetURL(asset.path), { cache: "reload" })));
    await cache.put(manifestURL, manifest);
    await reuseEngineAssets(cache,info);
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

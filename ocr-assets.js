const runtime = new URL("./ocr-runtime/", import.meta.url);
export const OCR_CACHE_KEY = "gsat-photo-ocr:"+runtime.href+":paddle-0.4.2-r1";
export const OCR_RUNTIME = runtime.href;
const manifestURL = new URL("assets.json",runtime);
const manifestHash = "f6e5d956cd9606f784fdedf0f97da1277ff11e4d039a59bda1b3b351a978020f";

export async function verifyAsset(response,{bytes,sha256},signal,progress=()=>{}) {
  const check=()=>{if(signal?.aborted) throw new DOMException("已取消下載。","AbortError");};
  if(!response?.ok||!response.body) throw new Error("找不到 OCR 資源。");
  const reader=response.body.getReader();
  let count=0;
  let output=bytes===undefined?null:new Uint8Array(bytes);
  const abort=()=>void reader.cancel().catch(()=>{});
  signal?.addEventListener("abort",abort,{once:true});
  try {
    while(true) {
      check();
      const {done,value}=await reader.read();
      check();
      if(done) break;
      if(output&&count+value.byteLength>output.byteLength) throw new Error("OCR 資源大小不符。");
      if(!output) {
        if(value.byteLength>32768) throw new Error("OCR 資源清單太大。");
        output=new Uint8Array(32768);
      }
      if(count+value.byteLength>output.byteLength) throw new Error("OCR 資源大小不符。");
      output.set(value,count);
      count+=value.byteLength;
      progress(count);
    }
  } finally {
    signal?.removeEventListener("abort",abort);
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  if(!output||bytes!==undefined&&count!==bytes) throw new Error("OCR 資源大小不符。");
  const data=count===output.byteLength?output:output.subarray(0,count);
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",data)),
    byte=>byte.toString(16).padStart(2,"0")).join("");
  check();
  if(actual!==sha256) throw new Error("OCR 資源 SHA-256 不符。");
  return new Response(data,{headers:{"Content-Type":response.headers.get("Content-Type")??"application/octet-stream"}});
}

function resourceURLs(manifest) {
  if (manifest.version!==1||!Array.isArray(manifest.assets)||!manifest.assets.length) throw new Error("OCR 資源清單格式錯誤。");
  const paths=new Set();
  return manifest.assets.map(row=>{
    if (!/^(?:(?:assets|ort)\/)?[a-zA-Z0-9_.-]+$/.test(row.path)||row.path.split("/").some(part=>part==="."||part==="..")||
        !Number.isSafeInteger(row.bytes)||row.bytes<=0||row.bytes>100_000_000||
        !/^[a-f0-9]{64}$/.test(row.sha256)||paths.has(row.path)) throw new Error("OCR 資源格式錯誤。");
    paths.add(row.path);
    return {...row,url:new URL(row.path,runtime).href};
  });
}

async function checkedResource(cache,url,expected,{download,signal,progress}) {
  const cached=await cache.match(url);
  let damaged=false;
  if(cached) {
    try {return await verifyAsset(cached,expected,signal);}
    catch(error) {
      if(signal?.aborted) throw error;
      damaged=true;
      await cache.delete(url);
    }
  }
  if(!download) {
    if(damaged) throw new Error("OCR 快取損毀，請連網重新下載離線模型。");
    return null;
  }
  try {
    const response=await verifyAsset(await fetch(url,{redirect:"error",cache:"reload",signal}),expected,signal,progress);
    await cache.put(url,response.clone());
    return response;
  } catch(error) {
    if(signal?.aborted) throw error;
    if(error.name==="QuotaExceededError") throw new Error("裝置可用空間不足。騰出空間後，請重試下載離線模型。");
    throw new Error((damaged?"OCR 快取損毀，重新下載失敗。":"OCR 下載或驗證失敗。")+" "+error.message+" 請連網後重試。",{cause:error});
  }
}

export async function photoResources({download=false,progress=()=>{},signal}={}) {
  if (!globalThis.caches) throw new Error("離線 OCR 需要 HTTPS 或 localhost。");
  const cache=await caches.open(OCR_CACHE_KEY);
  const expected={sha256:manifestHash};
  let response=await checkedResource(cache,manifestURL,expected,{download,signal});
  if(!response) {
    response=await verifyAsset(await fetch(manifestURL,{signal}),expected,signal);
  }
  const assets=resourceURLs(await response.json());
  const total=assets.reduce((sum,entry)=>sum+entry.bytes,0);
  let received=0;
  for(const item of assets) {
    const verified=await checkedResource(cache,item.url,item,{download,signal,progress:count=>progress(received+count,total)});
    if(verified) received+=item.bytes;
    progress(received,total);
  }
  return {received,total,ready:received===total};
}

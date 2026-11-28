const bounds = polygon => ({
  left:Math.min(...polygon.map(p=>p[0])),right:Math.max(...polygon.map(p=>p[0])),
  top:Math.min(...polygon.map(p=>p[1])),bottom:Math.max(...polygon.map(p=>p[1])),
});
const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
  Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
const area=b=>(b.right-b.left)*(b.bottom-b.top);

export function recoveryRegions(selection, original, limit=2) {
  if(selection.mode!=="black")return [];
  const filled=selection.entries.filter(e=>!e.rejection && e.phonetics&&e.partOfSpeech &&
    e.ocrConfidence>=.55 && !e.supplemental);
  const anchors=filled.filter(entry=>entry.numbered||entry.inlineNumber);
  const lefts=anchors.map(e=>e.left??bounds(e.headPolygon??e.polygon).left).sort((a,b)=>a-b);
  const typicalLeft=lefts[Math.floor(lefts.length/2)];
  const accepted=filled.filter(e=>e.status!=="excluded"||e.duplicateOf!==undefined);
  return [...(selection.bands??[])].filter(band=>
    (band.neighbors>=1||band.dashed) &&
    (typicalLeft===undefined || Math.abs(typicalLeft-band.left)<=original.width*.12) &&
    !accepted.some(entry=>{
      const box=bounds(entry.headPolygon??entry.polygon);
      return overlap(band,box)/Math.max(1,area(box))>.35 &&
        box.left<=band.left+(band.right-band.left)*.35;
    })
  ).sort((a,b)=>b.score-a.score).slice(0,limit).map(band=>{
    const h=band.bottom-band.top;
    const left=Math.min(band.left,typicalLeft??band.left);
    return {left:Math.floor(Math.max(0,left-h*.36)),top:Math.floor(Math.max(0,band.top-h*.42)),
      right:Math.ceil(Math.min(original.width,band.right+h*.18)),
      bottom:Math.ceil(Math.min(original.height,band.bottom+h*.42)),band};
  });
}

export function mapCropItems(items, crop, width, height) {
  return items.filter(item=>item.polygon?.length===4).map(item=>({...item,ocrSource:"local-retry",
    polygon:item.polygon.map(([x,y])=>[
      crop.left+x*(crop.right-crop.left)/width,
      crop.top+y*(crop.bottom-crop.top)/height,
    ])}));
}
const normalize = text=>text.normalize("NFKC").toLowerCase().replace(/\s+/g,"");
export function mergeRecovery(primary, recovered) {
  const items=[...primary];
  for(const entry of recovered){
    const box=bounds(entry.polygon);
    const duplicate=items.some(item=>item.polygon?.length===4 && normalize(item.text)===normalize(entry.text) &&
      overlap(box,bounds(item.polygon))/Math.max(1,Math.min(area(box),area(bounds(item.polygon))))>.65);
    if(!duplicate)items.push(entry);
  }
  return items;
}

export async function recoverMissing(result, photo, selection, recognize, {budgetMs=7500, stop, regions=recoveryRegions(selection,result.original), signal, decode=image=>image.decode()}={}) {
  const started=performance.now();
  if(!regions.length)return {attempts:[],items:result.items,elapsedMs:0};
  if(typeof stop!=="function")throw new Error("局部 OCR 需要可停止的辨識引擎。");
  const url=URL.createObjectURL(photo);
  const image=new Image();
  const attempts=[];
  let items=result.items;
  try {
    image.src=url;
    if (signal?.aborted) throw new DOMException("已取消局部辨識。","AbortError");
    await decode(image);
    if(image.naturalWidth!==result.original.width||image.naturalHeight!==result.original.height)
      throw new Error("局部照片的方向或尺寸與首次 OCR 不符。");
    for (const crop of regions) {
      if(signal?.aborted||performance.now()-started>=budgetMs)break;
      const canvas=document.createElement("canvas");
      const w=crop.right-crop.left,h=crop.bottom-crop.top;
      const scale=Math.min(1.5,1450/Math.max(w,h));
      canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
      let timer, pending;
      const began=performance.now();
      try{
        canvas.getContext("2d",{alpha:false}).drawImage(image,crop.left,crop.top,w,h,0,0,canvas.width,canvas.height);
        const expires=new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new DOMException("已達局部辨識時間上限","TimeoutError")),
            Math.max(1,budgetMs-(performance.now()-started)));
        });
        pending=Promise.resolve().then(()=>recognize(canvas));
        const raw=await Promise.race([pending,expires]);
        const mapped=mapCropItems(raw.items,crop,canvas.width,canvas.height);
        const next=mergeRecovery(items,mapped);
        attempts.push({crop,width:canvas.width,height:canvas.height,raw,mapped,added:next.length-items.length,
          elapsedMs:performance.now()-began});
        items=next;
      } catch(error) {
        attempts.push({crop,error:String(error.message??error),elapsedMs:performance.now()-began});
        if(error.name==="TimeoutError"){
          await stop();
          break;
        }
      } finally {clearTimeout(timer);canvas.width=canvas.height=1;}
    }
    return {attempts,items,elapsedMs:performance.now()-started};
  } finally {image.removeAttribute("src");URL.revokeObjectURL(url);}
}

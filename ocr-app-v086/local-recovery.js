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
      crop.rectifiedTop===undefined ? crop.top+y*(crop.bottom-crop.top)/height :
        crop.rectifiedTop+y*(crop.rectifiedBottom-crop.rectifiedTop)/height+
          x*(crop.right-crop.left)*crop.slope/width,
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

function enhanceHeader(context,width,height) {
  const bitmap=context.getImageData(0,0,width,height);
  const pixels=bitmap.data;
  const stride=width+1;
  const luminance=new Uint8Array(width*height);
  const total=new Uint32Array(stride*(height+1));
  for(let y=1;y<=height;y++) {
    let row=0;
    for(let x=1;x<=width;x++) {
      const at=(y-1)*width+x-1;
      const level=(pixels[at*4]*.21+pixels[at*4+1]*.69+pixels[at*4+2]*.10)|0;
      luminance[at]=level;row+=level;
      total[y*stride+x]=row+total[(y-1)*stride+x];
    }
  }
  const radius=Math.max(10,Math.round(width*.012));
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const a=Math.max(0,x-radius),b=Math.min(width,x+radius+1);
    const c=Math.max(0,y-radius),d=Math.min(height,y+radius+1);
    const mean=(total[d*stride+b]-total[c*stride+b]-total[d*stride+a]+total[c*stride+a])/((b-a)*(d-c));
    const at=y*width+x;
    const level=luminance[at];
    const cutoff=Math.min(165,mean-14);
    const intensity=Math.max(0,Math.min(255,160+(level-cutoff)*6));
    pixels[at*4]=pixels[at*4+1]=pixels[at*4+2]=intensity;
  }
  context.putImageData(bitmap,0,0);
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
      const w=crop.right-crop.left,h=crop.rectifiedBottom===undefined?crop.bottom-crop.top:crop.rectifiedBottom-crop.rectifiedTop;
      const scale=Math.min(1.5,(crop.early?1850:1450)/Math.max(w,h));
      canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
      let timer, pending;
      const began=performance.now();
      try{
        const context=canvas.getContext("2d",{alpha:false});
        if(crop.rectifiedTop===undefined) context.drawImage(image,crop.left,crop.top,w,h,0,0,canvas.width,canvas.height);
        else {
          context.fillStyle="#fff";
          context.fillRect(0,0,canvas.width,canvas.height);
          const scaleY=canvas.height/h;
          context.setTransform(canvas.width/w,-crop.slope*scaleY,0,scaleY,0,(crop.top-crop.rectifiedTop)*scaleY);
          context.drawImage(image,crop.left,crop.top,w,crop.bottom-crop.top,0,0,w,crop.bottom-crop.top);
        }
        if(crop.detail) {
          // Prefer a light background with the original dark strokes.
          // The crop is usually one slanted heading row plus its immediate text.
          const image=context.getImageData(0,0,canvas.width,canvas.height);
          for(let i=0;i<image.data.length;i+=4) {
            const light=image.data[i]*.23+image.data[i+1]*.70+image.data[i+2]*.07;
            const value=Math.max(0,Math.min(255,(light-91)*3.1));
            image.data[i]=image.data[i+1]=image.data[i+2]=value;
          }
          context.putImageData(image,0,0);
        } else if(crop.early) enhanceHeader(context,canvas.width,canvas.height);
        const expires=new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(new DOMException("已達局部辨識時間上限","TimeoutError")),
            Math.max(1,budgetMs-(performance.now()-started)));
        });
        pending=Promise.resolve().then(()=>recognize(canvas));
        const raw=await Promise.race([pending,expires]);
        const mapped=mapCropItems(raw.items,crop,canvas.width,canvas.height)
          .map(item=>crop.kind==="gloss"?{...item,ocrSource:"gloss-retry"}:
            crop.kind==="red-heading"?{...item,redCrop:crop}:item);
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

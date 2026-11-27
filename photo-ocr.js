import {selectFromPhoto} from "./ocr-lab/selection.js";
import {recoverMissing} from "./ocr-lab/local-recovery.js";
import {keepPrimarySelection} from "./ocr-lab/page-records.js";

import {OCR_RUNTIME} from "./ocr-assets.js";
const engineUrl=new URL("engine.js",OCR_RUNTIME);
const fail=()=>new DOMException("已取消辨識。","AbortError");

export function createPhotoEngine(options) {
  let runner,disposal;
  async function release(){
    if (!runner) return disposal;
    const old=runner;
    runner=null;
    disposal=Promise.resolve().then(()=>old.dispose());
    return disposal;
  }
  async function run(canvas,signal) {
    if (signal.aborted) throw fail();
    let timer,abort;
    try {
      const interrupt=new Promise((_,reject)=>{
        abort=()=>reject(fail());
        signal.addEventListener("abort",abort,{once:true});
        timer=setTimeout(()=>reject(new Error("照片辨識逾時，請重試。")),45000);
      });
      return await Promise.race([runner.recognize(canvas),interrupt]);
    } catch(error) {
      await release().catch(()=>{});
      throw error;
    } finally {clearTimeout(timer);signal.removeEventListener("abort",abort);}
  }
  async function recognize(photo,signal,progress) {
    const {mode,retry}=options();
    if (!runner) {
      progress("載入模型");
      const {load}=await import(engineUrl.href);
      runner=await load(progress,OCR_RUNTIME);
    }
    if (signal.aborted) throw fail();
    const image=new Image(), url=URL.createObjectURL(photo), canvas=document.createElement("canvas");
    let result;
    try {
      image.src=url;
      await image.decode();
      const width=image.naturalWidth,height=image.naturalHeight,scale=Math.min(1,2048/Math.max(width,height));
      canvas.width=Math.max(1,Math.round(width*scale));
      canvas.height=Math.max(1,Math.round(height*scale));
      const context=canvas.getContext("2d",{alpha:false});
      context.fillStyle="#fff";
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      progress("辨識文字");
      const raw=await run(canvas,signal);
      result={...raw,original:{width,height},coordinateSpace:"original-image-pixels",items:raw.items.map(item=>({...item,
        polygon:item.polygon.map(([x,y])=>[x*width/canvas.width,y*height/canvas.height]),
      }))};
    } finally {
      canvas.width=canvas.height=1;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
    if (signal.aborted) throw fail();
    progress("篩選主單字");
    const primary=await selectFromPhoto(result,photo,mode);
    if (!retry||primary.mode!=="black") return {ocr:result,selection:primary,recovery:null};
    progress("局部二次辨識");
    const {output,recovery}=await keepPrimarySelection(primary,
      ()=>recoverMissing(result,photo,primary,canvas=>run(canvas,signal),{stop:release}),
      items=>selectFromPhoto({...result,items},photo,mode));
    if (signal.aborted) throw fail();
    return {ocr:result,selection:output,recovery};
  }
  return {recognize,release};
}

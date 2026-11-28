import {selectHeadwords} from "./ocr-app-v084/selection.js";
import {recoverMissing,recoveryRegions} from "./ocr-app-v084/local-recovery.js";
import {keepPrimarySelection} from "./ocr-app-v084/page-records.js";
import {OCR_RUNTIME} from "./ocr-assets.js";
import {createEngineSession} from "./photo-engine-session.js";
import {redRecoveryRegions} from "./photo-red-recovery.js";
import {glossRecoveryRegions} from "./photo-gloss-recovery.js";
import {parseEntries} from "./ocr-app-v084/entry-parser.js";
import {abortError,deadline,errorDetails} from "./ocr-task.js";

const engineUrl=new URL("engine-v082.js",OCR_RUNTIME);
const workerUrl=new URL("assets/worker-entry-C9UNuyOJ.js",OCR_RUNTIME);

function analyze(result,canvas,mode) {
  const context=canvas.getContext("2d",{willReadFrequently:true,alpha:false});
  const pixels=context.getImageData(0,0,canvas.width,canvas.height);
  const selected=selectHeadwords(result,pixels,mode);
  if(mode==="auto"&&selected.modeUncertain) {
    const red=selectHeadwords(result,pixels,"red");
    const headings=red.entries.filter(row=>row.status==="selected");
    if(headings.length===1&&headings[0].numbered&&headings[0].partOfSpeech&&headings[0].phonetics&&
        headings[0].ocrConfidence>=.7&&headings[0].redInk>=.65) {
      return {...red,requestedMode:"auto",singleHeadingFallback:true,elapsedMs:selected.elapsedMs+red.elapsedMs};
    }
  }
  return selected;
}

export function createPhotoEngine(options,log=()=>{}) {
  const session=createEngineSession({workerURL:workerUrl,log,
    load:async createWorker=>(await import(engineUrl.href)).load(()=>{},OCR_RUNTIME,createWorker)});

  async function recognize(photo,signal,progress) {
    const {mode,retry,longSide=2048}=options();
    const started=performance.now(),timings={};
    const image=new Image(),url=URL.createObjectURL(photo),canvas=document.createElement("canvas");
    let stage="圖片解碼",primary=null,ocr=null;
    try {
      image.src=url;
      progress(stage);
      await deadline(stage,18000,signal,()=>image.decode());
      timings.decodeMs=performance.now()-started;
      const width=image.naturalWidth,height=image.naturalHeight,scale=Math.min(1,longSide/Math.max(width,height));
      if(!width||!height) throw new Error("無法取得照片尺寸。");
      canvas.width=Math.max(1,Math.round(width*scale));
      canvas.height=Math.max(1,Math.round(height*scale));
      stage="準備影像";
      const context=canvas.getContext("2d",{willReadFrequently:true,alpha:false});
      if(!context) throw new Error("影像緩衝區配置失敗。");
      context.fillStyle="#fff";
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      timings.resizeMs=performance.now()-started-timings.decodeMs;
      stage="辨識文字";
      progress(stage);
      const inferenceStart=performance.now();
      const raw=await session.predict(canvas,signal);
      timings.ocrMs=performance.now()-inferenceStart;
      if(raw.items.length>4000) throw new Error("文字框過多。請縮小照片範圍後重試。");
      ocr={...raw,original:{width,height},coordinateSpace:"original-image-pixels",items:raw.items.map(item=>({...item,
        polygon:item.polygon.map(([x,y])=>[x*width/canvas.width,y*height/canvas.height]),
      }))};
      if(signal.aborted) throw abortError();
      stage="篩選主單字";
      progress(stage);
      primary=analyze(ocr,canvas,mode);
      timings.selectionMs=primary.elapsedMs;
      if(!retry||!["black","red"].includes(primary.mode)) return {ocr,selection:primary,recovery:null,timings,longSide};
      stage="局部二次辨識";
      progress(stage);
      const selected=primary.entries.filter(entry=>entry.status==="selected"&&entry.word);
      const draft=parseEntries({ocr,selection:primary,final:{words:selected.map(entry=>({id:entry.id,word:entry.word,source:"ocr"}))}},
        {strict:true,automaticImport:true});
      const headings=primary.mode==="red"?
        redRecoveryRegions(context.getImageData(0,0,canvas.width,canvas.height),ocr.original,primary):
        recoveryRegions(primary,ocr.original);
      const glosses=glossRecoveryRegions(draft,ocr.original);
      const cropped=[...glosses.filter(crop=>crop.score>1),...headings,...glosses.filter(crop=>crop.score===1)].slice(0,2);
      const {output,recovery}=await keepPrimarySelection(primary,
        ()=>recoverMissing(ocr,photo,primary,region=>session.predict(region,signal),{
          stop:()=>session.release("局部辨識停止",false),regions:cropped,signal,
          decode:image=>deadline("局部圖片解碼",3500,signal,()=>image.decode()),
        }),
        items=>{
          const second=analyze({...ocr,items:items.filter(item=>item.ocrSource!=="gloss-retry")},canvas,mode);
          {
            const selected=new Map(primary.entries.filter(entry=>entry.status==="selected").map(entry=>[entry.id,entry]));
            second.entries=second.entries.map(entry=>selected.get(entry.id)??entry);
          }
          return second;
        });
      timings.localOcrMs=recovery?.elapsedMs??0;
      if(signal.aborted) throw abortError();
      return {ocr,selection:output,recovery,timings,longSide};
    } catch(error) {
      if (signal.aborted) throw error;
      const heic=/hei[cf]$/i.test(photo.name??"")||/hei[cf]/i.test(photo.type??"");
      const hint=stage==="圖片解碼"?(heic?"此瀏覽器無法解碼這張 HEIC。可改用 JPEG／PNG 再加入。":
        "無法解碼這張照片，請重新選擇 JPEG／PNG。"):
        stage==="準備影像"?"影像處理失敗，請選 1600 px 或較小的照片後重試。":error.message;
      const failure=new Error(hint,{cause:error});
      failure.partial={ocr,selection:primary,timings,stage};
      log("page-error",{stage,error:errorDetails(error)});
      throw failure;
    } finally {
      canvas.width=canvas.height=1;
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  }
  return {recognize,release:session.release};
}

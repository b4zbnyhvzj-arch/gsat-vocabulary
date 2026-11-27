export function pageTimings(ocr, selection, recovery) {
  const firstOcrMs=ocr.elapsedMs??0;
  const imageMs=ocr.decodeMs??((ocr.imageDecodeMs??0)+(ocr.resizeMs??0));
  const selectionMs=selection.elapsedMs??0;
  const localOcrMs=recovery?.elapsedMs??0;
  return {firstOcrMs,imageMs,selectionMs,localOcrMs,totalMs:firstOcrMs+imageMs+selectionMs+localOcrMs};
}

export function createPageRecords() {
  const pages=[];
  return {
    add(record) {
      if(!record?.ocr || !record.selection || !record.final) throw new Error("請先完成照片辨識及確認。");
      const page=pages.length+1;
      pages.push({...structuredClone(record),page,addedAt:new Date().toISOString()});
      return page;
    },
    get count(){return pages.length;},
    export(){return {schemaVersion:1,labVersion:"0.7.7",pageCount:pages.length,pages:structuredClone(pages)};},
  };
}

export async function keepPrimarySelection(primary, recover, rescore) {
  const start=performance.now();
  let output=primary, recovery=null;
  try {
    const {items,...record}=await recover();
    recovery=record;
    if(record.attempts?.some(attempt=>attempt.added>0)){
      const next=await rescore(items);
      output={...next,elapsedMs:primary.elapsedMs+next.elapsedMs};
    }
  } catch(error) {
    recovery={...(recovery??{attempts:[],elapsedMs:performance.now()-start}),
      error:String(error?.message??error)};
  }
  return {output,recovery};
}

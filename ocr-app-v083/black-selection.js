import { bandFor } from "./entry-bands.js";

const isExample = line=>line.supplemental || line.followedByEnglishSentence;
const shape = line=>line.phonetics && line.partOfSpeech;
const complete = line=>shape(line) && line.hasChinese;
const nearColumn = (line, members, width, height) =>
  members.filter(other=>other.id!==line.id && !isExample(other) &&
    Math.abs(line.left-other.left)<=width*.055 &&
    Math.abs(line.y-other.y)>=height*.75).length>=2;
const bound = value=>Math.max(0,Math.min(1,value));

export function scoreBlack(line, {all, bands, size, original, numbered, red, reasons}) {
  const band=bandFor(line,bands);
  const localBold=line.darkInk>=.38 && line.stroke>=.065 && line.inkDensity>=.09;
  const darkEnough=line.darkInk>=.21 && line.inkDensity>=.065;
  const aligned=nearColumn(line,all.filter(complete),original.width,line.height);
  const traits=shape(line), full=complete(line);
  const atHead=numbered || Boolean(band);
  // An OCR typo in the compact tag or closing bracket need not invalidate
  // an otherwise well-aligned, printed bilingual entry.
  const damagedTag=line.phonetics && line.hasChinese && aligned && localBold && size>=1.30;
  const retryWithoutNumber=line.ocrSource==="local-retry"&&!line.inlineNumber &&
    !numbered && !(aligned&&localBold);
  if(damagedTag&&!traits)reasons.push("音標和中譯仍在，詞性標記可能辨識不完整");
  if(full)reasons.push("英文詞頭後見音標、詞性與中文");
  if(aligned)reasons.push("與同欄完整詞條左緣對齊");
  if(band)reasons.push(band.dashed?"灰色長條底框，邊緣有間歇墨跡":"英文詞頭位於灰色長條底框");
  if(isExample(line))reasons.push("範例句或補充標記");
  const score=bound((full ? .49:traits ? .33:line.phonetics ? .15:0)+(numbered ? .18:0)+(band ? .22:0)+
    (aligned ? .17:0)+(localBold ? .14:0)+(size>=1.24 ? .15:0)+(darkEnough ? .08:0)-
    (isExample(line) ? .6:0)-(red ? .35:0));
  let status="excluded";
  if(!red && !isExample(line) && darkEnough && !retryWithoutNumber) {
    if((full && (atHead || (aligned&&localBold))) ||
       (traits && atHead && localBold && (size>=1.12||band)) ||
       (localBold && size>=1.24 && traits) || damagedTag)status="selected";
    else if((traits && (atHead||aligned||full)) || (localBold && size>=1.10 &&
      (line.phonetics||line.partOfSpeech||numbered)))status="review";
  }
  if(retryWithoutNumber)reasons.push("局部框缺少編號及欄位支持，可能是裁切殘字");
  if(!darkEnough)reasons.push("局部可辨印刷墨跡不足");
  if(status==="excluded" && !isExample(line))reasons.push("粗體主詞條結構證據不足");
  return {status,score,band};
}

export function consolidateBlack(entries) {
  const best=new Map();
  const rank={excluded:0,review:1,selected:2};
  for(const entry of entries){
    if(!entry.word||entry.status==="excluded")continue;
    const key=entry.word.toLowerCase();
    const group=best.get(key)??[];
    group.push(entry);best.set(key,group);
  }
  return entries.map(entry=>{
    if(!entry.word||entry.status==="excluded")return entry;
    const group=best.get(entry.word.toLowerCase());
    const primary=[...group].sort((a,b)=>rank[b.status]-rank[a.status]||b.selectionScore-a.selectionScore)[0];
    if(group.length===1)return entry;
    if(primary!==entry)return {...entry,status:"excluded",duplicateOf:primary.id,
      reasons:[...entry.reasons,"同拼字詞條已合併，來源框保留在主項目"]};
    return {...entry,sourceEntries:group.map(row=>({id:row.id,text:row.text,polygon:row.polygon,
      headPolygon:row.headPolygon,ocrConfidence:row.ocrConfidence,ocrSource:row.ocrSource??"primary",
      selectionScore:row.selectionScore,status:row.status}))};
  });
}

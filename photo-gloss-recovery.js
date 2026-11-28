import {parseEntries,fragmentKind} from "./ocr-app-v084/entry-parser.js";

const cjk = /\p{Script=Han}/u;
const inlineNoise = /\p{Script=Han}\s*[a-z]+\s*\p{Script=Han}/iu;
const key = text => text.trim().toLowerCase();
const hanLength = text => [...text].filter(char=>cjk.test(char)).length;
const confidence = ref => Number.isFinite(ref.confidence) ? ref.confidence : 1;
const refsOf = word => word.senses.flatMap(sense=>sense.sources).filter(ref=>ref.polygon?.length===4);
function severity(word,sense) {
  if(fragmentKind(sense.meaning)||/[�□■]/u.test(sense.meaning)) return 3;
  if(inlineNoise.test(sense.meaning)) return 2;
  // Short glosses sharing a dense line can be misread even when the word is clear.
  return word.senses.length>1&&hanLength(sense.meaning)<=5&&
    sense.sources.some(ref=>confidence(ref)<.92)?1:0;
}
export function glossRecoveryRegions(parsed,original) {
  const candidates=[];
  for(const word of parsed.words) {
    const scores=word.senses.map(sense=>severity(word,sense));
    const score=Math.max(0,...scores);
    const refs=refsOf(word);
    if(!score||!refs.length) continue;
    const points=refs.flatMap(ref=>ref.polygon);
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const height=Math.max(...ys)-Math.min(...ys);
    if(height<=0||height>original.height*.09) continue;
    const multiPart=new Set(word.senses.map(sense=>sense.part)).size>1;
    candidates.push({kind:"gloss",word:key(word.originalEnglish),score,multiPart,
      left:Math.max(0,Math.floor(Math.min(...xs)-height*.65)),
      right:Math.min(original.width,Math.ceil(Math.max(...xs)+height*(score===1?.7:3))),
      top:Math.max(0,Math.floor(Math.min(...ys)-height*.34)),
      bottom:Math.min(original.height,Math.ceil(Math.max(...ys)+height*.62))});
  }
  return candidates.sort((a,b)=>b.score-a.score||Number(b.multiPart)-Number(a.multiPart));
}
function inlineGloss(head, boxes) {
  const [leftTop,rightTop,rightBottom,leftBottom]=head.polygon;
  const height=(leftBottom[1]+rightBottom[1]-leftTop[1]-rightTop[1])/2;
  const rightX=(rightTop[0]+rightBottom[0])/2;
  const centerY=(rightTop[1]+rightBottom[1])/2;
  if(height<=0) return null;
  const slope=(rightTop[1]-leftTop[1])/Math.max(1,rightTop[0]-leftTop[0]);
  return boxes.find(row=>{
    const points=row.polygon;
    if(row===head||points?.length!==4||!/^[\p{Script=Han}（(][\p{Script=Han}、，；：·（）()\s]{1,18}$/u.test(row.text.trim())||
        fragmentKind(row.text)||(row.confidence??0)<.82) return false;
    const left=Math.min(...points.map(point=>point[0]));
    const y=points.reduce((sum,point)=>sum+point[1],0)/4;
    return left>=rightX-height*.3&&left<=rightX+height*2&&Math.abs(y-centerY-(left-rightX)*slope)<=height*.45;
  });
}
export function applyGlossRecovery(parsed,recovery,standardize) {
  for(const attempt of recovery?.attempts??[]) {
    if(attempt.crop.kind!=="gloss"||!attempt.mapped?.length) continue;
    const word=parsed.words.find(item=>key(item.originalEnglish)===attempt.crop.word&&!item.edited);
    if(!word) continue;
    const boxes=attempt.mapped;
    // Only a parsed entry with the same visible headword can replace a gloss.
    const head=boxes.find(row=>row.text.toLowerCase().normalize("NFKC").replace(/^\s*\d+[.、]?\s*/,"")
      .startsWith(attempt.crop.word)&&/\[/.test(row.text.normalize("NFKC")));
    if(!head) continue;
    const readHead=row=>parseEntries({ocr:{items:boxes},selection:{entries:[{...row,id:0,word:word.originalEnglish,status:"selected"}]},
      final:{words:[{id:0,word:word.originalEnglish,source:"ocr"}]}},{strict:true,automaticImport:true,standardize}).words[0];
    let candidate=readHead(head);
    if(word.senses.some(sense=>severity(word,sense)>1)&&
        !candidate?.senses.some(sense=>sense.meaning&&!fragmentKind(sense.meaning))&&
        !cjk.test(head.text)) {
      const gloss=inlineGloss(head,boxes);
      if(gloss) {
        candidate=readHead({...head,text:head.text+" "+gloss.text});
        for(const sense of candidate?.senses??[]) sense.sources=[head,gloss].map((row,index)=>({
          id:"retry-inline-"+index,text:row.text,polygon:row.polygon,confidence:row.confidence,origin:"local-retry",
        }));
      }
    }
    if(!candidate) continue;
    const repaired=alternate=>({...alternate,sources:alternate.sources.map(ref=>({...ref,origin:"local-retry"}))});
    if(word.senses.length===1&&candidate.senses.length>1&&severity(word,word.senses[0])>1&&
        candidate.senses.every(sense=>sense.part===word.senses[0].part&&sense.meaning&&
          !fragmentKind(sense.meaning)&&!inlineNoise.test(sense.meaning))) {
      const sources=word.senses[0].sources;
      word.senses=candidate.senses.map(sense=>{
        const repair=repaired(sense);
        return {...repair,sources:[...repair.sources,...sources]};
      });
      word.reasons.push("局部重辨識補齊並拆開詞義");
      continue;
    }
    if(candidate.senses.length!==word.senses.length||
        word.senses.some((sense,index)=>candidate.senses[index].part!==sense.part)) continue;
    for(const [index,sense] of word.senses.entries()) {
      const alternate=candidate.senses[index];
      const score=severity(word,sense), current=confidence(sense.sources[0]??{});
      const alternative=confidence(alternate.sources[0]??{});
      if(!score||fragmentKind(alternate.meaning)||inlineNoise.test(alternate.meaning)||
          !alternate.meaning||sense.meaning===alternate.meaning||
          (score===1&&(hanLength(alternate.meaning)<hanLength(sense.meaning)||alternative<Math.max(.91,current+.015)))) continue;
      word.senses[index]={...sense,meaning:alternate.meaning,sources:[...repaired(alternate).sources,...sense.sources]};
      word.reasons.push("局部重辨識替換詞義");
    }
  }
  return parsed;
}

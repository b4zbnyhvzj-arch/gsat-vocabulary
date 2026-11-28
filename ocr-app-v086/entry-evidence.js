// Decisions here use OCR evidence. The raw frames are kept in the diagnostics.
const norm=text=>text.normalize("NFKC").trim();
const tokenPattern=/\b[a-z]{3,}\b/gi;
const han=/\p{Script=Han}/u;

// Only consider a damaged phonetic closer and a compact repeated consonant
// skeleton. An independent, high-confidence contextual spelling must agree.
export function unstickPhonetics(entry, items) {
  const raw=norm(entry.text);
  const chunk=/^(?:(?:\d+[.)、]?\s*)?)([a-z]{5,})\s*\]\s*(?:n|vt|vi|v|adj|adv|a)\./i.exec(raw);
  if(!chunk||chunk[1].toLowerCase()!==entry.word?.toLowerCase()) return null;
  const skeleton=text=>text.toLowerCase().replace(/[aeiouy]/g,"").replace(/(.)\1+/g,"$1");
  const token=chunk[1].toLowerCase();
  const counts=new Map();
  for(const row of items) {
    if((row.confidence??0)<.88||row===entry||row.text===entry.text) continue;
    for(const match of row.text.matchAll(tokenPattern)) {
      const cited=match[0].toLowerCase();
      for(const base of new Set([cited,cited.replace(/ed$|s$|ing$/,""),cited.replace(/d$/,"")])) {
        if(base.length<3||base.length>token.length-2||!token.startsWith(base)) continue;
        const phonetics=token.slice(base.length);
        if(phonetics.length<=5&&skeleton(base).length>=2&&skeleton(base)===skeleton(phonetics)) {
          counts.set(base,(counts.get(base)??0)+1);
        }
      }
    }
  }
  if(counts.size!==1) return null;
  const word=[...counts.keys()][0];
  const start=raw.indexOf(chunk[1]);
  return {...entry,word,phonetics:true,sourceText:entry.sourceText??entry.text,
    text:raw.slice(0,start)+word+"["+raw.slice(start+word.length),
    reasons:[...(entry.reasons??[]),"獨立拼字與括號殘片吻合，切開黏連音標"],
    spellingRepair:{before:chunk[1],after:word,reason:"phonetic-skeleton + contextual spelling"}};
}
export function singleGlossEvidence(sense, rowList) {
  const meaning=norm(sense.meaning);
  if(!/^\p{Script=Han}$/u.test(meaning)||sense.part!=="n.") return null;
  const anchor=sense.sources.find(ref=>ref.polygon?.length===4);
  if(!anchor) return null;
  const [a,b,c,d]=anchor.polygon;
  const height=(d[1]+c[1]-a[1]-b[1])/2;
  const top=Math.min(a[1],b[1]);
  // Count/mass contexts are evidence that the character stands alone, not
  // the first or last character of a longer word. Require a nearby example.
  const standalone=new RegExp("(?:加(?:一)?點|少許|一匙|一滴|一瓶|一些)"+meaning+
    "(?=的話|即可|就|便|來|再|[，、。；！？,.!?]|$)","u");
  const row=rowList.find(row=>row.g&&row.g.y>top&&row.g.y<top+height*10&&
    row.g.left>b[0]+height*.3&&(row.confidence??0)>=.82&&han.test(row.text)&&standalone.test(norm(row.text)));
  return row??null;
}

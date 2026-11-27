import { suggestForms, singularNoun, adjectiveFor } from "./entry-forms.js";

export const PARTS = ["n.","v.","vt.","vi.","a.","adj.","adv.","prep.","pron.","conj.","interj.","art.","det.","aux.","phr."];
export const isVerb = part => ["v.","vt.","vi."].includes(part);
export const englishWord = /^[a-z]+(?:[-' ][a-z]+)*$/i;
const han = /\p{Script=Han}/u;
const heading = /^(?:\d{1,3}\s*[.)、]?\s*)?([a-z]+(?:[-'][a-z]+)*)(?![a-z])/i;
const posPattern = /(?:adv|adj|prep|pron|conj|interj|det|art|aux|phr|vt|vi|ad|n|v|a)\s*\.(?=\s*[^a-z]|$|(?:vt|vi|pl)\.)|(?<=[&\]\s])(?:adj|adv|prep|vt|vi|v|n)(?=\s*\p{Script=Han})|介系詞|不及物動詞|及物動詞|形容詞|副詞|名詞|動詞|代名詞|連接詞|感嘆詞|冠詞|助動詞|片語/giu;
const bilingualParts = {
  "介系詞":"prep.", "不及物動詞":"vi.", "及物動詞":"vt.", "形容詞":"adj.", "副詞":"adv.",
  "名詞":"n.", "動詞":"v.", "代名詞":"pron.", "連接詞":"conj.", "感嘆詞":"interj.",
  "冠詞":"art.", "助動詞":"aux.", "片語":"phr.", "ad.":"adj.",
};
const noise = /^(?:[•●▶►※*]|(?:例句|搭配|補充|同義|反義|翻譯|[同反衍延複片][\s(（])|[a-z]*\(\d+\))/i;
const clean = value => String(value??"").replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g,";").normalize("NFKC").replace(/[’‘]/g,"'").trim();
const unique = list => [...new Set(list)];
const countPattern = /[\[(]\s*[cu](?:\s*[,/&]\s*[cu])*(?![a-z])\s*[\])]?|(?:皆|均)?不可數(?:名詞)?|可數(?:名詞)?/gi;
const pluralPattern = /(?:\bpl\.|\bplural\b|(?:固定|恆用|恒用)複數|複數(?:名詞)?)/gi;

// Unambiguous glyph variants seen across OCR fonts. Keep the exact OCR text in sources.
const traditionalGlyph = {"别":"別","内":"內","决":"決","则":"則","计":"計","毁":"毀","装":"裝",
  "圆":"圓","断":"斷","脱":"脫","记":"記","权":"權","销":"銷","归":"歸","储":"儲"};
const standardGlyphs = text=>text.replace(/[别内决则计毁装圆断脱记权销归储]/g,char=>traditionalGlyph[char]);

function splitGloss(raw) {
  const tags=[];
  const tagPattern=new RegExp(countPattern.source+"|"+pluralPattern.source,"gi");
  const tagged=raw.replace(tagPattern,(tag,offset)=>{
    const shared=!han.test(raw.slice(0,offset))||/^[皆均]/.test(tag);
    const plural=/^(?:(?:固定|恆用|恒用)複數|pl\.|plural)$/i.test(tag) ? "fixed" :
      /複數/.test(tag) ? "plural" : null;
    const countability=plural ? [] : tag.includes("數") ?
      [tag.includes("不可數")?"uncountable":"countable"] :
      tag.toLowerCase().match(/[cu]/g).map(mark=>mark==="u"?"uncountable":"countable");
    return "\uE000"+(tags.push({shared,plural,countability})-1)+"\uE001";
  }).replace(/\((?:only|usually)\s+before\s+noun\)\s*/gi,"")
    .replace(/usually\s+\S+?(?=\s|\(|$)/gi,"").trim();
  const definitions=[];
  let depth=0, first=0;
  for (let i=0;i<=tagged.length;i++) {
    if (tagged[i]==="(") depth++;
    if (tagged[i]===")") depth=Math.max(0,depth-1);
    const colonBetweenGlosses=tagged[i]===":"&&han.test(tagged.slice(0,i).trim().at(-1)??"")&&
      han.test(tagged.slice(i+1).trim()[0]??"");
    if (i===tagged.length||(!depth&&(/[;,、]/.test(tagged[i])||colonBetweenGlosses))) {
      definitions.push(tagged.slice(first,i));
      first=i+1;
    }
  }
  const detail=text=>{
    const local=[];
    const meaning=text.replace(/\uE000(\d+)\uE001/g,(_,index)=>{local.push(tags[Number(index)]);return "";})
      .replace(/\(\s*(?:集合名詞\s*[,、]?)?\s*\)/g,"")
      .replace(/\(\s*=[^)]*(?:\)|$)/g,"")
      .replace(/(?<=\p{Script=Han}|\))\s*[a-z][a-z' -]*[^\p{Script=Han}]*$/iu,"")
      .replace(/^[\s\[\]&:：.]+|[\s\[\]&:：.]+$/g,"").trim();
    const applicable=[...tags.filter(tag=>tag.shared),...local];
    const plural=applicable.some(tag=>tag.plural==="fixed")?"fixed":applicable.some(tag=>tag.plural)?"plural":null;
    return {meaning:han.test(meaning)?standardGlyphs(meaning):"",plural,
      countability:unique(applicable.flatMap(tag=>tag.countability))};
  };
  const glosses=definitions.map(detail).filter(sense=>sense.meaning);
  return {meanings:unique(glosses.map(sense=>sense.meaning)),glosses:glosses.length?glosses:[detail(tagged)]};
}

function geometry(row) {
  const polygon = row.polygon;
  if (!Array.isArray(polygon)||polygon.length<4||polygon.some(p=>!p?.every(Number.isFinite))) return null;
  const [a,b,c,d] = polygon;
  const height = (Math.hypot(d[0]-a[0],d[1]-a[1])+Math.hypot(c[0]-b[0],c[1]-b[1]))/2;
  const slope = (b[1]-a[1])/Math.max(1,b[0]-a[0]);
  return height>0 ? {left:(a[0]+d[0])/2,right:(b[0]+c[0])/2,y:(a[1]+d[1])/2,height,slope} : null;
}

function source(row) {
  return {id:row.uid, text:row.text, polygon:row.polygon??null, origin:row.ocrSource??row.source??"primary",
    confidence:row.ocrConfidence??row.confidence??null, headPolygon:row.headPolygon??null};
}

function head(row, word) {
  const text = clean(row.text);
  const match = heading.exec(text);
  if (match?.[1].toLowerCase()!==word) return null;
  return text.slice(match[0].length).trim();
}

function phoneticTail(text) {
  // A missing closing bracket is common when the OCR joins the first POS.
  const closed=/^\[[^\]\p{Script=Han}]{1,65}\]/u.exec(text);
  if (closed && !/^[\[(]\s*[cu]\s*[\])]/i.test(closed[0])) return text.slice(closed[0].length).trim();
  return text.replace(/^\[[^\]\p{Script=Han}]{0,38}?(?=(?:adj|adv|prep|vt|vi|[avn])\.\s*(?:[\p{Script=Han}[(]|$))/u,"").trim();
}

function readSenses(input) {
  const raw = phoneticTail(clean(input)).replace(
    /^(adj|adv|prep|vt|vi|v|n)(?=\s*\p{Script=Han})/iu,"$1.");
  const markers = [...raw.matchAll(posPattern)].filter(match=>
    !han.test(match[0])||match.index===0||/[;&]\s*$/.test(raw.slice(0,match.index)));
  if (!markers.length || !/^[\s&/\[\]:()'ˈˌ-]*$/.test(raw.slice(0,markers[0].index))) {
    return [];
  }
  const result = [];
  let pending = [];
  for (const [index, match] of markers.entries()) {
    const token = match[0].toLowerCase().replace(/\s/g,"");
    const label = /^(?:adj|adv|prep|vt|vi|v|n)$/.test(token)?token+".":token;
    pending.push(bilingualParts[label]??label);
    const chunk = raw.slice(match.index+match[0].length,markers[index+1]?.index)
      .replace(/&?\s*\[[^\]\p{Script=Han}]{1,30}\]?\s*$/u,fragment =>
        /^\s*&?\s*\[\s*[CU]\s*\]?$/i.test(fragment) ? fragment : "");
    if (!han.test(chunk)&&index<markers.length-1&&/^[\s&/[\]()']*$/.test(chunk)) continue;
    const gloss = splitGloss(chunk);
    for (const part of unique(pending)) result.push({part, ...gloss});
    pending = [];
  }
  return result;
}

const rowKey = row => [clean(row.text), JSON.stringify(row.polygon??null)].join("|");
function rowsOf(record) {
  const rows = new Map();
  const put = (row,uid) => {
    if (!row?.text) return;
    const key = rowKey(row);
    const old = rows.get(key);
    rows.set(key,{...old,...row,uid:old?.uid??uid,g:geometry(row)});
  };
  for (const [i,row] of (record.ocr?.items??[]).entries()) put(row,"primary-"+i);
  for (const [i,attempt] of (record.recovery?.attempts??[]).entries()) {
    for (const [j,row] of (attempt.mapped??[]).entries()) put({...row,ocrSource:"local-retry"},"retry-"+i+"-"+j);
  }
  for (const entry of record.selection?.entries??[]) {
    put(entry,"entry-"+entry.id);
    for (const row of entry.sourceEntries??[]) put(row,"entry-"+row.id);
  }
  return rows;
}

function nearby(anchor,row) {
  const a = anchor.g, b = row.g;
  if (!a||!b||a===b) return null;
  const dx = b.left-a.left;
  const dy = b.y-a.y-dx*a.slope;
  const h = Math.max(a.height,b.height);
  if (dx>=-h*.45 && b.left<=a.right+h*.9 && dy>=-.57*h && dy<=1.65*h) {
    return Math.abs(dy)/h+.13*Math.abs(dx)/h;
  }
  return null;
}

function rightContinuation(anchor,row) {
  const a=anchor.g,b=row.g;
  if (!a||!b||a===b) return null;
  const gap=b.left-a.right, dx=b.left-a.left;
  const dy=b.y-a.y-dx*a.slope;
  if (gap<0||gap>a.height*2.3||Math.abs(dy)>a.height*.45) return null;
  return .5+Math.abs(dy)/a.height+.16*gap/a.height;
}

function supplementFor(row, tail, rows, heads) {
  const continues=/[&;,]\s*$/.test(tail);
  const incomplete=readSenses(tail).every(term=>!term.meanings.length);
  if (!continues&&!incomplete) return null;
  const neighbors = [];
  for (const next of rows) {
    if (heads.has(next.uid)||noise.test(clean(next.text))) continue;
    const rank = nearby(row,next)??rightContinuation(row,next);
    if (rank!==null) neighbors.push({next,rank});
  }
  neighbors.sort((a,b)=>a.rank-b.rank);
  // Use at most one POS box and one compact gloss box, each assigned to its nearest head.
  const accepted = [];
  let combined = tail;
  for (const {next,rank} of neighbors) {
    if (accepted.length>=2) break;
    if (han.test(next.text) && /[。！？]$/.test(next.text.trim())) continue;
    if (!readSenses(next.text).length && !/^[\s;,([]*\p{Script=Han}/u.test(clean(next.text))) continue;
    if (clean(next.text).length>42 || /^\p{Script=Han}{13}/u.test(clean(next.text))) continue;
    if ([...heads.values()].some(other=>other.uid!==row.uid && (nearby(other,next)??Infinity)+.18<rank)) continue;
    if (han.test(next.text) && !readSenses(combined).length && !readSenses(next.text).length) continue;
    accepted.push(next);
    combined += " "+clean(next.text);
    if (readSenses(combined).some(term=>term.meanings.length)) return {combined,accepted};
  }
  return accepted.length ? {combined,accepted} : null;
}

function nounTag(anchor,rows,heads) {
  return rows.find(row=>{
    if (heads.has(row.uid)||nearby(anchor,row)===null||!anchor.g||!row.g) return false;
    const dx=row.g.left-anchor.g.left;
    const dy=row.g.y-anchor.g.y-dx*anchor.g.slope;
    if (Math.abs(dx)>anchor.g.height*.65||dy<=0||dy>anchor.g.height*1.45) return false;
    const text=clean(row.text);
    const leftover=text.replace(countPattern,"").replace(pluralPattern,"")
      .replace(/集合名詞/g,"").replace(/[\s(),、]/g,"");
    return !leftover&&text!==text.replace(countPattern,"").replace(pluralPattern,"");
  });
}

function printedForms(word, row, rows) {
  for (const candidate of [row,...rows.filter(other=>{
    const a=row.g,b=other.g;
    if (!a||!b||a===b) return false;
    const dx=b.left-a.left;
    const dy=b.y-a.y-dx*a.slope;
    return Math.abs(dx)<=a.height*2&&dy>0&&dy<=a.height*2.25;
  })]) {
    const raw = clean(candidate.text);
    if (/^(?:[三目曰]\s*)?三態同形/.test(raw)||/^\S{1,42}.*三態同形\s*$/.test(raw)&&candidate.uid===row.uid) {
      return {base:word,past:word,pastParticiple:word,origin:"printed",sources:[source(candidate)]};
    }
    const tokens = raw.replace(/\[[^\]]+\]/g,"").match(/(?:^|[\s\u3400-\u9fff:])([a-z]+)\s*[,/–—-]\s*([a-z]+)\s*[,/–—-]\s*([a-z]+)(?=$|[\s.)\u3400-\u9fff])/i);
    if (tokens?.[1].toLowerCase()===word) {
      return {base:word,past:tokens[2].toLowerCase(),pastParticiple:tokens[3].toLowerCase(),
        origin:"printed",sources:[source(candidate)]};
    }
  }
  return null;
}

function sameOccurrence(a,b) {
  if (!a.g||!b.g) return a.uid===b.uid;
  const h=Math.min(a.g.height,b.g.height);
  const shared=Math.min(a.g.right,b.g.right)-Math.max(a.g.left,b.g.left);
  const narrow=Math.min(a.g.right-a.g.left,b.g.right-b.g.left);
  const dx=b.g.left-a.g.left;
  return shared>=narrow*.65&&Math.abs(b.g.y-a.g.y-dx*a.g.slope)<=h*.55;
}

function mergeSense(target, term, refs) {
  const existing=target.find(sense=>sense.part===term.part&&sense.meaning===term.meaning&&
    sense.plural===term.plural&&sense.countability.join()===term.countability.join());
  if (existing) {
    const seen=new Set(existing.sources.map(item=>item.id));
    existing.sources.push(...refs.filter(item=>!seen.has(item.id)));
  } else target.push({...term,sources:refs});
}

export function parseEntries(record) {
  const start=performance.now();
  const rows=rowsOf(record);
  const rowList=[...rows.values()];
  const entries=record.selection?.entries??[];
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  const heads=new Map(entries.filter(item=>item.word&&(item.phonetics||item.partOfSpeech||item.status==="selected"))
    .map(item=>rows.get(rowKey(item))).filter(Boolean).map(row=>[row.uid,row]));
  const words=[];
  for (const picked of record.final?.words??[]) {
    const entry=byId.get(picked.id);
    const origin=String(entry?.word??picked.word).toLowerCase();
    const chosen=entry?[entry]:[];
    for (const grouped of entry?.sourceEntries??[]) {
      const candidate=byId.get(grouped.id)??grouped;
      const tail=head(candidate,origin);
      if (tail!==null&&/^\[/.test(tail)&&!candidate.supplemental) chosen.push(candidate);
    }
    for (const candidate of entries) {
      if (!entry||candidate.word?.toLowerCase()!==origin||noise.test(candidate.text)) continue;
      const row=rows.get(rowKey(candidate));
      const tail=head(candidate,origin);
      const structured=candidate.phonetics&&tail!==null&&(readSenses(tail).some(term=>term.meanings.length)||
        row&&Boolean(supplementFor(row,tail,rowList,heads)));
      const matchedPrint=record.selection.mode==="red" ?
        candidate.redInk>=.38 : candidate.band||candidate.numbered||
        candidate.darkInk>=.5&&Math.abs(candidate.left-entry.left)<=Math.max(candidate.height,entry.height)*1.35;
      // The selector may inherit a nearby "collocation" flag. For a repeated
      // spelling, require independent typography and same-column evidence
      // before letting that row contribute definitions.
      const alignedRepeat=candidate.darkInk>=.65&&candidate.stroke>=.17&&candidate.relativeHeight>=.9&&
        Math.abs(candidate.left-entry.left)<=Math.max(candidate.height,entry.height)*1.25&&
        Math.abs(candidate.y-entry.y)<=Math.max(candidate.height,entry.height)*14&&
        readSenses(tail??"").some(sense=>sense.meanings.length);
      if (structured&&matchedPrint&&(!candidate.supplemental||alignedRepeat)) chosen.push(candidate);
    }
    const senses=[], sourceRows=[], forms=[], groups=[];
    for (const row of new Set(chosen.map(item=>rows.get(rowKey(item))).filter(Boolean))) {
      const tail=head(row,origin);
      sourceRows.push(source(row));
      if (tail===null) continue;
      const supplemental=supplementFor(row,tail,rowList,heads);
      const combined=supplemental?.combined??tail;
      let parsed=readSenses(combined);
      const tag=parsed.length&&parsed.every(sense=>sense.part==="n.")?nounTag(row,rowList,heads):null;
      if (tag) parsed=readSenses(combined+" "+clean(tag.text));
      if (!parsed.length) {
        const unclear=phoneticTail(combined).match(/^[a-z]{1,3}\.\s*(?=[(\p{Script=Han}])(.+)$/iu);
        if (unclear) parsed=[{part:"",...splitGloss(unclear[1])}];
      }
      const refs=[source(row),...(supplemental?.accepted??[]).map(source),...(tag?[source(tag)]:[])];
      let group=groups.find(group=>sameOccurrence(group.row,row));
      if (!group) {
        group={row,sources:[],senses:[]};
        groups.push(group);
      }
      group.sources.push(...refs.filter(ref=>!group.sources.some(prior=>prior.id===ref.id)));
      const occupied=new Set(group.senses.filter(sense=>sense.meaning).map(sense=>sense.part));
      for (const {part,glosses} of parsed) {
        for (const gloss of glosses) {
          const sameGloss=group.senses.some(sense=>sense.part===part&&sense.meaning===gloss.meaning);
          if (!occupied.has(part)||sameGloss) mergeSense(group.senses,{part,...gloss},refs);
        }
      }
      group.senses=group.senses.filter(sense=>sense.meaning||
        !group.senses.some(complete=>complete.part===sense.part&&complete.meaning));
      if (parsed.some(item=>isVerb(item.part))) {
        const explicit=printedForms(origin,row,rowList);
        if (explicit) forms.push(explicit);
      }
    }
    for (const group of groups) for (const {sources,...sense} of group.senses) mergeSense(senses,sense,sources);
    const nounOnly=senses.length&&senses.every(sense=>sense.part==="n.");
    const english=nounOnly&&senses.some(sense=>sense.plural==="plural")&&
      !senses.some(sense=>sense.plural==="fixed") ? singularNoun(picked.word) : picked.word;
    const distinctForms = unique(forms.map(item=>[item.base,item.past,item.pastParticiple].join("|")));
    const verb=senses.some(item=>isVerb(item.part));
    const verbForms=distinctForms.length===1&&english.toLowerCase()===origin ? forms[0] :
      verb&&distinctForms.length===0 ? suggestForms(english.toLowerCase(),{
        firstSyllableStress:sourceRows.some(ref=>/\[\s*['ˈ][^\]]{1,30}\]/u.test(clean(ref.text))),
      }) : null;
    const reasons=[];
    if (picked.source==="manual") reasons.push("人工補入，缺少 OCR 詞條來源");
    if (!senses.length) reasons.push("找不到可配對的詞性與詞義");
    if (senses.some(sense=>!sense.part)) reasons.push("詞性縮寫無法辨識，請核對原圖");
    if (senses.some(sense=>!sense.meaning)) reasons.push("詞義缺漏，請核對原圖");
    if (forms.length&&sourcesConflict(forms)) reasons.push("教材三態有多種讀值，請核對");
    if (verb&&verbForms?.origin!=="printed") reasons.push(verbForms?"動詞三態為本機建議":"未取得完整動詞三態");
    if (sourceRows.some((a,index)=>sourceRows.slice(index+1).some(b=>a.text!==b.text&&
      a.polygon&&b.polygon&&Math.abs(a.polygon[0][1]-b.polygon[0][1])<
        Math.abs(a.polygon[3][1]-a.polygon[0][1])*.6))) reasons.push("同一位置有多種 OCR 讀值，請核對");
    if (english!==picked.word) reasons.push("已建議改為名詞單數，請核對");
    words.push({id:picked.id,english,originalEnglish:picked.word,senses,sources:sourceRows,
      verbForms,printedForms:forms,occurrences:groups.map(({sources,senses})=>({sources,senses})),
      reasons,links:[],confirmed:false,primary:0});
  }
  const spellings=new Map();
  for (const word of words) {
    const key=word.english.toLowerCase();
    const previous=spellings.get(key);
    if (!previous) {spellings.set(key,word);continue;}
    for (const {sources,...sense} of word.senses) mergeSense(previous.senses,sense,sources);
    previous.sources.push(...word.sources);
    previous.printedForms.push(...word.printedForms);
    previous.occurrences.push(...word.occurrences);
    previous.reasons=unique([...previous.reasons,...word.reasons,"單數正規化後與既有拼字相同，請核對"]);
  }
  const normalized=[...spellings.values()];
  for (const word of normalized) {
    if (!word.senses.some(sense=>sense.part==="adv.")) continue;
    const adjective=normalized.find(other=>other!==word&&other.senses.some(sense=>["a.","adj."].includes(sense.part))&&
      adjectiveFor(other.english,word.english)&&
      other.senses.some(a=>word.senses.some(b=>a.meaning.replace(/的$/,"").length>=2&&
        b.meaning.replace(/(?:地|的)$/,"").includes(a.meaning.replace(/的$/,"")))));
    if (adjective) {
      word.links.push({kind:"adjective",word:adjective.english});
      adjective.links.push({kind:"adverb",word:word.english});
    }
  }
  return {schemaVersion:1,mode:record.selection?.mode??null,original:record.ocr?.original??null,
    elapsedMs:performance.now()-start,words:normalized};
}

const sourcesConflict = forms => new Set(forms.map(item=>[item.past,item.pastParticiple].join("|"))).size>1;

import {isBaseOnlyVerb} from "../verb-lexicon.js";
import { PARTS, englishWord, isVerb, fragmentKind } from "./entry-parser.js";

const han = /\p{Script=Han}/u;
// Common code points that differ from the traditional forms used in the preview.
const variants = /[别内决则计毁装圆断脱记权销归储简体词语动义缩写数东车书长国门开关万带风号题枢练读识误价战经图湾]/u;
const replacement = /[�□■]|[?？]{2,}/u;
const inflection = /^[a-z]+(?:[-' /][a-z]+)*$/i;
const partLabel = /(?:^|[\]\s&])(?:adv|adj|prep|pron|conj|interj|det|art|aux|phr|vt|vi|ad|n|v|a)(?:\.|\s+(?=\p{Script=Han})|(?=\p{Script=Han}))/iu;

function unbalanced(text) {
  const stack=[];
  for (const char of text.normalize("NFKC")) {
    if ("([{".includes(char)) stack.push(char);
    if (")]}".includes(char)&&stack.pop()!=="([{"[")]}".indexOf(char)]) return true;
  }
  return stack.length>0;
}
function glossPortion(text) {
  const cleaned=text.normalize("NFKC");
  const marker=partLabel.exec(cleaned);
  if (!marker) return cleaned;
  return cleaned.slice(marker.index+marker[0].length);
}

export function entryIssues(word) {
  const issues=[];
  const add=(code,message,blocking=false)=>issues.push({code,message,blocking});
  if (!englishWord.test(word.english.trim())) add("english","英文拼字缺漏或格式不完整",true);
  if (!word.senses.length||word.senses.some(sense=>!PARTS.includes(sense.part))) {
    add("pos","詞性缺漏或縮寫無法辨識",true);
  }
  if (!word.senses.length||word.senses.some(sense=>!han.test(sense.meaning))) {
    add("meaning","請補齊中文詞義",true);
  }
  if(word.strictGloss) {
    if(word.senses.some(sense=>fragmentKind(sense.meaning)==="qualifier")) add("incomplete-gloss","詞義只剩註解或括號未完成，請核對後補齊",true);
    if(word.senses.some(sense=>fragmentKind(sense.meaning)==="short"&&!sense.shortGlossVerified)) {
      add("short-gloss","詞義只有一個漢字，請核對是否漏字",true);
    }
    if(word.reasons.some(reason=>reason.includes("大寫缺少"))) add("capitalization","請核對英文大小寫或專有名詞");
  }
  if (word.senses.length&&!word.senses[word.primary]) add("primary","請選擇出題義項",true);
  const meanings=word.senses.map(sense=>sense.meaning.normalize("NFKC").trim());
  const refs=[...new Set([...word.sources,...word.senses.flatMap(sense=>sense.sources)])];
  const sources=[...new Set(refs.map(ref=>glossPortion(ref.text)).filter(text=>han.test(text)))];
  if (refs.some(ref=>/\]\s*(?:adj|adv|prep|vt|vi|n|v|a)\s*(?=\p{Script=Han})/iu.test(ref.text.normalize("NFKC")))) {
    add("pos-source","原始詞性縮寫缺標點，請核對推定詞性");
  }
  if (refs.some(ref=>Number.isFinite(ref.confidence)&&ref.confidence<.72&&han.test(ref.text))) {
    add("low-ocr","中文所在文字框 OCR 信心較低，請核對疑似錯字");
  }
  if (word.reasons.some(reason=>reason.includes("讀值")||reason.includes("教材三態有多種"))) {
    add("readings","同一詞條有不同 OCR 讀值，請核對來源");
  }
  if ([...meanings,...sources].some(text=>variants.test(text))) {
    add("glyphs","有簡繁字形差異，請核對教材用字");
  }
  if (meanings.some(text=>replacement.test(text)||unbalanced(text)||/[;、,:]\s*$/.test(text))||
      sources.some(text=>replacement.test(text))) {
    add("fragment","中文疑有缺字、殘留符號或未完片段");
  }
  if ([...meanings,...sources].some(text=>{
    const gloss=text.replace(/\((?:only|usually)\s+before\s+noun\)/gi,"")
      .replace(/usually\s+sing\./gi,"").replace(/\[\s*[cu](?:[ ,/&]+[cu])*\s*\]?/gi,"");
    return /\p{Script=Han}[).、，:：;；\s]*[a-z]{2,}|\p{Script=Han}\s*[a-z]\s*\p{Script=Han}/iu.test(gloss);
  })) add("latin","中文來源混有英文字母或疑似手寫文字");
  if (word.senses.some(sense=>isVerb(sense.part))&&!(word.automaticImport&&isBaseOnlyVerb(word.english))) {
    const forms=word.verbForms;
    if (!forms||forms.base.trim()!==word.english.trim()||
        [forms.past,forms.pastParticiple].some(form=>!inflection.test(form.trim()))) {
      const deferred=word.strictGloss&&word.deferVerbForms&&isVerb(word.senses[word.primary]?.part)&&!word.verbForms;
      const blocks=!deferred&&(!word.strictGloss||isVerb(word.senses[word.primary]?.part)||!word.senses[word.primary]?.part);
      add("forms",deferred?"已選擇先收錄詞條，補齊三態前暫不出題":blocks?"動詞三態缺漏，或原形與英文不同":
        "動詞三態待補；目前只以所選的非動詞義項出題",blocks);
    } else if (forms.origin==="suggested") add("suggestion","三態為本機建議，請逐字核對");
  }
  return issues;
}

export function orderedEntries(words) {
  const priority=word=>word.confirmed ? 3 : entryIssues(word).some(issue=>issue.blocking) ? 0 :
    entryIssues(word).length ? 1 : 2;
  return [...words].sort((a,b)=>priority(a)-priority(b));
}

export function setEntryConfirmed(word, confirmed) {
  const issues=confirmed?entryIssues(word):[];
  if (issues.some(issue=>issue.blocking)) return false;
  word.confirmed=confirmed;
  word.acknowledgedWarnings=issues.map(issue=>issue.code);
  return true;
}

export function confirmCleanEntries(words) {
  let count=0;
  for (const word of words) if (!word.confirmed&&!entryIssues(word).length) {
    setEntryConfirmed(word,true);
    count++;
  }
  return count;
}

export function reviewSummary(words) {
  const pending=words.filter(word=>!word.confirmed);
  const flagged=pending.filter(word=>entryIssues(word).length>0).length;
  return {confirmed:words.length-pending.length,pending:pending.length,flagged,clean:pending.length-flagged};
}

export function candidateReviewPlan(words) {
  const summary=reviewSummary(words);
  for (const word of words.filter(word=>word.confirmed)) {
    const acknowledged=new Set(word.acknowledgedWarnings??[]);
    if (entryIssues(word).some(issue=>issue.blocking||!acknowledged.has(issue.code))) {
      throw new Error("「"+word.english+"」有必要欄位或警告尚未核對。");
    }
  }
  return summary;
}

export function selectImportable(word) {
  word.automaticImport=true;
  setEntryConfirmed(word,word.includeInImport!==false&&!entryIssues(word).some(issue=>issue.blocking));
  return word;
}

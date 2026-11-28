import {isBaseOnlyVerb} from "../verb-lexicon.js";
import { PARTS, englishWord, isVerb } from "./entry-parser.js";

const han = /\p{Script=Han}/u;
export function candidateBank(words, {unitId, name, material, page=null}) {
  name=name.trim();
  material=material.trim();
  if (!name||!material||!unitId||unitId.trim()!==unitId) throw new Error("請填寫候選單元名稱與教材來源。");
  const selected=words.filter(word=>word.confirmed);
  if (!selected.length) throw new Error("請先勾選已核對的詞條。");
  const result={schemaVersion:1,units:[{id:unitId,name,textbook:material,expectedWordCount:selected.length}],
    words:[],quizSettings:{wordSettings:{},excludedPairs:[]}};
  const used=new Set();
  for (const word of selected) {
    const english=word.english.trim();
    const spelling=english.toLowerCase();
    if (!englishWord.test(english)) throw new Error("請檢查英文拼字。");
    if (used.has(spelling)) throw new Error(english+" 重複，請核對。");
    used.add(spelling);
    const senses=word.senses.map(sense=>({...sense,meaning:sense.meaning.trim()}));
    if (!senses.length||senses.some(sense=>!PARTS.includes(sense.part)||!han.test(sense.meaning))) {
      throw new Error(english+" 的詞性或中文詞義未完成。");
    }
    const parts=[...new Set(senses.map(sense=>sense.part))];
    const primary=senses[word.primary];
    if (!primary) throw new Error(english+" 缺少出題義項。");
    const id=unitId+"-"+spelling.replace(/ /g,"_");
    const entry={id,unitId,english,chineseMeanings:[...new Set(senses.map(sense=>sense.meaning))],
      partOfSpeech:parts.join(" & "),source:{material,page:page?.trim()||null},verificationStatus:"unverified"};
    const setting={sense:{partOfSpeech:primary.part,meaning:primary.meaning}};
    if(word.strictGloss&&word.deferVerbForms&&isVerb(primary.part)&&!word.verbForms) entry.pendingVerbForms=true;
    else if (!isBaseOnlyVerb(english) && parts.some(isVerb) && (!word.strictGloss || isVerb(primary.part) || word.verbForms)) {
      const forms=word.verbForms;
      const inflection=/^[a-z]+(?:[-' /][a-z]+)*$/i;
      if (!forms||forms.base.trim()!==english||[forms.base,forms.past,forms.pastParticiple].some(field=>!inflection.test(field.trim()))) {
        if(word.strictGloss&&!isVerb(primary.part)) {
          result.words.push(entry);
          result.quizSettings.wordSettings[id]=setting;
          continue;
        }
        throw new Error(english+" 缺少完整動詞三態，原形須和英文相同。");
      }
      const triple={base:english,past:forms.past.trim(),pastParticiple:forms.pastParticiple.trim()};
      if (forms.origin==="printed") entry.verbForms=triple;
      else setting.supplementalVerbForms=triple;
    }
    result.words.push(entry);
    result.quizSettings.wordSettings[id]=setting;
  }
  return result;
}

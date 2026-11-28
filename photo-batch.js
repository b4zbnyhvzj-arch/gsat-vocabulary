import {isBaseOnlyVerb} from "./verb-lexicon.js";
import { validateBank, prepareAddedWords, mergeSenses, recordHasSense } from "./bank.js";
import {errorDetails} from "./ocr-task.js";
import { candidateBank } from "./ocr-app-v086/entry-candidate.js";
import { candidateReviewPlan, entryIssues, setEntryConfirmed } from "./ocr-app-v086/entry-review.js";

const wordKey=value=>value.trim().normalize("NFC").toLowerCase();
const union=(a,b)=>[...new Set([...a,...b])];
const verbParts=new Set(["v.","vt.","vi."]);
const parts=value=>value.split(/\s*&\s*/);
const formKeys=["base","past","pastParticiple"];
const sameForms=(a,b)=>formKeys.slice(1).every(key=>a[key].toLowerCase()===b[key].toLowerCase());

export function createPhotoQueue(recognize,prepare=async()=>null) {
  const pages=[];
  let active=null,nextId=0;
  return {
    pages,
    get running(){return active!==null;},
    add(files){
      for (const file of files) pages.push({id:++nextId,file,state:"queued",page:"",attempts:[]});
    },
    remove(id){
      if(active) return false;
      const index=pages.findIndex(page=>page.id===id);
      if(index<0) return false;
      pages.splice(index,1);return true;
    },
    cancel(){active?.abort();},
    async run({retry=false,pageId,onChange=()=>{}}={}) {
      if (active) throw new Error("已有照片正在辨識。");
      const controller=new AbortController();
      active=controller;
      const notify=page=>{
        try {onChange(page);}
        catch(error) {if(page) (page.uiErrors??=[]).push(errorDetails(error));}
      };
      try {
        for (const page of pages) {
          if (controller.signal.aborted) break;
          if (pageId!==undefined ? page.id!==pageId :
            page.state!=="queued"&&!(retry&&["failed","cancelled"].includes(page.state))) continue;
          const attempt={startedAt:new Date().toISOString(),stages:[]}, started=performance.now();
          page.attempts.push(attempt);
          page.state="running";page.error="";page.progress="";
          const progress=status=>{
            page.progress=status;
            attempt.stages.push({status,elapsedMs:performance.now()-started});
            notify(page);
          };
          notify(page);
          try {
            attempt.result=await recognize(page.file,controller.signal,progress);
            progress("解析詞性與詞義");
            const parsed=await prepare(page,attempt.result,controller.signal);
            if(controller.signal.aborted) {
              page.state="cancelled";
            } else {
              page.result=attempt.result;
              Object.assign(page,parsed);
              page.state="done";
            }
          } catch(error) {
            page.state=controller.signal.aborted?"cancelled":"failed";
            page.error=controller.signal.aborted?"":error.message;
            attempt.error=errorDetails(error);
            if(error.partial) attempt.partial=error.partial;
          } finally {
            attempt.state=page.state;
            attempt.elapsedMs=performance.now()-started;
          }
          notify(page);
        }
      } finally {
        active=null;
        notify(null);
      }
    },
  };
}

function sourceDetails(page, refs, fallback) {
  const base={material:page.material,page:page.page||null,...(page.image?{image:page.image}:{})};
  const sources=refs.length?refs:fallback.slice(0,1);
  if (!sources.length) return [base];
  return sources.map(ref=>({...base,...(ref.text?.trim()?{raw:ref.text}:{}),
    ...(ref.polygon?.length===4&&page.original?.width&&page.original?.height ?
      {polygon:ref.polygon,width:page.original.width,height:page.original.height}:{}),
  }));
}

// Selection preferences belong to one page and survive rebuilding its parsed rows.
export const photoSelectionKey=word=>wordKey(word.rawOriginalEnglish??word.originalEnglish);
export const photoWordValid=word=>!entryIssues(word).some(issue=>issue.blocking);
export const photoWordSelected=(selection,word)=>selection.get(photoSelectionKey(word))??photoWordValid(word);

export function groupPhotoWords(pages) {
  const grouped=new Map();
  let pending=0;
  for (const page of pages) {
    const explicit=page.importSelection;
    const rows=explicit? page.words.filter(word=>photoWordSelected(explicit,word)&&photoWordValid(word)):
      page.words.filter(word=>word.confirmed);
    pending+=explicit? page.words.filter(word=>!photoWordValid(word)).length:candidateReviewPlan(page.words).pending;
    for (const selected of rows) {
      // The Lab serializer still uses its review flag. Adapt a copy at that boundary.
      const row=explicit?{...selected}:selected;
      if(explicit) setEntryConfirmed(row,true);
      const key=wordKey(row.english);
      const semantic=row.senses.map(sense=>({...sense,meaning:sense.meaning.trim(),
        sources:sourceDetails(page,sense.sources,row.sources)}));
      const form=row.verbForms?{...row.verbForms,base:row.english.trim()}:null;
      const prior=grouped.get(key);
      if (!prior) {
        grouped.set(key,{...row,english:row.english.trim(),senses:semantic,verbForms:form,
          material:page.material,page:page.page||null,occurrences:1,formsConflict:false});
      } else {
        prior.occurrences++;
        prior.senses.push(...semantic);
        if (!prior.verbForms) prior.verbForms=form;
        else if (form&&!sameForms(prior.verbForms,form)) prior.formsConflict=true;
      }
    }
  }
  return {grouped,pending};
}

export function duplicatePhotoWords(bank, unitId, grouped) {
  const index=new Map(bank.words.filter(word=>word.unitId===unitId).map(word=>[wordKey(word.english),word]));
  return [...grouped].flatMap(([key,row])=>index.has(key)?[{key,incoming:row,existing:index.get(key)}]:[]);
}

function mergePhotoSenses(senses) {
  const combined=mergeSenses(senses);
  return mergeSenses(combined.flatMap(sense=>{
    if(sense.countability?.length) return [sense];
    const explicit=combined.filter(other=>other.partOfSpeech===sense.partOfSpeech&&
      other.meaning===sense.meaning&&(other.plural??null)===(sense.plural??null)&&other.countability?.length);
    return explicit.length===1?[{...sense,countability:explicit[0].countability}]:[sense];
  }));
}

export function preparePhotoImport(current, target, pages, decisions={}) {
  const expected=JSON.stringify(validateBank(current));
  const bank=structuredClone(current);
  const {grouped,pending}=groupPhotoWords(pages);
  let unitId=target.id;
  if (unitId&&!bank.units.some(unit=>unit.id===unitId)) throw new Error("找不到目標單元。");
  if (!unitId) {
    const name=target.name.trim(), textbook=target.material.trim();
    if (!name||!textbook) throw new Error("請填寫新單元名稱及教材。");
    if (bank.units.some(unit=>wordKey(unit.name)===wordKey(name)&&wordKey(unit.textbook??"")===wordKey(textbook))) {
      throw new Error("已有同名同教材的單元，請選擇既有單元。");
    }
    unitId="unit-"+crypto.getRandomValues(new Uint32Array(4)).join("-");
    bank.units.push({id:unitId,name,textbook});
  }
  const duplicates=new Map(duplicatePhotoWords(bank,unitId,grouped).map(item=>[item.key,item.existing]));
  const summary={added:0,updated:0,skipped:0,pending};
  const additions=[];
  for (const [key,row] of grouped) {
    const existing=duplicates.get(key);
    const action=existing?(Object.hasOwn(decisions,key)?decisions[key]:"keep"):"add";
    if (!["keep","merge","replace","add"].includes(action)||(existing&&action==="add")) throw new Error("重複單字處理方式無效。");
    if (action==="keep") {summary.skipped++;continue;}
    if (row.formsConflict) throw new Error("「"+row.english+"」的跨頁動詞三態不同，請先統一，或取消其中一頁的確認。");
    const bankRow=candidateBank([row],{unitId,name:"候選",material:row.material,page:row.page});
    const {id,...word}=bankRow.words[0];
    const selected=bankRow.quizSettings.wordSettings[id];
    word.senses=mergePhotoSenses(row.senses.map(sense=>({partOfSpeech:sense.part,meaning:sense.meaning,
      countability:sense.countability,plural:sense.plural,sources:sense.sources})));
    if (!existing) {
      additions.push({word,quizSettings:selected});
      summary.added++;
      continue;
    }
    const settings=bank.quizSettings.wordSettings;
    const old=Object.hasOwn(settings,existing.id)?settings[existing.id]:{};
    const merged=action==="merge"?{...existing,
      chineseMeanings:union(existing.chineseMeanings,word.chineseMeanings),
      partOfSpeech:union(parts(existing.partOfSpeech),parts(word.partOfSpeech)).join(" & "),
      senses:mergePhotoSenses([...existing.senses??[],...word.senses]),
    }:{...word,id:existing.id,
      senses:mergePhotoSenses([...word.senses,...(existing.senses??[]).filter(sense=>
        word.senses.some(candidate=>candidate.partOfSpeech===sense.partOfSpeech&&candidate.meaning===sense.meaning))]),
    };
    const keptSense=old.sense??{partOfSpeech:parts(existing.partOfSpeech)[0],meaning:existing.chineseMeanings[0]};
    const chosen=recordHasSense(merged,keptSense)
      ?keptSense:selected.sense;
    const finalSettings={sense:chosen};
    if (parts(merged.partOfSpeech).some(part=>verbParts.has(part))) {
      if (!merged.verbForms) {
        const available=action==="merge"?(old.supplementalVerbForms??word.verbForms??selected.supplementalVerbForms):
          (selected.supplementalVerbForms??old.supplementalVerbForms??existing.verbForms);
        if (available) finalSettings.supplementalVerbForms={...available,base:merged.english};
      }
    } else delete merged.verbForms;
    if((row.automaticImport&&isBaseOnlyVerb(merged.english))||merged.verbForms||finalSettings.supplementalVerbForms||!verbParts.has(chosen.partOfSpeech)) {
      delete merged.pendingVerbForms;
    } else if(word.pendingVerbForms) merged.pendingVerbForms=true;
    Object.defineProperty(settings,existing.id,{value:finalSettings,enumerable:true,writable:true,configurable:true});
    bank.words[bank.words.indexOf(existing)]=merged;
    summary.updated++;
  }
  return {expected,unitId,summary,bank:additions.length?prepareAddedWords(bank,additions):validateBank(bank)};
}

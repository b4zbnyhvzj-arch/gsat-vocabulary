import {applyGlossRecovery} from "./photo-gloss-recovery.js";
import {isBaseOnlyVerb} from "./verb-lexicon.js";
import {deadline,errorDetails} from "./ocr-task.js";
import {traditionalConverter} from "./photo-traditional.js";
import {quizReadyWords} from "./bank.js";
import {createQuiz} from "./quiz.js";
import {createPhotoQueue, groupPhotoWords, duplicatePhotoWords, preparePhotoImport, photoSelectionKey, photoWordSelected, photoWordValid} from "./photo-batch.js";
import {createPhotoEngine} from "./photo-ocr.js";
import {photoResources} from "./ocr-assets.js";
import {parseEntries, PARTS, isVerb} from "./ocr-app-v086/entry-parser.js";
import {createReview, selectionExport} from "./ocr-app-v086/selection-review.js";
import {entryIssues, orderedEntries, selectImportable} from "./ocr-app-v086/entry-review.js";

const el=id=>document.getElementById(id);
const node=(tag,text)=>{
  const element=document.createElement(tag);
  if (text!==undefined) element.textContent=text;
  return element;
};
function button(label,action) {
  const control=node("button",label);
  control.type="button";control.className="quiz-button";
  control.addEventListener("click",action);
  return control;
}
function field(label,control) {
  const wrapper=node("label",label);
  wrapper.append(control);return wrapper;
}
function text(value,edit,multiline=false) {
  const control=node(multiline?"textarea":"input");
  if (multiline) control.rows=2;
  control.value=value??"";
  control.addEventListener("input",()=>edit(control.value));
  return control;
}
function select(value,options,edit) {
  const control=node("select");
  for (const [key,label] of options) control.add(new Option(label,key));
  control.value=value;
  control.addEventListener("change",()=>edit(control.value));
  return control;
}

export function mountPhotoImport({readBank,readLatest,commit,done,close}) {
  let events=[], removed=[], imports=[], lastReport=null, verified=false, converter;
  const selections=new WeakMap();
  function selectionFor(page) {
    if(!selections.has(page)) selections.set(page,new Map());
    return selections.get(page);
  }
  function initializeSelection(page,words) {
    const selection=selectionFor(page);
    for(const word of words) {
      const key=photoSelectionKey(word);
      if(!selection.has(key)) selection.set(key,photoWordValid(word));
    }
  }
  const log=(type,data={})=>events.push({type,at:new Date().toISOString(),...data});
  const engine=createPhotoEngine(()=>({mode:"auto",retry:true,
    longSide:Number(el("photo-resolution").value)}),log);
  const queue=createPhotoQueue(engine.recognize,preparePage);
  let current=null, imageUrl=null, working=false, cancelDownload=null, statusCheck=null, preview=null;
  let decisions=Object.create(null), previewScheduled=false;
  const pageList=el("photo-pages"), entries=el("photo-entries");
  const status=(message,error=false)=>{
    el("photo-status").textContent=message;
    el("photo-status").classList.toggle("is-error",error);
  };
  function invalidate() {
    preview=null;
    el("photo-commit").hidden=true;
    el("photo-import-count").textContent="";
    el("photo-quiz-note").textContent="";
  }
  function refreshPreview(){
    invalidate();
    if (working||previewScheduled) return;
    previewScheduled=true;
    queueMicrotask(()=>{previewScheduled=false;if(!working) prepare();});
  }
  function renderProgress(){
    const finished=queue.pages.filter(page=>page.state==="done").length;
    const running=queue.pages.find(page=>page.state==="running");
    el("photo-progress-text").textContent=running?
      "第 "+running.id+" / "+queue.pages.length+" 頁 · "+(running.progress??"準備辨識"):
      "已完成 "+finished+" / "+queue.pages.length+" 頁";
    el("photo-progress").max=Math.max(1,queue.pages.length);
    el("photo-progress").value=finished;
    el("photo-run").disabled=working||!queue.pages.some(page=>page.state==="queued");
    el("photo-retry").disabled=working||!queue.pages.some(page=>["failed","cancelled"].includes(page.state));
    el("photo-stop").disabled=!working;
    el("photo-new-batch").disabled=working;
    for (const id of ["photo-album","photo-camera","photo-resolution","photo-download"]) {
      el(id).disabled=working;
    }
    pageList.replaceChildren(...queue.pages.map(page=>{
      const row=node("li");
      const labels={queued:"等待",running:"辨識中",done:"已完成",failed:"失敗",cancelled:"已停止"};
      row.append(node("p","第 "+page.id+" 頁 · "+page.file.name+" · "+labels[page.state]));
      if (page.error) row.append(node("p",page.error));
      if (page.result) row.append(button("核對第 "+page.id+" 頁",()=>openPage(page)));
      if (page.result&&["failed","cancelled"].includes(page.state)) row.append(button("使用上次可用結果",()=>{
        if(working) return;
        page.state="done";page.error="";
        log("previous-result-restored",{page:page.id});invalidate();renderProgress();openPage(page);refreshPreview();
      }));
      if (page.attempts.length) {
        const retry=button("重新辨識第 "+page.id+" 頁",()=>void run({scan:true,pageId:page.id}));
        retry.disabled=working;row.append(retry);
      }
      const remove=button("移除第 "+page.id+" 頁",()=>{
        if (page.result&&!window.confirm("移除這張照片和本頁的確認內容？")) return;
        removed.push({...pageReport(page),removed:true});
        queue.remove(page.id);
        if(current===page) clearPage();
        invalidate();renderProgress();updateCounts();refreshPreview();
      });
      remove.disabled=working;row.append(remove);
      return row;
    }));
  }
  function bytes(received,total) {
    el("photo-model-status").textContent=(received/1e6).toFixed(1)+" / "+(total/1e6).toFixed(1)+
      " MB"+(received===total?" · OCR 可離線使用":"");
  }
  async function cacheModels(download,signal) {
    const result=await photoResources({download,signal,progress:bytes});
    bytes(result.received,result.total);
    if (download&&!result.ready) throw new Error("OCR 資源尚未驗證完成，請重試。");
  }
  async function run({scan,retry=false,pageId}) {
    if (working) return;
    statusCheck?.abort();
    working=true;invalidate();renderProgress();
    cancelDownload=new AbortController();
    try {
      const signal=cancelDownload.signal;
      if(!verified||!scan) {
        verified=false;
        const assetTask=new AbortController();
        const abort=()=>assetTask.abort();
        signal.addEventListener("abort",abort,{once:true});
        const began=performance.now();
        try {
          await deadline("離線模型下載／驗證",180000,signal,()=>cacheModels(true,assetTask.signal));
          verified=true;log("assets-verified",{elapsedMs:performance.now()-began});
        } finally {signal.removeEventListener("abort",abort);assetTask.abort();}
      }
      if (!scan||signal.aborted) return;
      status("正在循序辨識照片…");
      await queue.run({retry,pageId,onChange:page=>{
        renderProgress();
        if(page?.state==="done") updateCounts();
      }});
      if(queue.pages.some(page=>page.state==="failed"&&/模型／WASM/.test(page.error))) verified=false;
      status(queue.pages.some(page=>page.state==="failed")?
        "有照片辨識失敗。已完成的頁面仍可核對。":"已停止或完成本次辨識，可繼續核對。");
      if(current?.result&&pageId!==undefined) openPage(current);
      if (!current) {
        const first=queue.pages.find(page=>page.state==="done");
        if (first) openPage(first);
      }
    } catch(error) {
      log("batch-error",{error:errorDetails(error)});
      status(cancelDownload.signal.aborted?"已停止。":error.message,!cancelDownload.signal.aborted);
    } finally {
      try {await engine.release();}
      catch(error) {log("release-error",{error:errorDetails(error)});}
      finally {working=false;cancelDownload=null;renderProgress();updateCounts();refreshPreview();}
    }
  }
  const key=value=>String(value??"").trim().normalize("NFKC").toLowerCase();
  async function preparePage(page,result,signal) {
    const review=createReview();
    review.sync(result.selection.entries);
    const old=page.words??[];
    const rawKey=word=>key(word.rawOriginalEnglish??word.originalEnglish);
    const edits=new Map((page.review?.changes()??[]).map(edit=>[key(edit.originalWord),edit]));
    for(const entry of result.selection.entries) {
      const edit=edits.get(key(entry.word));
      if(edit) {
        try {review.edit(entry.id,{checked:edit.checked,word:edit.correctedWord});edits.delete(key(entry.word));}
        catch(error) {log("preserve-head",{page:page.id,error:errorDetails(error)});}
      }
    }
    for(const word of old.filter(word=>word.edited||String(word.id).startsWith("manual-"))) {
      if(!review.final().some(item=>key(item.word)===rawKey(word))) review.add(word.originalEnglish);
    }
    const selection=selectionExport(result.ocr,result.selection,review);
    const worker=new Worker(new URL("./photo-parser-worker.js",import.meta.url),{type:"module"});
    try {
      const parsed=await deadline("解析詞條",15000,signal,()=>new Promise((resolve,reject)=>{
        worker.onmessage=({data})=>data.error?
          reject(new Error(data.error.message,{cause:data.error})):resolve(data.parsed);
        worker.onerror=e=>reject(new Error(e.message||"詞條解析 Worker 失敗。"));
        worker.onmessageerror=()=>reject(new Error("詞條解析結果無法讀取。"));
        worker.postMessage({...selection,recovery:result.recovery});
      }));
      const bySpelling=new Map(old.map(word=>[rawKey(word),word]));
      const words=parsed.words.map(word=>{
        const prior=bySpelling.get(rawKey(word));
        return selectImportable(prior?.edited||String(prior?.id).startsWith("manual-")?
          {...prior,id:word.id,strictGloss:true}:word);
      });
      if(!signal.aborted) initializeSelection(page,words);
      return {review,automatic:structuredClone(parsed),previous:page.words?{words:structuredClone(old),automatic:page.automatic}:null,words};
    } finally {worker.terminate();}
  }
  function rebuild(page) {
    const selection=selectionExport(page.result.ocr,page.result.selection,page.review);
    const parsed=applyGlossRecovery(parseEntries({...selection,recovery:page.result.recovery},
      {strict:true,automaticImport:true,integrateEvidence:true,standardize:converter}),page.result.recovery,converter);
    const old=new Map(page.words.map(word=>[word.id,word]));
    page.words=parsed.words.map(word=>{
      const prior=old.get(word.id);
      return selectImportable(prior?.originalEnglish===word.originalEnglish?prior:word);
    });
    initializeSelection(page,page.words);
    refreshPreview();
  }
  function removePreviewImage(){
    el("photo-image").removeAttribute("src");
    el("photo-mark").replaceChildren();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl=null;
  }
  function openPage(page) {
    removePreviewImage();
    current=page;
    el("photo-page-review").hidden=false;
    el("photo-page-title").textContent="核對第 "+page.id+" 頁";
    el("photo-page-mode").textContent=page.result.selection.modeUncertain?
      "版式判斷不確定，可重新拍攝或手動調整收錄詞條。":"教材模式："+(page.result.selection.mode==="red"?"紅色大字":"黑色粗體");
    el("photo-page-label").value=page.page;
    el("photo-expected").value=page.expected??"";
    el("photo-old-result").hidden=!page.previous;
    el("photo-old-result").open=false;
    el("photo-old-words").replaceChildren(...(page.previous?.words??[]).map(word=>node("li",
      word.english+" · "+word.senses.map(sense=>sense.meaning).join("／"))));
    el("photo-manual-word").value="";
    el("photo-view").open=false;
    renderHeads();renderEntries();
    el("photo-page-title").focus();
  }
  function showPreviewImage(){
    if (!current||imageUrl) return;
    imageUrl=URL.createObjectURL(current.file);
    el("photo-image").src=imageUrl;
  }
  el("photo-view").addEventListener("toggle",()=>{
    if (el("photo-view").open) showPreviewImage();
    else removePreviewImage();
  });
  function showSource(ref) {
    if (!ref.polygon) return;
    el("photo-view").open=true;
    showPreviewImage();
    const {width,height}=current.result.ocr.original;
    const overlay=el("photo-mark");
    overlay.setAttribute("viewBox","0 0 "+width+" "+height);
    const shape=document.createElementNS("http://www.w3.org/2000/svg","polygon");
    shape.setAttribute("points",ref.polygon.map(point=>point.join(",")).join(" "));
    overlay.replaceChildren(shape);
    el("photo-raw").textContent=ref.text;
    const photo=el("photo-image");
    const locate=()=>shape.isConnected&&shape.scrollIntoView({block:"center"});
    if (photo.complete&&photo.naturalWidth) locate();
    else photo.addEventListener("load",locate,{once:true});
  }
  function renderHeads() {
    const headList=el("photo-heads");
    const rows=current.result.selection.entries;
    const checks=rows.filter(row=>row.word).map(row=>{
      const state=current.review.get(row.id);
      const control=node("input");
      control.type="checkbox";control.checked=state.checked;
      control.addEventListener("change",()=>{
        try {
          current.review.edit(row.id,{checked:control.checked,word:state.correctedWord});
          rebuild(current);renderEntries();
        } catch(error) {control.checked=!control.checked;status(error.message,true);}
      });
      const label=field(state.correctedWord+" · "+row.text,control);
      label.className="photo-check";
      return label;
    });
    for (const row of current.review.manuallyAdded()) {
      checks.unshift(button("移除補入的 "+row.correctedWord,()=>{
        current.review.remove(row.id);rebuild(current);renderHeads();renderEntries();
      }));
    }
    headList.replaceChildren(...checks);
  }
  function countsFor(page){
    const entries=page.result?.selection.entries??[];
    const automatic=new Set(entries.filter(entry=>entry.status==="selected"&&entry.word).map(entry=>key(entry.word))).size;
    const review=new Set(entries.filter(entry=>entry.status==="review"&&entry.word&&
      !page.review?.get(entry.id).checked).map(entry=>key(entry.word))).size;
    const words=page.words??[];
    const selected=words.filter(word=>photoWordSelected(selectionFor(page),word)).length;
    const confirmed=words.filter(word=>photoWordSelected(selectionFor(page),word)&&photoWordValid(word)).length;
    const pending=words.filter(word=>entryIssues(word).some(issue=>issue.blocking)).length;
    return {automatic,unselectedReview:review,pending,selected,confirmed};
  }
  function updatePageComparison(){
    if(!current?.result) return;
    const count=countsFor(current),expected=Number(current.expected)||0;
    el("photo-page-comparison").textContent="已辨識 "+count.automatic+" · 待人工修正 "+count.pending+
      " · 已選取 "+count.selected+" · 可匯入 "+count.confirmed+(expected?" · 預期 "+expected+(count.automatic!==expected?"（數量不符，請補查）":""):"")+
      (current.previous?" · 上次選取 "+current.previous.words.length+" 筆，人工修正已保留。":"");
  }
  function updateCounts(){
    updatePageComparison();
    const pages=queue.pages.filter(page=>page.words);
    const words=pages.flatMap(page=>page.words);
    for(const id of ["photo-select-all","photo-clear-selection"]) el(id).disabled=!words.length;
    const counts=pages.map(countsFor);
    const selected=counts.reduce((sum,count)=>sum+count.selected,0);
    const confirmed=counts.reduce((sum,count)=>sum+count.confirmed,0);
    const pending=words.filter(word=>entryIssues(word).some(issue=>issue.blocking)).length;
    const grouped=new Map();
    for (const word of words) {
      const key=word.english.trim().normalize("NFC").toLowerCase();
      grouped.set(key,(grouped.get(key)??0)+1);
    }
    const crossPage=[...grouped.values()].filter(count=>count>1).length;
    const unitWords=new Set(readBank().words.filter(word=>word.unitId===el("photo-target").value)
      .map(word=>word.english.trim().normalize("NFC").toLowerCase()));
    const existing=[...grouped.keys()].filter(key=>unitWords.has(key)).length;
    el("photo-counts").textContent="已選取 "+selected+" · 可匯入 "+confirmed+" · 缺少必要資料 "+pending+
      " · 批次同拼字 "+crossPage+" · 單元重複 "+existing;
  }
  function wordCard(word) {
    const row=node("article");
    row.className="photo-word";
    const card=node("details");
    card.open=!photoWordValid(word);
    const title=node("summary","編輯詞條");
    const selection=selectionFor(current);
    const warnings=node("ul");
    warnings.className="photo-warnings";
    const checked=node("input");
    checked.type="checkbox";
    const checkText=node("span");
    const checkLabel=node("label");
    checkLabel.append(checked,checkText);
    checkLabel.className="photo-check";
    const refresh=()=>{
      const issues=entryIssues(word).filter(issue=>issue.blocking);
      checked.checked=photoWordSelected(selection,word);
      checkText.textContent=word.english+(issues.length?" · 需補資料":"");
      checked.setAttribute("aria-label","匯入 "+word.english);
      warnings.replaceChildren(...issues.map(issue=>node("li",issue.message)));
      warnings.hidden=!issues.length;
    };
    const edit=()=>{word.edited=true;selectImportable(word);refresh();updateCounts();refreshPreview();};
    checked.addEventListener("change",()=>{
      selection.set(photoSelectionKey(word),checked.checked);
      updateCounts();refreshPreview();
    });
    card.append(title,warnings,field("英文",text(word.english,value=>{word.english=value;edit();})));
    for (const [index,sense] of word.senses.entries()) {
      const group=node("fieldset");
      group.append(node("legend","義項 "+(index+1)),
        field("詞性",select(sense.part,[["","選擇詞性"],...PARTS.map(part=>[part,part])],value=>{
          sense.part=value;
          forms.hidden=isBaseOnlyVerb(word.english)||!word.senses.some(item=>isVerb(item.part));
          edit();
        })),
        field("中文詞義",text(sense.meaning,value=>{
          sense.meaning=converter?converter(value):value;
          sense.shortGlossVerified=false;edit();
        },true)));
      const primary=node("input");
      primary.type="radio";primary.name="photo-primary-"+word.id;primary.checked=word.primary===index;
      primary.addEventListener("change",()=>{word.primary=index;edit();});
      const primaryLabel=field("用這個義項出題",primary);
      primaryLabel.className="photo-check";
      group.append(primaryLabel);
      for (const ref of sense.sources.length?sense.sources:word.sources.slice(0,1)) {
        group.append(button("查看詞義來源",()=>showSource(ref)));
      }
      group.append(button("移除義項",()=>{
        word.senses.splice(index,1);
        if (index===word.primary) word.primary=0;
        else if (index<word.primary) word.primary--;
        edit();renderEntries();
      }));
      card.append(group);
    }
    card.append(button("新增義項",()=>{
      word.senses.push({part:"",meaning:"",countability:[],plural:null,sources:[]});
      edit();renderEntries();
    }));
    const forms=node("fieldset");
    forms.hidden=isBaseOnlyVerb(word.english)||!word.senses.some(sense=>isVerb(sense.part));
    forms.append(node("legend","動詞三態"));
    for (const [key,label] of [["base","原形"],["past","過去式"],["pastParticiple","過去分詞"]]) {
      forms.append(field(label,text(word.verbForms?.[key]??(key==="base"?word.english:""),value=>{
        word.verbForms??={base:word.english,past:"",pastParticiple:"",origin:"reviewed"};
        word.verbForms[key]=value;word.verbForms.origin="reviewed";word.deferVerbForms=false;defer.checked=false;edit();
      })));
    }
    const defer=node("input");
    defer.type="checkbox";defer.checked=word.deferVerbForms===true;
    defer.addEventListener("change",()=>{
      if(defer.checked&&Object.values(word.verbForms??{}).some(value=>typeof value==="string"&&value.trim())) {
        if(!window.confirm("要改成三態待補？未完成的三態不會寫入題庫。")) {defer.checked=false;return;}
        word.verbForms=null;
      }
      word.deferVerbForms=defer.checked;
      edit();renderEntries();
    });
    const deferLabel=field("保留已核對詞義，三態待補時暫不出題",defer);
    deferLabel.className="photo-check";
    forms.append(deferLabel);
    for (const ref of word.sources) {
      const source=node("details");
      source.append(node("summary","原始 OCR"),node("p",ref.text),button("看原圖",()=>showSource(ref)));
      card.append(source);
    }
    card.append(forms);row.append(checkLabel,card);refresh();
    return row;
  }
  function renderEntries() {
    entries.replaceChildren(...orderedEntries(current?.words??[]).map(wordCard));
    updateCounts();
  }
  const payload=()=>queue.pages.filter(page=>page.words&&page.state==="done").map(page=>({words:page.words,importSelection:selectionFor(page),
    material:sourceMaterial(),page:page.page.trim(),image:"第 "+page.id+" 張 · "+page.file.name,
    original:page.result.ocr.original}));
  const sourceMaterial=()=>readBank().units.find(unit=>unit.id===el("photo-target").value)?.textbook||"照片匯入";
  const target=()=>({id:el("photo-target").value,name:el("photo-unit").value,material:sourceMaterial()});
  function prepare() {
    invalidate();
    try {
      const bank=readLatest(), data=payload();
      const {grouped}=groupPhotoWords(data);
      if(!grouped.size) {el("photo-duplicates").hidden=true;return;}
      if(!target().id&&!target().name.trim()) {
        el("photo-import-count").textContent="請選擇單元或填寫新單元名稱。";return;
      }
      const duplicates=duplicatePhotoWords(bank,target().id,grouped);
      const policy=el("photo-duplicate-policy").value;
      decisions=Object.fromEntries(duplicates.map(({key})=>[key,policy]));
      el("photo-duplicates").hidden=!duplicates.length;
      el("photo-duplicate-warning").hidden=policy==="keep";
      el("photo-duplicate-warning").textContent=policy==="replace"?
        "此選擇會覆寫所有重複詞條的詞義，包含人工修正。原有 ID 及學習紀錄會保留。":
        "原有詞義會保留，新詞義將加入同一詞條。";
      el("photo-duplicate-rows").replaceChildren(...duplicates.map(({incoming,existing})=>{
        const row=node("section");
        row.append(node("h3",incoming.english),node("p","原詞義："+existing.chineseMeanings.join("、")),
          node("p","新詞義："+incoming.senses.map(sense=>sense.part+" "+sense.meaning).join("、")));
        return row;
      }));
      preview=preparePhotoImport(bank,target(),data,decisions);
      const {added,updated,skipped}=preview.summary;
      const pending=queue.pages.reduce((sum,page)=>sum+countsFor(page).pending,0);
      const incomplete=queue.pages.filter(page=>page.state!=="done").length;
      const totals=queue.pages.reduce((sum,page)=>{
        const counts=countsFor(page);
        const expected=Number(page.expected)||0;
        return {expected:sum.expected+expected,automatic:sum.automatic+counts.automatic,
          review:sum.review+counts.unselectedReview,gaps:sum.gaps+Number(expected>0&&
            (expected!==counts.automatic||expected!==counts.confirmed))};
      },{expected:0,automatic:0,review:0,gaps:0});
      el("photo-import-count").textContent="新增 "+added+" · 更新 "+updated+" · 略過重複 "+skipped+
        " · 缺少必要資料 "+pending+" · 未完成照片 "+incomplete+" · 已辨識 "+totals.automatic+
        " · 實際將匯入 "+(added+updated)+
        (preview.bank.words.some(word=>word.unitId===preview.unitId&&word.pendingVerbForms)?" · 本單元有三態待補詞條":"")+(totals.expected?" · 已填預期合計 "+totals.expected:"")+
        (totals.gaps?" · "+totals.gaps+" 頁需補查":"")+(totals.review?" · 未勾選候選 "+totals.review:"");
      if (added+updated===0) {
        el("photo-import-count").append("。可以調整重複策略。");
        return;
      }
      try {
        createQuiz(quizReadyWords(preview.bank.words),preview.unitId,{quizSettings:preview.bank.quizSettings,random:()=>0.5});
        el("photo-quiz-note").textContent="匯入後可開始基礎測驗。";
      } catch(error) {
        el("photo-quiz-note").textContent="詞條仍可匯入。測驗暫不可用："+error.message;
      }
      el("photo-commit").hidden=false;
      el("photo-commit").textContent="匯入 "+(added+updated)+" 筆詞條";
    } catch(error) {status(error.message,true);}
  }
  for (const id of ["photo-album","photo-camera"]) el(id).addEventListener("change",event=>{
    queue.add(event.target.files);event.target.value="";
    invalidate();renderProgress();
    if(queue.pages.some(page=>page.state==="queued")) void run({scan:true});
  });
  for(const [id,selected] of [["photo-select-all",true],["photo-clear-selection",false]]) {
    el(id).addEventListener("click",()=>{
      for(const page of queue.pages) {
        for(const word of page.words??[]) selectionFor(page).set(photoSelectionKey(word),selected&&photoWordValid(word));
      }
      renderEntries();refreshPreview();
    });
  }
  el("photo-run").addEventListener("click",()=>void run({scan:true}));
  el("photo-retry").addEventListener("click",()=>void run({scan:true,retry:true}));
  el("photo-download").addEventListener("click",()=>void run({scan:false}));
  el("photo-stop").addEventListener("click",()=>{cancelDownload?.abort();queue.cancel();status("正在停止…");});
  el("photo-expected").addEventListener("input",event=>{
    current.expected=event.target.value;refreshPreview();updatePageComparison();
  });
  el("photo-page-label").addEventListener("input",event=>{current.page=event.target.value;refreshPreview();});
  el("photo-add-word").addEventListener("click",()=>{
    try {
      current.review.add(el("photo-manual-word").value);
      el("photo-manual-word").value="";
      rebuild(current);renderHeads();renderEntries();
    } catch(error) {status(error.message,true);}
  });
  el("photo-target").addEventListener("change",()=>{
    el("photo-new-unit").hidden=Boolean(el("photo-target").value);
    el("photo-duplicate-policy").value="keep";
    refreshPreview();updateCounts();
  });
  el("photo-unit").addEventListener("input",refreshPreview);
  el("photo-duplicate-policy").addEventListener("change",refreshPreview);
  el("photo-commit").addEventListener("click",()=>{
    if (!preview||working) return;
    if(el("photo-duplicate-policy").value==="replace"&&Object.keys(decisions).length&&
        !window.confirm("更新所有重複詞條？既有人工修正的詞義將被新版詞義取代。")) return;
    try {
      const saved=commit(preview);
      const oldBank=JSON.parse(preview.expected), summary=preview.summary;
      imports.push({at:new Date().toISOString(),unitId:preview.unitId,summary,choices:{...decisions},
        pages:payload().map(page=>({page:page.page,image:page.image,words:page.words.filter(word=>photoWordSelected(page.importSelection,word)&&photoWordValid(word)).map(word=>word.english)})),
        written:saved.words.filter(word=>word.unitId===preview.unitId&&
          JSON.stringify(word)!==JSON.stringify(oldBank.words.find(prior=>prior.id===word.id)))
          .map(word=>({id:word.id,english:word.english})),
      });
      done(saved,preview.unitId,summary);
      const pending=queue.pages.reduce((sum,page)=>sum+countsFor(page).pending,0);
      const failedPages=queue.pages.filter(page=>page.state!=="done").length;
      status("此輪已寫入 "+(summary.added+summary.updated)+" 筆 · 待確認 "+pending+
        " 筆 · 未完成 "+failedPages+" 頁。可繼續核對或開始下一批。");
      invalidate();
    } catch(error) {status(error.message,true);invalidate();}
  });
  function pageReport(page){
    const words=(page.words??[]).map(word=>({...word,selectedForImport:photoWordSelected(selectionFor(page),word),issues:entryIssues(word)}));
    return {id:page.id,file:page.file.name,type:page.file.type,bytes:page.file.size,page:page.page,
      state:page.state,expected:page.expected??null,counts:countsFor(page),error:page.error??null,
      attempts:page.attempts,automatic:page.automatic,manual:page.review?.changes(),words,
      previous:page.previous,uiErrors:page.uiErrors};
  }
  function report(){
    return {appVersion:"0.8.6",schemaVersion:1,createdAt:new Date().toISOString(),
      model:"PaddleOCR.js 0.4.2 · PP-OCRv5 Mobile · WASM 1 thread",
      pages:[...removed,...queue.pages.map(pageReport)],events,imports};
  }
  function clearPage(){
    current=null;removePreviewImage();el("photo-page-review").hidden=true;renderEntries();
  }
  function resetBatch(){
    if(queue.pages.length||events.length) lastReport=structuredClone(report());
    queue.pages.length=0;events=[];imports=[];removed=[];decisions=Object.create(null);
    clearPage();
    el("photo-duplicates").hidden=true;el("photo-duplicate-policy").value="keep";
    el("photo-duplicate-rows").replaceChildren();invalidate();renderProgress();
  }
  el("photo-new-batch").addEventListener("click",()=>{
    if(working) return;
    if(queue.pages.length&&!window.confirm("開始新一批？目前結果保留在上一批診斷報告。")) return;
    resetBatch();status("請加入下一批照片。");
  });
  el("photo-diagnostics").addEventListener("click",()=>{
    const detail=queue.pages.length||events.length?report():lastReport??report();
    const link=node("a"),url=URL.createObjectURL(new Blob([JSON.stringify(detail,null,2)],{type:"application/json"}));
    link.href=url;link.download="GSAT-OCR-diagnostics.json";document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  });
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden&&working){log("background-cancel");cancelDownload?.abort();queue.cancel();}
  });
  window.addEventListener("pagehide",()=>{
    cancelDownload?.abort();queue.cancel();statusCheck?.abort();
  });
  el("photo-back").addEventListener("click",()=>{
    if (working) {status("請先停止辨識，再返回單元。");return;}
    if (queue.pages.length&&!window.confirm("返回後將清除這次尚未匯入的照片與確認資料。確定返回？")) return;
    close();
  });
  return {
    open(){
      el("photo-target").replaceChildren(new Option("新增單元",""),
        ...readBank().units.map(unit=>new Option(unit.name+(unit.textbook?" · "+unit.textbook:""),unit.id)));
      el("photo-new-unit").hidden=false;
      status("");invalidate();renderProgress();renderEntries();
      // Opening the entry point checks metadata only; the engine and models remain unloaded.
      const controller=new AbortController();
      statusCheck=controller;
      void traditionalConverter().then(value=>{converter=value;}).catch(error=>log("dictionary-error",{error:errorDetails(error)}));
      void photoResources({signal:controller.signal,presenceOnly:true}).then(result=>{
        if(!controller.signal.aborted) el("photo-model-status").textContent=result.ready?
          "模型已快取，首次辨識時核對。":"尚有離線模型待下載。";
      }).catch(error=>{
        if(!controller.signal.aborted) el("photo-model-status").textContent=error.message;
      });
    },
    reset(){
      statusCheck?.abort();
      resetBatch();
      for(const id of ["photo-unit","photo-page-label"]) el(id).value="";
    },
  };
}

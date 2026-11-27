import {createQuiz} from "./quiz.js";
import {createPhotoQueue, groupPhotoWords, duplicatePhotoWords, preparePhotoImport} from "./photo-batch.js";
import {createPhotoEngine} from "./photo-ocr.js";
import {photoResources} from "./ocr-assets.js";
import {parseEntries, PARTS, isVerb} from "./ocr-lab/entry-parser.js";
import {createReview, selectionExport} from "./ocr-lab/selection-review.js";
import {entryIssues, orderedEntries, setEntryConfirmed, confirmCleanEntries, reviewSummary} from "./ocr-lab/entry-review.js";

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
  const engine=createPhotoEngine(()=>({mode:el("photo-mode").value,retry:el("photo-local-retry").checked}));
  const queue=createPhotoQueue(engine.recognize);
  let current=null, imageUrl=null, working=false, cancelDownload=null, statusCheck=null, preview=null;
  let decisions=Object.create(null);
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
    for (const id of ["photo-album","photo-camera","photo-mode","photo-local-retry","photo-download","photo-preview-import"]) {
      el(id).disabled=working;
    }
    pageList.replaceChildren(...queue.pages.map(page=>{
      const row=node("li");
      const labels={queued:"等待",running:"辨識中",done:"已完成",failed:"失敗",cancelled:"已停止"};
      row.append(node("p","第 "+page.id+" 頁 · "+page.file.name+" · "+labels[page.state]));
      if (page.error) row.append(node("p",page.error));
      if (page.state==="done") row.append(button("核對第 "+page.id+" 頁",()=>openPage(page)));
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
  async function run({scan,retry=false}) {
    if (working) return;
    statusCheck?.abort();
    working=true;invalidate();renderProgress();
    cancelDownload=new AbortController();
    try {
      await cacheModels(true,cancelDownload.signal);
      if (!scan||cancelDownload.signal.aborted) return;
      status("正在循序辨識照片…");
      await queue.run({retry,onChange:page=>{
        if (page?.state==="done"&&!page.review) {
          page.review=createReview();
          page.review.sync(page.result.selection.entries);
          page.words=[];
          rebuild(page);
        }
        renderProgress();
      }});
      status(queue.pages.some(page=>page.state==="failed")?
        "有照片辨識失敗。已完成的頁面仍可核對。":"已停止或完成本次辨識，可繼續核對。");
      if (!current) {
        const first=queue.pages.find(page=>page.state==="done");
        if (first) openPage(first);
      }
    } catch(error) {
      status(cancelDownload.signal.aborted?"已停止。":error.message,!cancelDownload.signal.aborted);
    } finally {
      await engine.release().catch(()=>{});
      working=false;cancelDownload=null;renderProgress();
    }
  }
  function rebuild(page) {
    const selection=selectionExport(page.result.ocr,page.result.selection,page.review);
    const parsed=parseEntries({...selection,recovery:page.result.recovery});
    const old=new Map(page.words.map(word=>[word.id,word]));
    page.words=parsed.words.map(word=>{
      const prior=old.get(word.id);
      return prior?.originalEnglish===word.originalEnglish?prior:word;
    });
    invalidate();
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
      "版式判斷不確定，可選擇教材模式後重新加入照片。":"教材模式："+(page.result.selection.mode==="red"?"紅色大字":"黑色粗體");
    el("photo-page-label").value=page.page;
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
  function updateCounts(){
    const pages=queue.pages.filter(page=>page.words);
    const words=pages.flatMap(page=>page.words);
    const {confirmed,pending,flagged}=reviewSummary(words);
    const grouped=new Map();
    for (const word of words) {
      const key=word.english.trim().normalize("NFC").toLowerCase();
      grouped.set(key,(grouped.get(key)??0)+1);
    }
    const crossPage=[...grouped.values()].filter(count=>count>1).length;
    const unitWords=new Set(readBank().words.filter(word=>word.unitId===el("photo-target").value)
      .map(word=>word.english.trim().normalize("NFC").toLowerCase()));
    const existing=[...grouped.keys()].filter(key=>unitWords.has(key)).length;
    el("photo-counts").textContent="已確認 "+confirmed+" · 待確認 "+pending+"（"+flagged+
      " 有警告） · 批次同拼字 "+crossPage+" · 單元重複 "+existing;
    el("photo-confirm-clean").disabled=!words.some(word=>!word.confirmed&&!entryIssues(word).length);
  }
  function wordCard(word) {
    const card=node("details");
    card.className="photo-word";
    card.open=!word.confirmed;
    const title=node("summary");
    const warnings=node("ul");
    warnings.className="photo-warnings";
    const checked=node("input");
    checked.type="checkbox";
    const checkLabel=field("已核對詞義及警告",checked);
    checkLabel.className="photo-check";
    const refresh=()=>{
      const issues=entryIssues(word);
      title.textContent=word.english+" · "+(word.confirmed?"已確認":issues.length?"需核對":"待確認");
      checked.checked=word.confirmed;
      checked.disabled=issues.some(issue=>issue.blocking);
      warnings.replaceChildren(...issues.map(issue=>node("li",issue.message)));
      warnings.hidden=!issues.length;
      updateCounts();
    };
    const edit=()=>{setEntryConfirmed(word,false);invalidate();refresh();};
    checked.addEventListener("change",()=>{setEntryConfirmed(word,checked.checked);invalidate();refresh();});
    card.append(title,warnings,field("英文",text(word.english,value=>{word.english=value;edit();})));
    for (const [index,sense] of word.senses.entries()) {
      const group=node("fieldset");
      group.append(node("legend","義項 "+(index+1)),
        field("詞性",select(sense.part,[["","選擇詞性"],...PARTS.map(part=>[part,part])],value=>{
          sense.part=value;
          forms.hidden=!word.senses.some(item=>isVerb(item.part));
          edit();
        })),
        field("中文詞義",text(sense.meaning,value=>{sense.meaning=value;edit();},true)));
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
    forms.hidden=!word.senses.some(sense=>isVerb(sense.part));
    forms.append(node("legend","動詞三態"));
    for (const [key,label] of [["base","原形"],["past","過去式"],["pastParticiple","過去分詞"]]) {
      forms.append(field(label,text(word.verbForms?.[key]??(key==="base"?word.english:""),value=>{
        word.verbForms??={base:word.english,past:"",pastParticiple:"",origin:"reviewed"};
        word.verbForms[key]=value;word.verbForms.origin="reviewed";edit();
      })));
    }
    for (const ref of word.sources) {
      const source=node("details");
      source.append(node("summary","原始 OCR"),node("p",ref.text),button("看原圖",()=>showSource(ref)));
      card.append(source);
    }
    card.append(forms,checkLabel);refresh();
    return card;
  }
  function renderEntries() {
    entries.replaceChildren(...orderedEntries(current?.words??[]).map(wordCard));
    updateCounts();
  }
  const payload=()=>queue.pages.filter(page=>page.words).map(page=>({words:page.words,
    material:el("photo-material").value.trim(),page:page.page.trim(),image:"第 "+page.id+" 張 · "+page.file.name,
    original:page.result.ocr.original}));
  const target=()=>({id:el("photo-target").value,name:el("photo-unit").value,material:el("photo-material").value});
  function prepare() {
    invalidate();
    try {
      const bank=readLatest(), data=payload();
      if (!target().material.trim()) throw new Error("請填寫教材來源。");
      const {grouped}=groupPhotoWords(data);
      if (grouped.size===0) throw new Error("請先核對並勾選要匯入的詞條。");
      const duplicates=duplicatePhotoWords(bank,target().id,grouped);
      const controls=duplicates.map(({key,incoming,existing})=>{
        const row=node("section");
        row.append(node("h3",incoming.english),node("p","原詞義："+existing.chineseMeanings.join("、")),
          node("p","新詞義："+incoming.senses.map(sense=>sense.part+" "+sense.meaning).join("、")),
          field("重複單字處理",select(decisions[key]??"keep",[["keep","保留原資料"],["merge","合併新詞義"],
            ["replace","確認更新既有資料"]],value=>{decisions[key]=value;prepare();})));
        return row;
      });
      el("photo-duplicates").replaceChildren(...controls);
      preview=preparePhotoImport(bank,target(),data,decisions);
      const {added,updated,skipped,pending}=preview.summary;
      const incomplete=queue.pages.filter(page=>page.state!=="done").length;
      el("photo-import-count").textContent="新增 "+added+" · 更新 "+updated+" · 略過重複 "+skipped+
        " · 待確認 "+pending+" · 未完成照片 "+incomplete;
      if (added+updated===0) {
        status("沒有將寫入的詞條。可調整重複單字處理方式。");
        return;
      }
      try {
        createQuiz(preview.bank.words,preview.unitId,{quizSettings:preview.bank.quizSettings,random:()=>0.5});
        el("photo-quiz-note").textContent="匯入後可開始基礎測驗。";
      } catch(error) {
        el("photo-quiz-note").textContent="詞條仍可匯入。測驗暫不可用："+error.message;
      }
      el("photo-commit").hidden=false;
      el("photo-commit").textContent=pending||incomplete?"略過未完成項目並確認匯入":"確認匯入題庫";
      status("");
    } catch(error) {status(error.message,true);}
  }
  for (const id of ["photo-album","photo-camera"]) el(id).addEventListener("change",event=>{
    queue.add(event.target.files);event.target.value="";
    invalidate();renderProgress();
  });
  el("photo-run").addEventListener("click",()=>void run({scan:true}));
  el("photo-retry").addEventListener("click",()=>void run({scan:true,retry:true}));
  el("photo-download").addEventListener("click",()=>void run({scan:false}));
  el("photo-stop").addEventListener("click",()=>{cancelDownload?.abort();queue.cancel();status("正在停止…");});
  el("photo-page-label").addEventListener("input",event=>{current.page=event.target.value;invalidate();});
  el("photo-add-word").addEventListener("click",()=>{
    try {
      current.review.add(el("photo-manual-word").value);
      el("photo-manual-word").value="";
      rebuild(current);renderHeads();renderEntries();
    } catch(error) {status(error.message,true);}
  });
  el("photo-confirm-clean").addEventListener("click",()=>{
    confirmCleanEntries(queue.pages.flatMap(page=>page.words??[]));invalidate();renderEntries();
  });
  el("photo-target").addEventListener("change",()=>{
    el("photo-new-unit").hidden=Boolean(el("photo-target").value);
    decisions=Object.create(null);
    el("photo-duplicates").replaceChildren();invalidate();updateCounts();
  });
  for (const id of ["photo-unit","photo-material"]) el(id).addEventListener("input",invalidate);
  el("photo-preview-import").addEventListener("click",prepare);
  el("photo-commit").addEventListener("click",()=>{
    if (!preview||working) return;
    try {
      const saved=commit(preview);
      done(saved,preview.unitId,preview.summary);
    } catch(error) {status(error.message,true);invalidate();}
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
      void cacheModels(false,controller.signal).catch(error=>{
        if(!controller.signal.aborted) el("photo-model-status").textContent=error.message;
      });
    },
    reset(){
      statusCheck?.abort();
      queue.pages.length=0;
      current=null;decisions=Object.create(null);
      removePreviewImage();
      el("photo-page-review").hidden=true;
      for (const id of ["photo-unit","photo-material","photo-page-label"]) el(id).value="";
      el("photo-duplicates").replaceChildren();
      invalidate();renderEntries();renderProgress();
    },
  };
}

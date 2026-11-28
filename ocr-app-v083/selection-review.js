const format = /^[a-zA-Z]+(?:[-' ][a-zA-Z]+)*$/;
const clean = value => String(value).normalize("NFKC").replace(/[’‘]/g,"'").trim().replace(/\s+/g," ");
const key = value => clean(value).toLowerCase();

export function createReview() {
  let manual = new Map();
  let edits = new Map();
  let nextId = 1;
  const conflict = (value, except) => [...edits, ...manual].some(([id,row]) =>
    id!==except && row.checked && key(row.correctedWord)===key(value));

  function sync(entries) {
    const overrides=new Map([...edits].filter(([,row])=>row.changed));
    edits=new Map();
    // Explicitly confirmed entries and manual additions take precedence
    // over defaults when switching the textbook mode.
    for(const entry of entries) {
      const previous=overrides.get(entry.id);
      if(previous?.originalWord===entry.word && previous) edits.set(entry.id,{...previous});
    }
    for(const entry of entries){
      if(edits.has(entry.id))continue;
      const word=entry.word??"";
      edits.set(entry.id,{originalWord:entry.word,correctedWord:word,
        checked:entry.status==="selected"&&format.test(word)&&!conflict(word),changed:false});
    }
  }
  function edit(id,{word,checked}) {
    const current=edits.get(id);
    if(!current) throw new Error("找不到要修正的辨識項目。");
    const correctedWord=clean(word);
    if(checked&&!format.test(correctedWord)) throw new Error("請輸入英文單字。");
    if(checked&&conflict(correctedWord,id)) throw new Error("這個英文單字已收錄。");
    const row={...current,correctedWord,checked,changed:true};
    edits.set(id,row);
    return {...row};
  }
  function add(value) {
    const correctedWord=clean(value);
    if(!format.test(correctedWord)) throw new Error("請輸入英文單字。");
    if(conflict(correctedWord)) throw new Error("這個英文單字已收錄。");
    const id="manual-"+nextId++;
    manual.set(id,{id,correctedWord,checked:true,source:"manual"});
    return id;
  }
  const manuallyAdded = () => [...manual.values()].map(row=>({...row}));
  const final = () => [
    ...[...edits].filter(([,row])=>row.checked).map(([id,row])=>({id,word:row.correctedWord,
      source:row.changed?"reviewed-ocr":"ocr"})),
    ...manuallyAdded().map(row=>({id:row.id,word:row.correctedWord,source:"manual"})),
  ];
  return {sync,edit,add,remove:id=>manual.delete(id),manuallyAdded,final,
    get:id=>({...edits.get(id)}), changes:()=>[...edits].filter(([,row])=>row.changed)
      .map(([id,row])=>({id,...row}))};
}

export function selectionExport(ocr, selection, review) {
  const records = status => selection.entries.filter(entry=>entry.status===status);
  return {schemaVersion:2,ocr,selection:{...selection,
    automatic:records("selected"),needsReview:records("review"),excluded:records("excluded")},
    timings:{initializationMs:ocr.initializationMs??null,ocrMs:ocr.elapsedMs,
      decodeMs:ocr.imageDecodeMs??null,resizeMs:ocr.resizeMs??null,selectionMs:selection.elapsedMs},
    manual:{edits:review.changes(),added:review.manuallyAdded()},final:{count:review.final().length,words:review.final()}};
}

const dictURL=file=>new URL("./vendor/opencc/"+file+".txt",import.meta.url);
let converterPromise;
function table(text) {
  const rows=new Map();
  for(const line of text.split(/\r?\n/)) {
    if(!line||line.startsWith("#")) continue;
    const [from,to]=line.split("\t");
    if(to) rows.set(from,to.split(" "));
  }
  return rows;
}
export function buildTraditionalConverter(characters,phrases) {
  const glyphs=table(characters), words=table(phrases);
  const plain=char=>glyphs.get(char)?.length===1?glyphs.get(char)[0]:char;
  const mixed=new Map();
  for(const [from,options] of words) {
    if(options.length!==1) continue;
    const key=[...from].map(plain).join("");
    if(key!==from) {
      const prior=mixed.get(key);
      mixed.set(key,prior&&prior[0]!==options[0]?[]:prior?.length===0?prior:options);
    }
  }
  let max=0;
  for(const key of words.keys()) max=Math.max(max,key.length);
  return text=>{
    let output="";
    for(let i=0;i<text.length;) {
      let match;
      if(/\p{Script=Han}/u.test(text[i])){
        for(let size=Math.min(max,text.length-i);size>1;size--) {
          const phrase=text.slice(i,i+size), options=words.get(phrase)??mixed.get(phrase);
          if(options?.length) {match=options.length===1?options[0]:(options.includes(phrase)?phrase:options[0]);i+=size;break;}
        }
      }
      if(match!==undefined) {output+=match;continue;}
      const char=String.fromCodePoint(text.codePointAt(i)), options=glyphs.get(char);
      // Ambiguous single characters stay as printed until a phrase or editor resolves them.
      output+=options?.length===1?options[0]:char;
      i+=char.length;
    }
    return output;
  };
}
export function traditionalConverter() {
  converterPromise??=Promise.all(["STCharacters","STPhrases"].map(async name=>{
    const response=await fetch(dictURL(name));
    if(!response.ok) throw new Error("無法讀取離線簡繁字典。");
    return response.text();
  })).then(([chars,phrases])=>buildTraditionalConverter(chars,phrases)).catch(error=>{
    converterPromise=null;
    throw error;
  });
  return converterPromise;
}

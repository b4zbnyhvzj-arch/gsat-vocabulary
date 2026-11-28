import { detectEntryBands } from "./entry-bands.js";
import { scoreBlack, consolidateBlack } from "./black-selection.js";
const lexical = /^\s*(?:(\d{1,3})[.、)）:-]?\s*)?([A-Za-z]{2,}(?:[-'][A-Za-z]+)*)(?=\s|[^A-Za-z]|$)/;
const pos = /(?:^|[\s\]）)&.])(?:n|v|vt|vi|a|adj|adv|prep|pron|conj|interj|phr|det|aux|art)\s*\./i;
const header = /^(?:unit|level|lesson|chapter|page)\s*\d*\s*$/i;
const quantile = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)] ?? 0;
const clamp = x => Math.max(0, Math.min(1, x));
const average = (a, b) => (a+b)/2;
const pointBetween = (a, b, fraction) => a.map((value, axis) => value+(b[axis]-value)*fraction);
const distance = (a, b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
const center = polygon => polygon.reduce(([x,y],[a,b])=>[x+a/4,y+b/4],[0,0]);

function orderPolygon(points) {
  if (!Array.isArray(points) || points.length!==4 ||
      points.some(p=>!Array.isArray(p) || p.length!==2 || !p.every(Number.isFinite))) return null;
  // Paddle's horizontal page boxes follow TL, TR, BR, BL. Left/right edge
  // ordering also handles a cyclic start point or reversed winding.
  const [leftTop,leftBottom]=[...points].sort((a,b)=>a[0]-b[0]).slice(0,2).sort((a,b)=>a[1]-b[1]);
  const [rightTop,rightBottom]=[...points].sort((a,b)=>b[0]-a[0]).slice(0,2).sort((a,b)=>a[1]-b[1]);
  const height=average(distance(leftTop,leftBottom),distance(rightTop,rightBottom));
  const width=average(distance(leftTop,rightTop),distance(leftBottom,rightBottom));
  return width>1 && height>1 ? [leftTop,rightTop,rightBottom,leftBottom] : null;
}
function segment(polygon, from, to) {
  const [tl,tr,br,bl]=polygon;
  return [pointBetween(tl,tr,from),pointBetween(tl,tr,to),pointBetween(bl,br,to),pointBetween(bl,br,from)];
}
function advance(text) {
  return [...text].reduce((sum,c)=>sum+(/\p{Script=Han}/u.test(c)?1:/[ilI1'|.,:;]/.test(c)?.27:
    /[mwMW@]/.test(c)?.82:/\s|[[\]()]/.test(c)?.31:/[a-zA-Z0-9]/.test(c)?.53:.52),0);
}

function localInk(polygon, pixels, original) {
  const [tl,tr,br,bl]=polygon;
  const width=Math.min(240,Math.max(8,Math.round(distance(tl,tr)*pixels.width/original.width)));
  const height=Math.min(72,Math.max(8,Math.round(distance(tl,bl)*pixels.height/original.height)));
  const samples=[], lightness=[];
  for(let j=0;j<height;j++){
    const left=pointBetween(tl,bl,(j+.5)/height),right=pointBetween(tr,br,(j+.5)/height);
    for(let i=0;i<width;i++){
      const [x,y]=pointBetween(left,right,(i+.5)/width);
      const xx=Math.floor(x*pixels.width/original.width), yy=Math.floor(y*pixels.height/original.height);
      if(xx<0||yy<0||xx>=pixels.width||yy>=pixels.height){samples.push(null);continue;}
      const offset=(yy*pixels.width+xx)*4;
      const [r,g,b]=[pixels.data[offset],pixels.data[offset+1],pixels.data[offset+2]];
      const l=.26*r+.62*g+.12*b;
      samples.push([r,g,b,l]); lightness.push(l);
    }
  }
  const paper=quantile(lightness.sort((a,b)=>a-b),.82);
  const mask=new Uint8Array(samples.length);
  let ink=0,red=0,dark=0;
  for (let index=0;index<samples.length;index++) {
    const sample=samples[index];
    if(!sample)continue;
    const [r,g,b,l]=sample;
    if(l>paper-22)continue;
    mask[index]=1;ink++;
    if(r-g>=15 && r-b>=9 && r-g>=.12*Math.max(g,b))red++;
    if(l<paper-48 && r-g<24)dark++;
  }
  let run=0,runs=0,rows=0;
  const strokes=[];
  for(let y=0;y<height;y++){
    let occupied=0;
    for(let x=0;x<=width;x++){
      if(x<width && mask[y*width+x]){run++;occupied++;continue;}
      if(run){if(run<=width/4){runs++;strokes.push(run/height);} run=0;}
    }
    if(occupied>=Math.max(2,width*.04))rows++;
  }
  return {redCoverage:red/(lightness.length||1), redInk:red/(ink||1), inkDensity:ink/(lightness.length||1),
    darkInk:dark/(ink||1), stroke:runs?quantile(strokes.sort((a,b)=>a-b),.62):0,
    inkHeight:rows/height};
}

function asLine(item,index,original,pixels) {
  const text=String(item.text??"").normalize("NFKC").trim();
  const polygon=orderPolygon(item.polygon);
  const base={id:index,text,polygon,ocrSource:item.ocrSource??"primary",ocrConfidence:Number.isFinite(item.confidence)?item.confidence:null};
  if(!polygon)return {...base,rejection:"文字框座標無效"};
  const [x,y]=center(polygon);
  const left=average(polygon[0][0],polygon[3][0]);
  const height=average(distance(polygon[0],polygon[3]),distance(polygon[1],polygon[2]));
  const width=average(distance(polygon[0],polygon[1]),distance(polygon[2],polygon[3]));
  const location={...base,x,y,left,height,width};
  const match=lexical.exec(text);
  if(header.test(text))return {...location,rejection:"單元或頁面標題"};
  if(!match || /^\d+$/.test(text))return {...location,rejection:"沒有開頭英文詞形"};
  const lead=match[2], tail=text.slice(match[0].length).trim();
  if(/^\/\s*[a-z][a-z-]+\s*\/\s*[a-z][a-z-]+(?:\s|$)/i.test(tail))
    return {...location,word:lead,rejection:"動詞三態補充行"};
  const phonetics=/^[\[/(]\s*[^\p{Script=Han}]{1,45}/u.test(tail);
  const partOfSpeech=pos.test(tail);
  const hasChinese=/\p{Script=Han}/u.test(tail);
  const afterPhonetic=tail.replace(/^\[[^\]]*\]/,"");
  const supplemental=/補充|同義詞|反義詞|搭配詞|例句/.test(text) ||
    /^\s*(?:synonym|antonym|related|opposite|example)\b/i.test(text);
  const followedByEnglishSentence=/^[a-z]+(?:\s+[a-z]+){2,}/i.test(afterPhonetic.trim()) && !partOfSpeech;
  const followedByChinese=/^\p{Script=Han}/u.test(tail);
  const bare=!tail;
  const entry=phonetics||partOfSpeech||followedByChinese||bare;
  if(!entry)return {...location,word:lead,rejection:"英文句子或補充片語"};
  const prefix=item.gutterNumber?0:advance(match[0].slice(0,match[0].lastIndexOf(lead)));
  // The OCR box is line-level. Estimate only the opening English span by
  // glyph widths, leaving a margin before adjacent phonetics/Chinese ink.
  const advanceTotal=advance(item.gutterNumber?text.slice(match[0].lastIndexOf(lead)):text);
  const from=prefix/advanceTotal;
  const to=Math.min(1,(prefix+advance(lead))/advanceTotal);
  const headPolygon=segment(polygon,from+(to-from)*.06,to-(to-from)*.10);
  const ink=localInk(headPolygon,pixels,original);
  return {...location,word:lead,inlineNumber:match[1]??null,phonetics,partOfSpeech,
    followedByChinese,bare,hasChinese,supplemental,followedByEnglishSentence,headPolygon,...ink};
}

// A Paddle line can span two columns. Split only when a second bracketed
// entry and a wide, near-empty interval agree. The second word still comes
// from OCR text and its ink is scored independently.
function splitBlackColumns(item,original,pixels) {
  const polygon=orderPolygon(item.polygon);
  if(!polygon || distance(polygon[0],polygon[1])<original.width*.62)return null;
  const text=String(item.text).normalize("NFKC").trim();
  if(!lexical.test(text))return null;
  const close=text.indexOf("]");
  const nextBracket=text.indexOf("[",close+1);
  if(close<0 || nextBracket<0)return null;
  const segmentText=text.slice(close+1,nextBracket);
  const head=/([A-Za-z]{2,}(?:[-'][A-Za-z]+)*)\s*$/.exec(segmentText);
  if(!head)return null;
  const [tl,tr,br,bl]=polygon;
  const ink=[];
  for(let i=0;i<160;i++){
    const top=pointBetween(tl,tr,(i+.5)/160),bottom=pointBetween(bl,br,(i+.5)/160);
    let dark=0;
    for(let j=0;j<18;j++){
      const [x,y]=pointBetween(top,bottom,(j+.5)/18);
      const col=Math.floor(x*pixels.width/original.width),row=Math.floor(y*pixels.height/original.height);
      if(col<0||row<0||col>=pixels.width||row>=pixels.height)continue;
      const offset=(row*pixels.width+col)*4;
      if(.26*pixels.data[offset]+.62*pixels.data[offset+1]+.12*pixels.data[offset+2]<125)dark++;
    }
    ink.push(dark);
  }
  let best, start=null;
  for(let i=42;i<=120;i++){
    if(i<120&&ink[i]<=1){start??=i;continue;}
    if(start!==null){
      if(i-start>=5 && (!best||i-start>best[1]-best[0]))best=[start,i];
      start=null;
    }
  }
  const secondStart=close+1+head.index;
  const numbering=/([0-9]{1,2})[a-z.]?\.?(?:\s*)$/i.exec(text.slice(close+1,secondStart));
  const rightText=(numbering ? numbering[1]+". " : "")+text.slice(secondStart);
  if(!best || best[0]<=42 || best[1]>=120){
    if(!/^\s*(?:[a-z]\.?)?\s*\d{0,2}[a-z]?\.?\s*$/i.test(text.slice(close+1,secondStart)))return null;
    return [item,{...item,text:rightText,mergedReview:true}];
  }
  return [
    {...item,text:text.slice(0,numbering?close+1+numbering.index:secondStart).trim(),
      polygon:segment(polygon,0,best[0]/160)},
    // The source OCR box often omitted or merged the second number. Its
    // number is useful structurally but must not shift the ink estimate.
    {...item,text:rightText,polygon:segment(polygon,best[1]/160,1),
      gutterNumber:Boolean(numbering)},
  ];
}

function numberAt(line, all) {
  if(line.inlineNumber)return true;
  return all.some(other=>/^\d{1,3}$/.test(other.text) && other.width &&
    other.x<line.left && line.left-other.x<line.height*2.8 &&
    Math.abs(other.y-line.y)<line.height*.8);
}
const redCue = line => line.redCoverage>=.033 && line.redInk>=.31;
const structural = line => line.phonetics || line.partOfSpeech;
function dominantColumn(lines, width) {
  if(lines.length<3)return null;
  const tolerance=width*.065;
  const clusters=lines.map(line=>({left:line.left,
    neighbors:lines.filter(other=>Math.abs(line.left-other.left)<=tolerance)}))
    .sort((a,b)=>b.neighbors.length-a.neighbors.length);
  const cluster=clusters[0];
  return cluster.neighbors.length>=3 && cluster.neighbors.length>=lines.length*.55
    ? {left:quantile(cluster.neighbors.map(line=>line.left).sort((a,b)=>a-b),.5),tolerance:width*.105} : null;
}

/**
 * OCR polygons and original dimensions refer to the same browser-oriented
 * raster. Pixel data may be an aspect-preserving lower-resolution Canvas.
 * The scores describe selection evidence, and are not OCR probabilities.
 */
export function selectHeadwords(result,pixels,mode="auto") {
  const start=performance.now();
  if(!["auto","red","black"].includes(mode))throw new Error("未知教材模式。");
  const original=result?.original;
  if(!Array.isArray(result?.items) || result.coordinateSpace!=="original-image-pixels" || !original?.width || !original?.height ||
      !pixels?.width || !pixels?.height || pixels.data?.length!==pixels.width*pixels.height*4 ||
      Math.abs(pixels.width*original.height/original.width-pixels.height)>2)
    throw new Error("照片方向或座標尺寸與 OCR 結果不符。");
  let all=result.items.map((item,index)=>asLine(item,index,original,pixels));
  const candidates=all.filter(line=>!line.rejection);
  const body=all.filter(line=>line.width>line.height*3).map(line=>line.height).sort((a,b)=>a-b);
  const bodyHeight=quantile(body,.47)||1;
  const redLines=candidates.filter(line=>redCue(line)&&(structural(line)||numberAt(line,all)));
  const column=dominantColumn(redLines,original.width);
  const strongBlack=candidates.filter(line=>line.height/bodyHeight>=1.24 && !redCue(line) &&
    line.darkInk>=.43 && line.stroke>=.074 && (structural(line)||numberAt(line,all)));
  const redDominant=redLines.length>=2 && redLines.length>=strongBlack.length*1.6;
  const blackDominant=strongBlack.length>=2 && !redLines.length;
  const structuralBlack=!redLines.length&&candidates.filter(line=>line.phonetics&&line.partOfSpeech&&
    line.hasChinese&&!line.supplemental&&line.darkInk>=.27).length>=3;
  const determined=redDominant ? "red" : blackDominant||structuralBlack ? "black" : null;
  const used=mode==="auto"?determined:mode;
  if(used==="black"){
    all=result.items.flatMap((item,index)=>{
      const split=splitBlackColumns(item,original,pixels);
      return split ? split.map((entry,part)=>({
        ...asLine(entry,`${index}:${part}`,original,pixels),sourceText:item.text,mergedReview:entry.mergedReview===true,
      })) : [all[index]];
    });
  }
  const bands=used==="black"?detectEntryBands(pixels,original,all):[];
  let entries=all.map(line=>{
    if(line.rejection)return {...line,status:"excluded",selectionScore:0,reasons:[line.rejection]};
    if(line.mergedReview)return {...line,headPolygon:null,status:"review",selectionScore:.52,
      reasons:["同一 OCR 文字框出現第二個詞條，欄界不明，請核對原圖"]};
    const reasons=line.sourceText&&line.sourceText!==line.text?["偵測到跨欄文字框，依欄間留白拆分"]:[];
    const relativeHeight=line.height/bodyHeight;
    const numbered=numberAt(line,all);
    const entryShape=structural(line);
    const outside=column&&Math.abs(line.left-column.left)>column.tolerance;
    const red=redCue(line);
    const strongRed=red && line.redCoverage>=.045 && line.redInk>=.42;
    const strongInk=line.inkDensity>=.11 && line.darkInk>=.45 && line.stroke>=.064;
    if(numbered)reasons.push("鄰近詞條編號");
    if(entryShape)reasons.push("行首英文後有音標或詞性");
    if(red)reasons.push("英文詞頭區有紅色墨跡");
    if(relativeHeight>=1.20)reasons.push("相對於內文較高");
    if(strongInk)reasons.push("局部墨色密且筆畫較厚");
    let score=0,status="excluded",band=null;
    if(used==="red"){
      score=clamp((red ? .46 : 0)+(strongRed ? .13 : 0)+(entryShape ? .23 : 0)+(numbered ? .13 : 0)+
        (relativeHeight>=.94 ? .09 : 0)-(outside ? .55 : 0));
      if(!outside && strongRed && (entryShape||numbered) && relativeHeight>=.90)status="selected";
      else if(!outside && red && (entryShape||numbered||relativeHeight>=1.18||
        (line.bare&&line.redInk>=.70&&line.redCoverage>=.13&&relativeHeight>=.80)))status="review";
      if(outside)reasons.push("偏離主要紅字欄位");
      if(!red)reasons.push("詞頭區紅色墨跡不足");
    }else if(used==="black"){
      ({status,score,band}=scoreBlack(line,{all,bands,size:relativeHeight,original,numbered,red,reasons}));
    }else{
      score=clamp(((red||strongInk) ? .37 : 0)+((entryShape||numbered) ? .24 : 0));
      if(score>=.61 || (red&&line.bare&&line.redCoverage>=.13)){
        status="review"; score=Math.max(score,.52);
      }
      reasons.push("版式線索不足，請手動指定模式");
    }
    if(status==="selected" && line.ocrConfidence!==null && line.ocrConfidence<.57){
      status="review";reasons.push("OCR 文字可信度偏低，請核對拼字");
    }
    return {...line,relativeHeight,numbered,status,selectionScore:score,reasons,...(band?{band}: {})};
  });
  if(used==="black")entries=consolidateBlack(entries);
  return {requestedMode:mode,mode:used,modeUncertain:used===null,bodyHeight,entries,
    ...(used==="black"?{bands}:{}),
    elapsedMs:performance.now()-start,coordinateSpace:result.coordinateSpace};
}

export async function selectFromPhoto(result,blob,mode) {
  const start=performance.now();
  const url=URL.createObjectURL(blob);
  const picture=new Image(),canvas=document.createElement("canvas");
  try {
    picture.src=url;
    await picture.decode();
    if(picture.naturalWidth!==result.original.width||picture.naturalHeight!==result.original.height)
      throw new Error("照片方向或尺寸和 OCR 結果不一致。");
    const scale=Math.min(1,2048/Math.max(picture.naturalWidth,picture.naturalHeight));
    canvas.width=Math.round(picture.naturalWidth*scale);
    canvas.height=Math.round(picture.naturalHeight*scale);
    const context=canvas.getContext("2d",{willReadFrequently:true,alpha:false});
    context.fillStyle="#fff";
    context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(picture,0,0,canvas.width,canvas.height);
    const output=selectHeadwords(result,context.getImageData(0,0,canvas.width,canvas.height),mode);
    return {...output,analysisRaster:{width:canvas.width,height:canvas.height},elapsedMs:performance.now()-start};
  }finally{
    canvas.width=canvas.height=1;
    URL.revokeObjectURL(url);
  }
}

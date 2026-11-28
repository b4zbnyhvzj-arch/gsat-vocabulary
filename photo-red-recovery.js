// Project red ink in heading-column coordinates. OCR supplies page geometry
// when available, but does not have to see (or label) a word to propose a crop.
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const range=(box,axis)=>box.map(point=>point[axis]);

export function redRecoveryRegions(pixels,original,selection,limit=2) {
  const anchors=selection.entries.filter(row=>row.status==="selected"&&row.redInk>=.42&&row.headPolygon);
  const ordered=anchors.filter(row=>row.headPolygon.length===4).sort((a,b)=>a.y-b.y);
  const sx=pixels.width/original.width,sy=pixels.height/original.height;
  const samples=ordered.map(row=>{
    const [a,b,c,d]=row.headPolygon;
    const left=Math.min(a[0],d[0])*sx;
    return {left,y:(a[1]+d[1])*sy/2,height:(c[1]+d[1]-a[1]-b[1])*sy/2,
      slope:(b[1]-a[1])*sy/Math.max(1,(b[0]-a[0])*sx)};
  });
  const typicalHeight=median(samples.map(row=>row.height));
  const height=clamp(typicalHeight??pixels.height*.022,10,pixels.height*.06);
  const pairs=samples.flatMap((row,i)=>samples.slice(i+1).filter(other=>Math.abs(other.y-row.y)>height*4)
    .map(other=>(other.left-row.left)/(other.y-row.y)));
  const tilt=clamp(median(pairs)??0,-.38,.38);
  const headingLane=median(samples.map(row=>row.left-row.y*tilt))??pixels.width*.20;
  const neighbors=y=>[...samples].sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y)).slice(0,2);
  const slopeAt=y=>clamp(median(neighbors(y).map(row=>row.slope))??0,-.35,.35);
  const bands=[];
  let band=null;
  function close() {
    if(band&&band.bottom-band.top>=height*.21&&band.bottom-band.top<=height*1.65)
      bands.push(band);
    band=null;
  }
  const isRed=(r,g,b)=>r-g>=23&&r-b>=12&&g<169&&r-g>=.16*Math.max(g,b);
  for(let y=0;y<pixels.height;y++){
    const lane=headingLane+tilt*y;
    if(samples.some(row=>Math.abs(row.y-y)<Math.max(row.height,height)*.62)) {
      close();continue;
    }
    const slope=slopeAt(y);
    const start=clamp(Math.floor(lane-height*1.4),0,pixels.width-1);
    const end=clamp(Math.ceil(lane+height*6.5),start,pixels.width);
    let count=0,minX=end,maxX=start;
    for(let x=start;x<end;x++){
      const yy=Math.round(y+(x-lane)*slope);
      if(yy<0||yy>=pixels.height) continue;
      const offset=(yy*pixels.width+x)*4;
      const [r,g,b]=[pixels.data[offset],pixels.data[offset+1],pixels.data[offset+2]];
      if(!isRed(r,g,b)) continue;
      count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);
    }
    if(count>=Math.max(5,height*.27)&&count<(end-start)*.77){
      if(!band) band={top:y,bottom:y,ink:0,minX,maxX};
      band.bottom=y;band.ink+=count;band.minX=Math.min(band.minX,minX);band.maxX=Math.max(band.maxX,maxX);
    } else if(band&&y-band.bottom>height*.23) close();
  }
  close();
  // In a curved page the first heading can have a different baseline from
  // lower OCR anchors. Probe the backdrop to the right of plausible red ink
  // at several local slopes before the first recognized heading.
  const first=samples[0];
  const early=[];
  if(first) {
    const headerFloor=Math.max(0,...selection.entries.filter(row=>row.rejection==="單元或頁面標題"&&
      row.polygon?.length===4&&row.left*sx<first.left+height*8&&row.y*sy<first.y-height*2)
      .map(row=>Math.max(...range(row.polygon,1))*sy+height*1.1));
    for(let y=Math.ceil(Math.max(height*2.2,headerFloor)); y<first.y-height*1.65; y+=Math.max(2,Math.floor(height*.10))) {
      const projected=headingLane+tilt*y;
      for(const offset of [-1.35,0,1.35]) for(const curve of [-.18,0,.18]) {
        const lane=projected+height*offset;
        const slope=clamp(slopeAt(y)+curve,-.38,.38);
        let deep=0,pink=0,paper=0;
        for(let dx=height*.40;dx<height*4.3;dx+=3) for(const dy of [-.29,-.05,.19]) {
          const i=(Math.round(y+dx*slope+dy*height)*pixels.width+Math.round(lane+dx))*4;
          const [r,g,b]=[pixels.data[i],pixels.data[i+1],pixels.data[i+2]];
          if(isRed(r,g,b)&&g<138) deep++;
          if(r-g>=10&&r-b>=4&&g>=100&&g<211) pink++;
        }
        for(let dx=height*4.6;dx<height*13;dx+=4) {
          const at=y+dx*slope;
          const idx=(Math.round(at)*pixels.width+Math.round(lane+dx))*4;
          const above=(Math.round(at-height*1.55)*pixels.width+Math.round(lane+dx))*4;
          const [r,g,b]=[pixels.data[idx],pixels.data[idx+1],pixels.data[idx+2]];
          if(r-g>=10&&r-b>=4&&g>=104&&g<213) pink++;
          if(pixels.data[above+1]>=g+15) paper++;
        }
        if(deep>=3&&paper>=3&&pink>=height*.48) {
          early.push({top:y-height*.56,bottom:y+height*.54,minX:lane-height*.55,maxX:lane+height*5,
            ink:height*(deep*.85+pink*.6+paper*.65),lane,slope,early:true});
        }
      }
    }
    early.sort((a,b)=>b.ink-a.ink);
    if(early.length) bands.unshift(early[0]);
  }
  return bands.flatMap(band=>{
    const y=(band.top+band.bottom)/2;
    const lane=band.lane??headingLane+tilt*y;
    const slope=band.early?clamp(band.slope,-.115,.115):slopeAt(y);
    const inkWidth=band.maxX-band.minX;
    if(inkWidth<height*.55||band.minX>lane+height*1.6||inkWidth>height*6.4) return [];
    const left=clamp(Math.floor(Math.min(lane-height*1.65,band.minX-height*.9)/sx),0,original.width-1);
    const right=clamp(Math.ceil(Math.max(band.maxX+height*11,lane+height*(band.early?30:20))/sx),left+1,original.width);
    const originalSlope=slope*sx/sy;
    const projectionOffset=(left*sx-lane)*slope;
    const rectifiedTop=(band.top+projectionOffset-height*(band.early?.40:.65))/sy;
    const rectifiedBottom=(band.bottom+projectionOffset+height*(band.early?.55:1.45))/sy;
    const skew=(right-left)*originalSlope;
    const top=Math.max(0,Math.floor(rectifiedTop+Math.min(0,skew)));
    const bottom=Math.min(original.height,Math.ceil(rectifiedBottom+Math.max(0,skew)));
    if(bottom-top<3) return [];
    return [{kind:"red-heading",left,right,top,bottom,rectifiedTop,rectifiedBottom,slope:originalSlope,
      seed:{left:band.minX/sx,right:band.maxX/sx,y:(y+projectionOffset)/sy},
      score:band.ink/(height*height),early:band.early===true}];
  }).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export function insideRedSeed(entry,crop) {
  if(!entry.headPolygon||!crop?.seed) return false;
  const x=range(entry.headPolygon,0),y=range(entry.headPolygon,1);
  const left=Math.min(...x),right=Math.max(...x);
  const centerX=(left+right)/2;
  const centerY=(Math.min(...y)+Math.max(...y))/2;
  const bandY=crop.seed.y+(centerX-crop.left)*crop.slope;
  return Math.min(right,crop.seed.right)-Math.max(left,crop.seed.left)>Math.min(right-left,crop.seed.right-crop.seed.left)*.45&&
    Math.abs(centerY-bandY)<Math.max(10,entry.height)*(crop.early?1.65:.8);
}

// Keep the whole row on the first pass. If it is still missed, increase
// sampling around the heading and adjacent POS/leading gloss as a second pass.
export function closerRedCrop(crop,original) {
  const h=(crop.rectifiedBottom-crop.rectifiedTop)/2;
  const left=Math.max(0,Math.floor(crop.seed.left-h*2.5));
  const right=Math.min(original.width,Math.ceil(crop.seed.right+h*9));
  const center=crop.seed.y+(left-crop.left)*crop.slope;
  const slope=crop.slope*.45;
  const rectifiedTop=center-h*1.05;
  const rectifiedBottom=center+h*1.32;
  const top=Math.max(0,Math.floor(rectifiedTop+Math.min(0,(right-left)*slope)));
  const bottom=Math.min(original.height,Math.ceil(rectifiedBottom+Math.max(0,(right-left)*slope)));
  return {...crop,left,right,top,bottom,rectifiedTop,rectifiedBottom,slope,
    seed:{...crop.seed,left:Math.max(0,crop.seed.left-h),y:center},detail:true};
}

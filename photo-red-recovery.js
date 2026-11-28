// Search near the verified red heading column for uncovered, heading-sized
// runs of red pixels. Coordinates are returned in the original image space.
export function redRecoveryRegions(pixels, original, selection, limit=2) {
  const anchors=selection.entries.filter(e=>e.status==="selected"&&e.redInk>=.42&&e.headPolygon);
  if(!anchors.length) return [];
  const sx=pixels.width/original.width, sy=pixels.height/original.height;
  const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const height=Math.max(10,median(anchors.map(e=>e.height*sy)));
  const left=median(anchors.map(e=>Math.min(...e.headPolygon.map(p=>p[0]))*sx));
  const start=Math.max(0,Math.round(left-height*1.6));
  const end=Math.min(pixels.width,Math.round(left+height*7));
  const occupied=anchors.map(e=>[
    Math.min(...e.headPolygon.map(p=>p[1]))*sy-height*.23,
    Math.max(...e.headPolygon.map(p=>p[1]))*sy+height*.23,
  ]);
  const bands=[];
  let startRow=-1,last=-1,ink=0;
  function flush(){
    if(startRow>=0&&last-startRow>=height*.24&&last-startRow<=height*1.8) {
      bands.push({top:startRow,bottom:last,ink});
    }
    startRow=last=-1;ink=0;
  }
  for(let y=0;y<pixels.height;y++){
    let count=0;
    if(!occupied.some(([top,bottom])=>y>=top&&y<=bottom)){
      for(let x=start;x<end;x++){
        const i=(y*pixels.width+x)*4;
        const r=pixels.data[i],g=pixels.data[i+1],b=pixels.data[i+2];
        if(r-g>=21&&r-b>=12&&g<171) count++;
      }
    }
    if(count>=Math.max(6,height*.32)) {
      if(startRow<0) startRow=y;
      last=y;ink+=count;
    } else if(last>=0&&y-last>height*.22) flush();
  }
  flush();
  return bands.sort((a,b)=>b.ink-a.ink).slice(0,limit).map(band=>({
    left:Math.floor(start/sx),right:Math.ceil(Math.min(pixels.width,left+height*21)/sx),
    top:Math.floor(Math.max(0,band.top-height*.5)/sy),
    bottom:Math.ceil(Math.min(pixels.height,band.bottom+height*.7)/sy),
  }));
}

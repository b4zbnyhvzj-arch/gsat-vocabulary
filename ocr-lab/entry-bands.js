// Coordinates returned by this module are in the same, browser-oriented
// original raster as Paddle polygons. Scan a bounded low-resolution grid.
const luminance=(r,g,b)=>.25*r+.63*g+.12*b;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]??0;
const overlaps=(a,b)=> Math.min(a.right,b.right)>Math.max(a.left,b.left) &&
  Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top);

export function detectEntryBands(pixels, original, lines=[]) {
  const {width,height,data}=pixels;
  const nx=112,ny=160;
  const grid=Array.from({length:ny},(_,y)=>Array.from({length:nx},(_,x)=>{
    const samples=[];
    for(const dx of [.24,.75])for(const dy of [.23,.76]){
      const i=(Math.floor((y+dy)*height/ny)*width+Math.floor((x+dx)*width/nx))*4;
      const r=data[i],g=data[i+1],b=data[i+2];
      // Color and dark ink are poor estimates of the paper fill.
      if(Math.max(r,g,b)-Math.min(r,g,b)<37 && luminance(r,g,b)>105)samples.push(luminance(r,g,b));
    }
    return samples.length?Math.max(...samples):NaN;
  }));
  const found=[];
  for(const slope of [-.08,-.04,0,.04,.08]){
    const offset=x=>Math.round(slope*(x-nx/2)*ny/nx);
    const at=(x,y)=>grid[y+offset(x)]?.[x];
    for(let y=7;y<ny-10;y++){
      for(const thick of [2,3,4,5]){
        let start=-1;
        for(let x=4;x<=nx-4;x++){
          const value=at(x,y);
          const contrast=(at(x,y-thick)+at(x,y+thick))/2-value;
          if(x<nx-4 && contrast>=9 && contrast<=78){
            if(start<0)start=x;
            continue;
          }
          if(start<0)continue;
          if(x-start>=Math.ceil(nx*.24)){
            const left=start/nx*original.width,right=x/nx*original.width;
            const top=(y-thick+Math.min(offset(start),offset(x)))/ny*original.height;
            const bottom=(y+thick+Math.max(offset(start),offset(x)))/ny*original.height;
            const grayContrast=median(Array.from({length:x-start},(_,i)=>{
              const column=start+i;
              return (at(column,y-thick)+at(column,y+thick))/2-at(column,y);
            }));
            // Detect repeated boundary marks where present. Short dark
            // segments separated by light ones support a dashed border.
            let transitions=0;
            const boundary = column=>[y-thick+1,y+thick-1].some(row=>!Number.isFinite(at(column,row)));
            for(let i=start+1;i<x;i++)if(boundary(i)!==boundary(i-1))transitions++;
            const dashed=transitions>=Math.max(5,(x-start)*.16);
            const neighbors=lines.filter(line=>line.phonetics&&line.partOfSpeech&&
              Math.abs(line.left-left)<original.width*.13).length;
            found.push({left,right,top,bottom,slope,grayContrast,dashed,neighbors,
              score:(x-start)*(grayContrast+(dashed?4:0))});
          }
          start=-1;
        }
      }
    }
  }
  const chosen=[];
  for(const box of found.sort((a,b)=>b.score-a.score)){
    if(chosen.some(prior=>overlaps(prior,box)))continue;
    chosen.push(box);
    if(chosen.length===12)break;
  }
  return chosen.sort((a,b)=>a.top-b.top);
}

export function bandFor(line, bands) {
  return bands.find(band=>line.y>=band.top && line.y<=band.bottom &&
    line.left>=band.left-(band.right-band.left)*.09 &&
    line.left<=band.left+(band.right-band.left)*.35)??null;
}

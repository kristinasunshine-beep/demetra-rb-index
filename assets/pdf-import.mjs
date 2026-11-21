// Work on the user's device. No document is uploaded to a PDF/OCR server.
const base=new URL('./vendor/pdf-runtime/',import.meta.url);
const url=path=>new URL(path,base).href;
const cancelled=signal=>{if(signal?.aborted)throw new DOMException('Obrada je prekinuta.','AbortError');};
const norm=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const nameHeader=/^(?:latinski naziv(?: biljke)?|naziv biljke|naziv sadnice|botanicki naziv|biljka|species|plant name|botanical name|latin name|naziv za pretragu)$/;
const fieldHeader=/^(?:tip(?: sadnice)?|forma|oblik|visina(?: sadnice)?|obim(?: sadnice| stabla| debla)?|saksija|velicina|parametri|specifikacija|opis|kultivar|sorta|height|girth|circumference|form|quantity|kolicina|jm|jedinica mere|cena|iznos|r br)(?:\s|$)/;
export function layoutRows(items,previous=null){
  const lines=[];
  for(const item of items){
    if(!String(item.str??'').trim())continue;
    const x=item.x??item.transform?.[4],y=item.y??item.transform?.[5],width=item.width||0;
    if(!Number.isFinite(x)||!Number.isFinite(y))continue;
    let line=lines.find(l=>Math.abs(l.y-y)<6);
    if(!line){line={y,items:[]};lines.push(line);}line.items.push({str:item.str.trim(),x,width});
  }
  const rows=[];let columns=previous;
  for(const line of lines.sort((a,b)=>b.y-a.y)){
    const chunks=[];
    for(const item of line.items.sort((a,b)=>a.x-b.x)){
      const last=chunks.at(-1);
      if(last&&item.x-last.end<8){last.str+=' '+item.str;last.end=Math.max(last.end,item.x+item.width);}
      else chunks.push({str:item.str,x:item.x,end:item.x+item.width});
    }
    const headers=chunks.map(c=>norm(c.str));
    if(headers.some(v=>nameHeader.test(v))&&headers.some(v=>fieldHeader.test(v))){
      columns=chunks.map(c=>c.x);
      rows.push(chunks.map(c=>c.str));continue;
    }
    if(columns&&columns.length>1){
      const cells=Array(columns.length).fill('');
      for(const c of chunks){
        let i=0;while(i+1<columns.length&&c.x>=columns[i+1]-8)i++;
        cells[i]=[cells[i],c.str].filter(Boolean).join(' ');
      }
      rows.push(cells);
    }else rows.push(chunks.map(c=>c.str));
  }
  return {rows,columns};
}
export async function extractPdfRows(bytes,{signal,onProgress=()=>{}}={}){
  cancelled(signal);
  const pdfjs=await import(url('pdfjs/pdf.min.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc=url('pdfjs/pdf.worker.min.mjs');
  const loading=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,cMapUrl:url('cmaps/'),cMapPacked:true,standardFontDataUrl:url('standard_fonts/'),wasmUrl:url('wasm/')});
  let ocr=null,doc=null;
  const abort=()=>{void loading.destroy();if(ocr)void ocr.terminate();};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    doc=await loading.promise;const rows=[];let columns=null;
    for(let n=1;n<=doc.numPages;n++){
      cancelled(signal);onProgress('Čitam PDF · strana '+n+' / '+doc.numPages);
      const page=await doc.getPage(n),content=await page.getTextContent();
      let items=content.items.filter(i=>i.str?.trim());
      // A scan may contain only a page number or a short header text layer.
      if(items.map(i=>i.str).join(' ').trim().length<35){
        onProgress('Prepoznajem skeniranu stranu (OCR) · '+n+' / '+doc.numPages);
        if(!globalThis.Tesseract){
          await new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src=url('tesseract/tesseract.min.js');
            script.onload=resolve;script.onerror=()=>reject(new Error('OCR modul nije dostupan.'));document.head.appendChild(script);
          });
        }
        cancelled(signal);
        if(!ocr)ocr=await globalThis.Tesseract.createWorker('eng+srp_latn',1,{workerPath:url('tesseract/worker.min.js'),corePath:url('tesseract-core/'),langPath:url('lang/'),workerBlobURL:false,cacheMethod:'none'});
        cancelled(signal);
        const viewport=page.getViewport({scale:2.5}),canvas=document.createElement('canvas');
        canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
        const recognized=await ocr.recognize(canvas,{}, {text:true,blocks:true});
        const words=(recognized.data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).flatMap(l=>l.words||[])));
        items=words.map(w=>({str:w.text,x:w.bbox.x0/2.5,y:(canvas.height-(w.bbox.y0+w.bbox.y1)/2)/2.5,width:(w.bbox.x1-w.bbox.x0)/2.5}));
        if(!items.length&&recognized.data.text?.trim())for(const line of recognized.data.text.split(/\r?\n/))if(line.trim())rows.push([line.trim()]);
        canvas.width=canvas.height=0;
      }
      const parsed=layoutRows(items,columns);columns=parsed.columns;rows.push(...parsed.rows);page.cleanup();
    }
    cancelled(signal);if(!rows.length)throw new Error('PDF ne sadrži čitljiv tekst.');
    return rows;
  }finally{signal?.removeEventListener('abort',abort);if(ocr)await ocr.terminate().catch(()=>{});await loading.destroy().catch(()=>{});}
}

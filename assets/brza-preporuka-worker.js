'use strict';
importScripts('vendor/xlsx-0.20.3.full.min.js','vendor/jszip-3.10.1.min.js','brza-preporuka-core.js?v=candidates-20261121','recommendation-excel.js?v=plant-links-20261120');
const Core=self.DemetraRecommendCore;
let sheets=[],results=null,originalWorkbook=null;
function send(type,data={}){postMessage({type,...data});}

const OVERVIEW_HEADERS=[
  'Latinski naziv biljke',
  'Parametri iz tvoje tabele',
  'Spisak rasadnika',
  'Najniža nabavna cena (€)',
  'Rezultat',
  'Digitalna kartica'
];
function conciseParameters(request){
  const parsed=Core.parsePreferences([request.preferences,request.sourceDescription].filter(Boolean).join('; '));
  const fields={...parsed.fields,...request};
  const kind=Core.form(fields.seedlingType||'');
  const parts=[];
  if(kind==='standard'||kind==='multistem')parts.push('Tip: '+(kind==='standard'?'Standard':'Multistem'));
  else parts.push('Tip: nije potvrđen');
  // Measurements are legitimate requested parameters even when plant form
  // has not been supplied. Never hide them merely because type is missing.
  for(const [field,label] of [['height','Visina'],['circumference','Obim']])
    if(String(fields[field]??'').trim())parts.push(label+': '+String(fields[field]));
  return parts.join(' · ');
}
function overviewStatus(result,supplier){
  if(result.status==='needs_data')return 'Nedostaju tip sadnice ili odgovarajuća mera · proveriti izvor';
  if(!result.recognized)return result.candidates?.length?'Proveriti botanički naziv':'Biljka nije prepoznata';
  if(supplier?.historical||result.archival||/ARHIVA/i.test(String(supplier?.name||'')))
    return 'Arhivski izvor · proveriti';
  if(result.status==='matched')
    return /arhiv|dostupnost nije|prover/i.test(result.message||'')?
      'Ponuda · proveriti aktuelnost':'Ponuda sa odgovarajućim parametrima';
  return result.suppliers?.length?'Ponude · potrebna provera':'Nema potvrđene ponude';
}
function overviewItems(request,result){
  const plant=request.cultivar&&!Core.norm(request.name).endsWith(' '+Core.norm(request.cultivar))?request.name+' '+request.cultivar:request.name;
  const params=(result.requestedParameters||[]).map(p=>p.label+': '+p.value).join(' · ')||conciseParameters(request);
  // An archival source is not an eligible procurement recommendation.
  const suppliers=result.suppliers?.length?result.suppliers:[null];
  return suppliers.map((supplier,index)=>{
    const sourcePrice=Number.isFinite(supplier?.price)?
      supplier.price.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €':'';
    const nursery=supplier?
      supplier.name:'—';
    return [plant,params,nursery,
      Number.isFinite(supplier?.price)?supplier.price:'',
      (supplier&&result.status!=='matched'?'Potencijalni kandidat · '+(supplier.offeredParameters||'')+(supplier.historical?' · proveriti aktuelnost':''):overviewStatus(result,supplier)),
      result.plantId?'https://kristinasunshine-beep.github.io/demetra-rb-index/#plant='+encodeURIComponent(result.plantId):''];
  });
}

async function readPdfRows(input){
  const pdfjs=await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const doc=await pdfjs.getDocument({data:new Uint8Array(input),isEvalSupported:false}).promise;
  const rows=[];
  for(let n=1;n<=doc.numPages;n++){
    const page=await doc.getPage(n),content=await page.getTextContent(),lines=[];
    for(const item of content.items){if(!item.str?.trim())continue;const y=item.transform[5];let line=lines.find(l=>Math.abs(l.y-y)<3);if(!line){line={y,items:[]};lines.push(line);}line.items.push(item);}
    for(const line of lines.sort((a,b)=>b.y-a.y))rows.push(line.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str));
  }
  return rows;
}
function cellValue(cell){return cell?.v??(cell?.f?'Formula bez sačuvane vrednosti':'');}
function readRows(sheet){
  const dense=sheet['!data'];let maxRow=-1,maxColumn=-1;
  if(dense){dense.forEach((row,r)=>{row?.forEach((cell,c)=>{if(cell?.f||(cell?.v!==undefined&&cell.v!=='')){maxRow=Math.max(maxRow,r);maxColumn=Math.max(maxColumn,c);}});});}
  else{for(const [ref,cell] of Object.entries(sheet)){if(ref.startsWith('!')||(!cell?.f&&(cell?.v===undefined||cell.v==='')))continue;const p=XLSX.utils.decode_cell(ref);maxRow=Math.max(maxRow,p.r);maxColumn=Math.max(maxColumn,p.c);}}
  if(maxRow<0)return {rows:[],columns:0};
  const rows=[];for(let r=0;r<=maxRow;r++){const row=[];if(dense){for(let c=0;c<=maxColumn;c++)if(dense[r]?.[c])row[c]=cellValue(dense[r][c]);}else{for(let c=0;c<=maxColumn;c++){const cell=sheet[XLSX.utils.encode_cell({r,c})];if(cell)row[c]=cellValue(cell);}}rows.push(row);}
  return {rows,columns:maxColumn+1};
}
self.onmessage=async({data})=>{try{
  if(data.type==='process'){
    results=null;originalWorkbook=null;send('progress',{message:'Čitam Excel tabelu…'});
    const input=await data.file.arrayBuffer();
    const index=Core.makeIndex(data.catalog);
    if(/\.pdf$/i.test(data.file.name)){
      const rows=Core.pdfPlantRows(await readPdfRows(input),index);
      if(rows.length<2)throw new Error('PDF nema prepoznatljiv tekst biljaka. Za skenirani dokument potreban je OCR.');
      sheets=[{name:'PDF specifikacija',rows,columns:Math.max(...rows.map(r=>r.length))}];
    }else{
      const book=XLSX.read(input,{type:'array',dense:true,cellDates:true,cellNF:true,bookVBA:false,raw:/\.(csv|tsv)$/i.test(data.file.name)});
      if(/\.xlsx$/i.test(data.file.name))originalWorkbook=input;
      sheets=book.SheetNames.map(name=>({name,...readRows(book.Sheets[name])}));
    }
    let matched=0,unmatched=0,processed=0,recognized=0,archival=0,needsData=0,notFound=0;const preview=[];
    // A cost analysis workbook repeats the same plant in Kalkulacija,
    // Specifikacije, Poređenje and Cene. Only the dedicated specifications
    // sheet is the source of planting requirements when present.
    const specificationSheets=new Set(sheets.filter(sheet=>{
      const hdr=sheet.rows.slice(0,15);
      return hdr.some(row=>row.some(v=>Core.norm(v)==='naziv za pretragu') &&
        row.some(v=>Core.norm(v)==='velicina i posuda'));
    }).map(sheet=>sheet.name));
    const activeSheets=specificationSheets.size?specificationSheets:null;

    results=[];const addedSheets=[],names=new Set(sheets.map(s=>s.name));
    const overviewRows=[OVERVIEW_HEADERS.slice()];
    for(let i=0;i<sheets.length;i++){
      const original=sheets[i],config=Core.detectSheet(original.rows,index,original.name);let sheet={...original,rows:original.rows.map(row=>row.slice()),processed:false};results.push(sheet);
      if(!config?.enabled || activeSheets&&!activeSheets.has(original.name))continue;
      const headers=Array.from({length:original.columns},(_,c)=>config.headers?.[c]||original.rows[config.headerRow]?.[c]||'Kolona '+XLSX.utils.encode_col(c));
      if(config.hasHeader===false){
        let name=('Preporuka '+original.name).slice(0,31),n=2;while(names.has(name))name=('Preporuka '+original.name).slice(0,27)+' '+n++;names.add(name);
        sheet={...original,name,addedSheet:true,rows:[headers, ...original.rows.map(row=>row.slice())],processed:true};addedSheets.push(sheet);
      }
      sheet.processed=true;sheet.headerRow=config.hasHeader===false?0:config.headerRow;sheet.originalColumns=sheet.columns;sheet.columns+=Core.EXTRA_HEADERS.length;
      Core.EXTRA_HEADERS.forEach((v,c)=>{sheet.rows[sheet.headerRow][sheet.originalColumns+c]=v;});
      for(let r=config.dataStartRow??config.headerRow+1;r<original.rows.length;r++){
        if(!original.rows[r]?.some(value=>String(value??'').trim()))continue;
        const request=Core.requestFromRow(original.rows[r],config.map,headers);
        // Skip lawn seed, ancillary works and headings in dedicated botanical
        // specification sheets; the original worksheet remains untouched.
        if(activeSheets){
          const group=String(original.rows[r][2]??'');
          if(/travnjak|radovi|materijal|seme|sjeme|supstrat|đubriv|gnojiv/i.test(group))continue;
          if(!/^[A-Z][a-z]{2,}\s+[a-z][a-z-]{2,}/.test(String(request.name??'').trim()))continue;
        }
        if(original.rows[r].includes('Formula bez sačuvane vrednosti'))request._validationError='Formula u izvornoj tabeli nema sačuvanu vrednost za poređenje.';
        const result=Core.recommendQuick(index,request,{currency:'EUR'}),outRow=config.hasHeader===false?r+1:r;
        result.values.forEach((v,c)=>{sheet.rows[outRow][sheet.originalColumns+c]=v;});
        if(result.status!=='empty')overviewRows.push(...overviewItems(request,result));
        if(result.status!=='empty'){
          processed++;
          if(result.status==='matched')matched++;
          else if(result.status==='needs_data')needsData++;
          else if(result.status==='not_found')notFound++;
          else unmatched++;
          if(result.recognized)recognized++;
          if(result.archival)archival++;
          if(preview.length<40) {
            const parameters=result.requestedParameters||[];
            preview.push({sheet:original.name,row:r+1,
              name:request.cultivar&&!Core.norm(request.name).endsWith(' '+Core.norm(request.cultivar))?request.name+' '+request.cultivar:request.name,
              parameters,...result});
          }
        }
        if(r%200===0){send('progress',{message:`Obrađeno ${processed.toLocaleString('sr-Latn-RS')} stavki…`,processed});await new Promise(resolve=>setTimeout(resolve,0));}
      }
    }
    results.push(...addedSheets);
    if(overviewRows.length>1){
      let overviewName='Pregled preporuke',ordinal=2;
      while(names.has(overviewName))overviewName='Pregled preporuke '+ordinal++;
      results.unshift({name:overviewName,overview:true,addedSheet:true,
        processed:true,headerRow:0,originalColumns:OVERVIEW_HEADERS.length,
        columns:OVERVIEW_HEADERS.length,rows:overviewRows});
    }
    send('results',{matched,unmatched,needsData,notFound,processed,recognized,archival,preview});
  }else if(data.type==='export'){
    if(!results)throw new Error('Prvo pokreni poređenje.');
    send('progress',{message:'Pripremam novu Excel tabelu…'});
    const response=await fetch(data.templateUrl,{cache:'no-store'});if(!response.ok)throw new Error('Excel obrazac trenutno nije dostupan.');
    const bytes=await self.DemetraRecommendationExcel.build(await response.arrayBuffer(),results,JSZip,(sheet,row,total)=>{if(row%2000===0)send('progress',{message:`Pakujem list ${sheet+1}: ${row.toLocaleString('sr-Latn-RS')} / ${total.toLocaleString('sr-Latn-RS')} redova…`});},originalWorkbook);
    postMessage({type:'download',bytes},[bytes]);
  }
}catch(error){results=null;send('error',{message:error.message||'Tabela nije mogla da se obradi.'});}};

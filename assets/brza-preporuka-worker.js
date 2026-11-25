'use strict';
importScripts('vendor/xlsx-0.20.3.full.min.js','vendor/jszip-3.10.1.min.js','brza-preporuka-core.js?v=editable-results-r5-20261125','recommendation-excel.js?v=strict-source-quantity-r1-20261125','moja-ponuda-core.js?v=editable-results-r5-20261125');
const Core=self.DemetraRecommendCore;
let sheets=[],results=null,originalWorkbook=null,recognitionRows=null,entries=[];
function send(type,data={}){postMessage({type,...data});}

const OVERVIEW_HEADERS=[
  'Latinski naziv biljke',
  'Parametri iz tvoje tabele',
  'Spisak rasadnika',
  'Nabavna cena (€)',
  'Rezultat',
  'Digitalna kartica',
  'Količina'
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
  const plant=result.canonicalName||(request.cultivar&&!Core.norm(request.name).endsWith(' '+Core.norm(request.cultivar))?request.name+' '+request.cultivar:request.name);
  const params=(result.requestedParameters||[]).map(p=>p.label+': '+p.value).join(' · ')||conciseParameters(request);
  // An archival source is not an eligible procurement recommendation.
  const suppliers=result.suppliers?.length?result.suppliers:[null];
  return suppliers.map((supplier,index)=>{
    const nursery=supplier?
      supplier.name:'—';
    return [plant,params,nursery,
      Number.isFinite(supplier?.price)?supplier.price:'',
      (supplier?`${supplier.matchCount}/${supplier.requestedCount} · ${supplier.candidate?'Potencijalni kandidat':'Tačno podudaranje'}${supplier.matchedParameters.length?' · Poklopljeno: '+supplier.matchedParameters.join(', '):''}${supplier.offeredParameters?' · Ponuđeno: '+supplier.offeredParameters:''}${supplier.historical?' · Proveriti aktuelnost cene':''}`:overviewStatus(result,supplier)),
      result.plantId?'https://kristinasunshine-beep.github.io/demetra-rb-index/#plant='+encodeURIComponent(result.plantId):'',quantityValue(request.quantity)];
  });
}

// A dedicated initial-recognition sheet: canonical Latin botanical identity
// plus exactly the recorded parameters from digital-card fields. No source
// IDs, quantity, tax, prices or administrative columns are projected here.
function quantityValue(value){const raw=String(value??'').trim();if(!raw)return '';const n=Number(raw.replace(',','.'));return Number.isFinite(n)&&n>0?n:raw;}
function recognitionRow(request,index){
  const entry=Core.recognizeSourceRow(index,request);
  return [entry.latinName,entry.parameters.map(p=>p.label+': '+p.value).join('\n')];
}
async function appendRecognizedSheet(bytes,rows){
  if(!rows?.length)return bytes;
  const zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
  const escape=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'')
    .replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  let book=await zip.file('xl/workbook.xml').async('string');
  let rels=await zip.file('xl/_rels/workbook.xml.rels').async('string');
  let types=await zip.file('[Content_Types].xml').async('string');
  const allSheets=[...book.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"[^>]*\/>/g)];
  const sheetId=Math.max(0,...allSheets.map(m=>Number(m[1])))+1;
  const filenames=Object.keys(zip.files).filter(v=>/^xl\/worksheets\/sheet\d+\.xml$/.test(v));
  const number=Math.max(0,...filenames.map(v=>Number(v.match(/sheet(\d+)\.xml$/)[1])))+1;
  const target='worksheets/sheet'+number+'.xml';
  const file='xl/'+target;
  const existingIds=[...rels.matchAll(/\bId="rId(\d+)"/g)].map(m=>Number(m[1]));
  const rId='rId'+(Math.max(0,...existingIds)+1);
  if(!book.includes('</sheets>')||!rels.includes('</Relationships>')||!types.includes('</Types>'))
    throw new Error('Excel nema očekivanu strukturu za izdvojeni pregled biljaka.');
  const sheetName='Prepoznate biljke';
  book=book.replace('</sheets>','<sheet name="'+sheetName+'" sheetId="'+sheetId+'" r:id="'+rId+'"/></sheets>');
  rels=rels.replace('</Relationships>','<Relationship Id="'+rId+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="'+target+'"/></Relationships>');
  types=types.replace('</Types>','<Override PartName="/'+file+'" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  const rowXml=rows.map((values,r)=>{
    const cells=values.map((value,c)=>'<c r="'+(c?'B':'A')+(r+1)+'" t="inlineStr"><is><t xml:space="preserve">'+escape(value)+'</t></is></c>').join('');
    const lines=Math.max(1,...values.map(v=>String(v??'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/(v===values[0]?29:53))),0)));
    return '<row r="'+(r+1)+'" ht="'+Math.min(405,Math.max(r?27:30,lines*14+8))+'" customHeight="1">'+cells+'</row>';
  }).join('');
  const xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'+
    '<dimension ref="A1:B'+rows.length+'"/>'+
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
    '<sheetFormatPr defaultRowHeight="20"/><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="61" customWidth="1"/></cols>'+
    '<sheetData>'+rowXml+'</sheetData><autoFilter ref="A1:B'+rows.length+'"/>'+
    '<pageMargins left="0.25" right="0.25" top="0.25" bottom="0.3" header="0.1" footer="0.1"/>'+
    '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>';
  zip.file('xl/workbook.xml',book);
  zip.file('xl/_rels/workbook.xml.rels',rels);
  zip.file('[Content_Types].xml',types);
  zip.file(file,xml);
  return zip.generateAsync({type:'arraybuffer',compression:'DEFLATE'});
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
    results=null;entries=[];originalWorkbook=null;recognitionRows=[['Latinski naziv biljke','Prepoznati parametri sadnice']];send('progress',{message:'Čitam Excel tabelu…'});
    const input=data.pdfRows?null:await data.file.arrayBuffer();
    const index=Core.makeIndex(data.catalog);
    if(/\.pdf$/i.test(data.file.name)){
      const rows=Core.pdfPlantRows(data.pdfRows||[],index);
      
      sheets=[{name:'PDF specifikacija',rows,columns:Math.max(...rows.map(r=>r.length))}];
      const known=new Set(rows.slice(1).flatMap(row=>Core.sourceRequests(index,row,{name:0,cultivar:2},rows[0]).map(x=>x.identity)));
      const rawRows=(data.pdfRows||[]).map(row=>Array.isArray(row)?row:[row]);
      const fallback=rawRows.filter(row=>Core.sourceRequests(index,row,{},[]).some(x=>!known.has(x.identity)));
      if(fallback.length)sheets.push({name:'PDF dodatni tekst',rows:fallback,columns:Math.max(...fallback.map(r=>r.length))});
    }else{
      const book=XLSX.read(input,{type:'array',dense:true,cellDates:true,cellNF:true,bookVBA:false,raw:/\.(csv|tsv)$/i.test(data.file.name)});
      if(/\.xlsx$/i.test(data.file.name))originalWorkbook=input;
      sheets=book.SheetNames.map(name=>({name,...readRows(book.Sheets[name])}));
    }
    let matched=0,unmatched=0,processed=0,recognized=0,archival=0,needsData=0,notFound=0;const preview=[];
    // Every worksheet and every row, including hidden sheets and prose cells.
    // An identical explicit source ID may recur in a calculation and specification.
    // Prefer the richer record only when the same source identity is explicit.
    const scan=sheets.map((sheet,i)=>{
      const config=Core.detectSheet(sheet.rows,index,sheet.name);
      const headers=Array.from({length:sheet.columns},(_,c)=>config.headers?.[c]||'');
      const idColumn=headers.findIndex(v=>/^(?:id stavke|sifra stavke|izvorna celija|source id)$/.test(Core.norm(v)));
      return {config,headers,idColumn,requests:sheet.rows.map((row,r)=>Core.sourceRequests(index,row,config.map||{},headers)
        .map(hit=>({...hit,r,i,sourceId:idColumn>=0?String(row[idColumn]??'').trim():'',score:Core.requestedParameters(index,hit.request).length})))};
    });
    const bySource=new Map();
    for(const group of scan)for(const row of group.requests)for(const hit of row){
      if(!hit.sourceId)continue;
      const key=hit.identity+'|'+hit.sourceId+'|'+String(hit.request.quantity??'');
      const previous=bySource.get(key);
      if(!previous||hit.score>previous.score)bySource.set(key,hit);
    }
    for(const group of scan)group.requests=group.requests.map(row=>row.filter(hit=>{
      if(!hit.sourceId)return true;
      return bySource.get(hit.identity+'|'+hit.sourceId+'|'+String(hit.request.quantity??''))===hit;
    }));
    results=[];const addedSheets=[],names=new Set(sheets.map(s=>s.name));
    const overviewRows=[OVERVIEW_HEADERS.slice()];
    for(let i=0;i<sheets.length;i++){
      const original=sheets[i],{config,requests}=scan[i];let sheet={...original,rows:original.rows.map(row=>row.slice()),processed:false};results.push(sheet);
      if(!requests.some(row=>row.length))continue;
      const headers=Array.from({length:original.columns},(_,c)=>config.headers?.[c]||original.rows[config.headerRow]?.[c]||'Kolona '+XLSX.utils.encode_col(c));
      if(config.hasHeader===false){
        let name=('Preporuka '+original.name).slice(0,31),n=2;while(names.has(name))name=('Preporuka '+original.name).slice(0,27)+' '+n++;names.add(name);
        sheet={...original,name,addedSheet:true,rows:[headers, ...original.rows.map(row=>row.slice())],processed:true};addedSheets.push(sheet);
      }
      sheet.processed=true;sheet.headerRow=config.hasHeader===false?0:config.headerRow;sheet.originalColumns=sheet.columns;sheet.columns+=Core.EXTRA_HEADERS.length;
      Core.EXTRA_HEADERS.forEach((v,c)=>{sheet.rows[sheet.headerRow][sheet.originalColumns+c]=v;});
      for(let r=0;r<original.rows.length;r++){
        const rowHits=requests[r]||[];
        for(const [ordinal,hit] of rowHits.entries()){
        const request=hit.request;
        const id=i+':'+r+':'+ordinal;
        if(original.rows[r].includes('Formula bez sačuvane vrednosti'))request._validationError='Formula u izvornoj tabeli nema sačuvanu vrednost za poređenje.';
        const recognition=recognitionRow(request,index);
        recognitionRows.push(recognition);
        const result=Core.recommendQuick(index,request,{currency:'EUR'}),outRow=config.hasHeader===false?r+1:r;
        entries.push({id,recognition,request,result,overview:overviewItems(request,result),sheet,outRow,values:result.values});
        result.values.forEach((v,c)=>{const old=sheet.rows[outRow][sheet.originalColumns+c];sheet.rows[outRow][sheet.originalColumns+c]=old!==undefined&&old!==''&&v!==''?String(old)+'\n'+String(v):old??v;});
        if(result.status!=='empty')overviewRows.push(...overviewItems(request,result));
        if(result.status!=='empty'){
          processed++;
          if(result.status==='matched')matched++;
          else if(result.status==='needs_data')needsData++;
          else if(result.status==='not_found')notFound++;
          else unmatched++;
          if(result.recognized)recognized++;
          if(result.archival)archival++;
          {
            const parameters=result.requestedParameters||[];
            preview.push({id,quantity:quantityValue(request.quantity),sheet:original.name,row:r+1,
              name:request.cultivar&&!Core.norm(request.name).endsWith(' '+Core.norm(request.cultivar))?request.name+' '+request.cultivar:request.name,
              parameters,...result});
          }
        }
        }
        if(r%200===0){send('progress',{message:`Obrađeno ${processed.toLocaleString('sr-Latn-RS')} stavki…`,processed});await new Promise(resolve=>setTimeout(resolve,0));}
      }
    }
    results.push(...addedSheets);
    if(!processed)send('progress',{message:'Nije pronađen nijedan potvrđen botanički naziv u dokumentu.'});
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
    const excluded=new Set(data.excludedIds||[]),excludedOffers=new Set(data.excludedOffers||[]);
    const selected=entries.filter(entry=>!excluded.has(entry.id)).flatMap(entry=>{
      const original=entry.result.suppliers||[],suppliers=original.filter(s=>!excludedOffers.has(JSON.stringify([entry.id,s.offerIds[0]])));
      if(original.length&&!suppliers.length)return [];
      if(suppliers.length===original.length)return [entry];
      const confirmed=suppliers.find(s=>!s.candidate);
      const summary=suppliers.map(s=>s.name+' — '+s.price.toFixed(2)+' € · '+s.matchCount+'/'+s.requestedCount+' parametara; '+s.offeredParameters).join('\n');
      const message=confirmed?'Potpuno podudaranje među zadržanim ponudama.':'Zadržane ponude sa delimičnim podudaranjem.';
      const result={...entry.result,suppliers,status:confirmed?'matched':'unmatched',message,values:[summary,confirmed?.name||'',confirmed?.price??'',confirmed?.offeredParameters||'',confirmed?.sourceDate||'',message]};
      return [{...entry,result,overview:overviewItems(entry.request,result),values:result.values}];
    });
    if(!selected.length)throw new Error('Nema stavki za izvoz.');
    const selectedRecognition=[recognitionRows[0],...selected.map(entry=>entry.recognition)];
    const selectedOverview=selected.flatMap(entry=>entry.overview);
    send('progress',{message:'Pripremam novu Excel tabelu…'});
    const response=await fetch(data.templateUrl,{cache:'no-store'});if(!response.ok)throw new Error('Excel obrazac trenutno nije dostupan.');
    if(data.sharedTemplateUrl){
      const shared=await fetch(data.sharedTemplateUrl,{cache:'no-store'});if(!shared.ok)throw new Error('Zajednički Excel obrazac trenutno nije dostupan.');
      const overview=results.find(sheet=>sheet.overview);
      if(!overview)throw new Error('Nema stavki za izvoz.');
      const tableRows=selected.flatMap(entry=>{
        const rows=entry.overview;
        return rows.map((row,i)=>[...row,entry.result.suppliers?.[i]?.offeredParameters||'',entry.result.suppliers?.[i]?entry.result.suppliers[i].matchCount+'/'+entry.result.suppliers[i].requestedCount:'—']);
      });
      const output=await self.DemetraQuoteCore.buildXlsx(await shared.arrayBuffer(),null,JSZip,tableRows);
      const bytes=await appendRecognizedSheet(output,selectedRecognition);
      postMessage({type:'download',bytes},[bytes]);return;
    }
    const exportSheets=results.map(sheet=>({...sheet,rows:sheet.rows.map(row=>row.slice())}));
    for(const [i,sheet] of results.entries()){
      const copy=exportSheets[i];
      if(sheet.overview){copy.rows=[OVERVIEW_HEADERS.slice(),...selectedOverview];continue;}
      if(!sheet.processed)continue;
      for(const entry of entries.filter(e=>e.sheet===sheet))for(let c=0;c<Core.EXTRA_HEADERS.length;c++)copy.rows[entry.outRow][sheet.originalColumns+c]='';
      for(const entry of selected.filter(e=>e.sheet===sheet))entry.values.forEach((v,c)=>{const at=sheet.originalColumns+c,old=copy.rows[entry.outRow][at];copy.rows[entry.outRow][at]=old&&v?String(old)+'\n'+String(v):old||v;});
    }
    const bytes=await self.DemetraRecommendationExcel.build(await response.arrayBuffer(),exportSheets,JSZip,(sheet,row,total)=>{if(row%2000===0)send('progress',{message:`Pakujem list ${sheet+1}: ${row.toLocaleString('sr-Latn-RS')} / ${total.toLocaleString('sr-Latn-RS')} redova…`});},originalWorkbook);
    const withRecognition=await appendRecognizedSheet(bytes,selectedRecognition);
    postMessage({type:'download',bytes:withRecognition},[withRecognition]);
  }
}catch(error){if(data.type==='process')results=null;send('error',{message:error.message||'Tabela nije mogla da se obradi.'});}};

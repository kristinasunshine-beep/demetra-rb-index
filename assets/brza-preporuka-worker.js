'use strict';
importScripts('vendor/xlsx-0.20.3.full.min.js','vendor/jszip-3.10.1.min.js','brza-preporuka-core.js?v=eur-20261113','recommendation-excel.js?v=eur-20261113');
const Core=self.DemetraRecommendCore;
let sheets=[],results=null,originalWorkbook=null;
function send(type,data={}){postMessage({type,...data});}
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
    const book=XLSX.read(input,{type:'array',dense:true,cellDates:true,cellNF:true,bookVBA:false,raw:/\.(csv|tsv)$/i.test(data.file.name)});
    if(/\.xlsx$/i.test(data.file.name))originalWorkbook=input;
    sheets=book.SheetNames.map(name=>({name,...readRows(book.Sheets[name])}));
    const index=Core.makeIndex(data.catalog);let matched=0,unmatched=0,processed=0;const preview=[];
    results=[];const addedSheets=[],names=new Set(sheets.map(s=>s.name));
    for(let i=0;i<sheets.length;i++){
      const original=sheets[i],config=Core.detectSheet(original.rows,index,original.name);let sheet={...original,rows:original.rows.map(row=>row.slice()),processed:false};results.push(sheet);
      if(!config?.enabled)continue;
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
        if(original.rows[r].includes('Formula bez sačuvane vrednosti'))request._validationError='Formula u izvornoj tabeli nema sačuvanu vrednost za poređenje.';
        const result=Core.recommend(index,request,{currency:'EUR'}),outRow=config.hasHeader===false?r+1:r;
        result.values.forEach((v,c)=>{sheet.rows[outRow][sheet.originalColumns+c]=v;});
        if(result.status!=='empty'){
          processed++;if(result.status==='matched')matched++;else unmatched++;
          if(preview.length<40)preview.push({sheet:original.name,row:r+1,name:[request.name,request.cultivar].filter(Boolean).join(' '),parameters:original.rows[r].flatMap((value,c)=>c!==config.map.name&&String(value??'').trim()?[{label:headers[c],value:value instanceof Date?value.toISOString().slice(0,10):String(value)}]:[]),...result});
        }
        if(r%200===0){send('progress',{message:`Obrađeno ${processed.toLocaleString('sr-Latn-RS')} stavki…`,processed});await new Promise(resolve=>setTimeout(resolve,0));}
      }
    }
    results.push(...addedSheets);
    send('results',{matched,unmatched,processed,preview});
  }else if(data.type==='export'){
    if(!results)throw new Error('Prvo pokreni poređenje.');
    send('progress',{message:'Pripremam novu Excel tabelu…'});
    const response=await fetch(data.templateUrl,{cache:'no-store'});if(!response.ok)throw new Error('Excel obrazac trenutno nije dostupan.');
    const bytes=await self.DemetraRecommendationExcel.build(await response.arrayBuffer(),results,JSZip,(sheet,row,total)=>{if(row%2000===0)send('progress',{message:`Pakujem list ${sheet+1}: ${row.toLocaleString('sr-Latn-RS')} / ${total.toLocaleString('sr-Latn-RS')} redova…`});},originalWorkbook);
    postMessage({type:'download',bytes},[bytes]);
  }
}catch(error){results=null;send('error',{message:error.message||'Tabela nije mogla da se obradi.'});}};

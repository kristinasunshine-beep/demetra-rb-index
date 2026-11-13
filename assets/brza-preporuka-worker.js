'use strict';
importScripts('vendor/xlsx-0.20.3.full.min.js','vendor/jszip-3.10.1.min.js','brza-preporuka-core.js','recommendation-excel.js');
const Core=self.DemetraRecommendCore;
let sheets=[],results=null,originalWorkbook=null;
function send(type,data={}){postMessage({type,...data});}
function cellValue(cell){return cell?.v??'';}
function readRows(sheet){
  const dense=sheet['!data'];let maxRow=-1,maxColumn=-1;
  if(dense){dense.forEach((row,r)=>{row?.forEach((cell,c)=>{if(cell?.f||(cell?.v!==undefined&&cell.v!=='')){maxRow=Math.max(maxRow,r);maxColumn=Math.max(maxColumn,c);}});});}
  else{for(const [ref,cell] of Object.entries(sheet)){if(ref.startsWith('!')||(!cell?.f&&(cell?.v===undefined||cell.v==='')))continue;const p=XLSX.utils.decode_cell(ref);maxRow=Math.max(maxRow,p.r);maxColumn=Math.max(maxColumn,p.c);}}
  if(maxRow<0)return {rows:[],columns:0};
  const rows=[];for(let r=0;r<=maxRow;r++){const row=[];if(dense){for(let c=0;c<=maxColumn;c++)if(dense[r]?.[c])row[c]=cellValue(dense[r][c]);}else{for(let c=0;c<=maxColumn;c++){const cell=sheet[XLSX.utils.encode_cell({r,c})];if(cell)row[c]=cellValue(cell);}}rows.push(row);}
  return {rows,columns:maxColumn+1};
}
function describe(sheet,index,row){const guess=Core.detectHeader(sheet.rows),headerRow=row??guess.row;return {index,name:sheet.name,rowCount:sheet.rows.length,columns:sheet.columns,headerRow,map:row===undefined?guess.map:Core.detectHeader([sheet.rows[headerRow]||[]]).map,
  headers:Array.from({length:sheet.columns},(_,c)=>String(sheet.rows[headerRow]?.[c]||XLSX.utils.encode_col(c)).slice(0,180)),sample:sheet.rows.slice(headerRow+1,headerRow+4).map(row=>row.map(v=>v instanceof Date?v.toISOString().slice(0,10):v))};}
self.onmessage=async({data})=>{try{
  if(data.type==='read'){
    results=null;originalWorkbook=null;send('progress',{message:'Čitam Excel tabelu…'});
    const input=await data.file.arrayBuffer();
    const book=XLSX.read(input,{type:'array',dense:true,cellDates:true,cellNF:true,bookVBA:false,raw:/\.(csv|tsv)$/i.test(data.file.name)});
    if(/\.xlsx$/i.test(data.file.name))originalWorkbook=input;
    sheets=book.SheetNames.map(name=>({name,...readRows(book.Sheets[name])}));
    send('loaded',{sheets:sheets.map((s,i)=>describe(s,i))});
  }else if(data.type==='header')send('header',{sheet:describe(sheets[data.index],data.index,data.row)});
  else if(data.type==='run'){
    const index=Core.makeIndex(data.catalog);let matched=0,unmatched=0,processed=0;const preview=[];
    results=[];
    for(let i=0;i<sheets.length;i++){
      const original=sheets[i],config=data.configs[i],sheet={...original,rows:original.rows.map(row=>row.slice()),processed:false};results.push(sheet);
      if(!config?.enabled)continue;
      if(!Number.isInteger(config.map.name)||config.map.name<0)throw new Error('Poveži kolonu sa nazivom biljke za list „'+original.name+'“.');
      sheet.processed=true;sheet.headerRow=config.headerRow;sheet.originalColumns=sheet.columns;sheet.columns+=Core.EXTRA_HEADERS.length;
      if(!sheet.rows[sheet.headerRow])throw new Error('Red zaglavlja ne postoji u listu „'+sheet.name+'“.');
      Core.EXTRA_HEADERS.forEach((v,c)=>{sheet.rows[sheet.headerRow][sheet.originalColumns+c]=v;});
      for(let r=sheet.headerRow+1;r<sheet.rows.length;r++){
        const request=Core.requestFromRow(original.rows[r],config.map,original.rows[config.headerRow]||[]),result=Core.recommend(index,request,{currency:data.currency});
        result.values.forEach((v,c)=>{sheet.rows[r][sheet.originalColumns+c]=v;});
        if(result.status!=='empty'){processed++;if(result.status==='matched')matched++;else unmatched++;if(preview.length<40)preview.push({sheet:sheet.name,row:r+1,name:String(request.name),...result});}
        if(r%200===0){send('progress',{message:`Obrađeno ${processed.toLocaleString('sr-Latn-RS')} stavki…`,processed});await new Promise(resolve=>setTimeout(resolve,0));}
      }
    }
    send('results',{matched,unmatched,processed,preview});
  }else if(data.type==='export'){
    if(!results)throw new Error('Prvo pokreni poređenje.');
    send('progress',{message:'Pripremam novu Excel tabelu…'});
    const response=await fetch(data.templateUrl,{cache:'no-store'});if(!response.ok)throw new Error('Excel obrazac trenutno nije dostupan.');
    const bytes=await self.DemetraRecommendationExcel.build(await response.arrayBuffer(),results,JSZip,(sheet,row,total)=>{if(row%2000===0)send('progress',{message:`Pakujem list ${sheet+1}: ${row.toLocaleString('sr-Latn-RS')} / ${total.toLocaleString('sr-Latn-RS')} redova…`});},originalWorkbook);
    postMessage({type:'download',bytes},[bytes]);
  }
}catch(error){results=null;send('error',{message:error.message||'Tabela nije mogla da se obradi.'});}};

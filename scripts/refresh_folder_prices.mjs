#!/usr/bin/env node
// Reads the private offer folder. Original files are never written or published.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {getSourcePrice,normalizeOfferCurrency,loadExchangeRates} from './currency-normalization.mjs';
const require=createRequire(import.meta.url),scriptRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const XLSX=require(scriptRoot+'/assets/vendor/xlsx-0.20.3.full.min.js');
const digest=v=>createHash('sha256').update(v).digest('hex');
const key=v=>String(v||'').replace(/\\/g,'/').normalize('NFC').toLowerCase();
const formats=new Set(['.xlsx','.xls','.xlsm','.xlsb','.ods','.csv','.tsv']);
export function amount(value){if(typeof value==='number')return Number.isFinite(value)&&value>0?value:null;let s=String(value??'').trim().replace(/(?:EUR|RSD|€|din\.?)/gi,'').replace(/[\s\u00a0]/g,'');if(/^\d{1,3}(\.\d{3})+,\d+$/.test(s))s=s.replaceAll('.','').replace(',','.');else if(/^\d{1,3}(,\d{3})+\.\d+$/.test(s))s=s.replaceAll(',','');else s=s.replace(',','.');return /^\d+(?:\.\d{1,4})?$/.test(s)&&Number(s)>0?Number(s):null;}
// Currency written inside a price cell is part of its meaning even when the
// spreadsheet number format remains General. Never carry a new RSD amount into EUR.
function priceCurrency(values,fallback=''){
  const found=new Set();
  for(const value of values){
    const text=String(value??'');
    if(/\bEUR\b|€/i.test(text))found.add('EUR');
    if(/\bRSD\b|\bdin(?:ara)?\b|дин(?:ара)?/i.test(text))found.add('RSD');
    for(const code of ['USD','GBP','CHF','BAM','HRK','HUF','PLN'])if(new RegExp('\\b'+code+'\\b','i').test(text))found.add(code);
  }
  if(found.size>1){const error=new Error('Nejednoznačna valuta: ćelija, format i zaglavlje cene nisu usklađeni.');error.code='SOURCE_CURRENCY_CONFLICT';throw error;}
  return found.size?[...found][0]:String(fallback||'').toUpperCase();
}
function sourceCellCurrency(sheet,ref,firstRow,fallback){
  const column=XLSX.utils.decode_cell(ref).c,cell=sheet[ref],values=[cell?.v,cell?.z];
  for(let r=0;r<Math.min(firstRow,20);r++)values.push(sheet[XLSX.utils.encode_cell({r,c:column})]?.v);
  return priceCurrency(values,fallback);
}
function locate(offer){const s=offer.sourceEvidence||{},p=offer.priceEvidence||{};const file=s.archivePath||s.sourcePath||p.file||p.sourceFile||s.sourceFile||'';const cell=p.priceCell||s.priceCell||'';return {file:file.replace(/^Rasadnici ponude[\\/]/i,''),sheet:p.sheet||s.sheet||'',cell:/^[A-Z]+[1-9]\d*$/.test(cell)?cell:'',sha:s.sourceSha256||p.sourceSha256||p.sha256||''};}
function cellSignature(cell){return cell?{value:cell.f?'='+cell.f:cell.v instanceof Date?cell.v.toISOString():cell.v??'',type:cell.t||''}:null;}
function withoutCurrency(value){return String(value??'').replace(/\b(?:EUR|RSD|din(?:ara)?)\b|дин(?:ара)?|€/gi,'').replace(/\s+/g,' ').trim();}
function rowSignature(sheet,row,priceColumn){const entries=[];for(const [ref,cell] of Object.entries(sheet)){if(ref[0]==='!')continue;const p=XLSX.utils.decode_cell(ref);if(p.r===row&&p.c!==priceColumn&&cell.v!==undefined)entries.push([p.c,cellSignature(cell)]);}entries.sort((a,b)=>a[0]-b[0]);return digest(JSON.stringify(entries));}
function headerSignature(sheet,firstRow,currencyInvariant=false){const entries=[];for(const [ref,cell] of Object.entries(sheet)){if(ref[0]==='!')continue;const p=XLSX.utils.decode_cell(ref);if(p.r<Math.min(firstRow,20)&&cell.v!==undefined){const signature=cellSignature(cell);if(currencyInvariant&&typeof signature.value==='string')signature.value=withoutCurrency(signature.value);entries.push([ref,signature]);}}entries.sort((a,b)=>a[0].localeCompare(b[0]));return digest(JSON.stringify(entries));}
async function walk(root){const files=[];async function visit(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink()||entry.name.startsWith('~$'))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())await visit(full);else if(entry.isFile()&&entry.name.toLowerCase()!=='thumbs.db')files.push(full);}}await visit(root);return files;}
async function jsonOr(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function writeJson(file,value){
  const text=JSON.stringify(value,null,2)+'\n';JSON.parse(text);
  // The caller stages data locally before publication. Flush the complete file;
  // replacing an existing file by rename is not supported in some Windows hosts.
  const previous=await fs.readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  try{const handle=await fs.open(file,'w');try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}}
  catch(error){if(previous)await fs.writeFile(file,previous);throw error;}
}
export async function refreshFolder({source,repo=scriptRoot,stateFile,reportFile,apply=false,now=new Date().toISOString()}){
  if(!source||!stateFile||!reportFile)throw new Error('Potrebni su izvorni folder, lokalna evidencija i izveštaj.');
  const document=JSON.parse(await fs.readFile(path.join(repo,'data/kataloske-stavke.json'),'utf8'));
  if(document.sourcePolicy?.nonPhoto!=='rasadnici-ponude-zip')throw new Error('Nepodržano pravilo izvora.');
  const rates=await loadExchangeRates(repo);
  const state=await jsonOr(stateFile,{version:1,rows:{},knownFiles:{}}),next=structuredClone(document);
  const report={startedAt:now,sourceReadable:false,files:0,verified:0,updated:0,pending:[],newFiles:[],changedFiles:[],unmappedFiles:[],changes:[]};
  let files;
  try{files=await walk(source);report.sourceReadable=true;report.files=files.length;}catch(error){report.error='Poslovni folder nije dostupan.';await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');throw new Error(report.error);}
  const indexed=new Map(files.map(f=>[key(path.relative(source,f)),f]));
  const books=new Map(),content=new Map(),used=new Set();
  async function load(file){if(content.has(file))return content.get(file);const bytes=await fs.readFile(file),item={bytes,sha:digest(bytes),relative:path.relative(source,file)};content.set(file,item);return item;}
  async function workbook(file,item){if(!books.has(file))books.set(file,XLSX.read(item.bytes,{type:'buffer',cellDates:true,cellNF:true,bookVBA:false}));return books.get(file);}
  const active=next.offers.filter(o=>!['needs_review','superseded'].includes(o.recordStatus)&&(Number.isFinite(o.price)||Number.isFinite(getSourcePrice(o).amount)));
  const firstRows=new Map();for(const o of active){const l=locate(o);if(l.cell){const k=key(l.file)+'|'+l.sheet,r=XLSX.utils.decode_cell(l.cell).r;firstRows.set(k,Math.min(firstRows.get(k)??r,r));}}
  function pending(offer,reason,file){offer.priceRefresh={...(offer.priceRefresh||{}),status:'pending',attemptedAt:now,reason};report.pending.push({offerId:offer.id,sourceFile:file,reason});}
  for(const offer of active){
    const original=getSourcePrice(offer),beforePrice=offer.price,beforeCurrency=offer.currency;
    const location=locate(offer),full=indexed.get(key(location.file));
    if(!full){pending(offer,'Izvorni prilog nije pronađen u poslovnom folderu.',location.file);continue;}
    used.add(key(location.file));let item;
    try{item=await load(full);}catch{pending(offer,'Izvorni prilog nije mogao da se pročita.',location.file);continue;}
    const expected=offer.priceRefresh?.sourceSha256||location.sha,unchanged=item.sha===expected;
    let rowRecord=null,newAmount=null,newCurrency=original.currency,sourceCurrencyEvidence=original.evidence,priceCell=location.cell;
    const old=state.rows[offer.id];
    if(formats.has(path.extname(full).toLowerCase())&&location.cell&&location.sheet){
      try{
        const book=await workbook(full,item),sheet=book.Sheets[location.sheet];
        if(!sheet)throw new Error('Nedostaje izvorni radni list.');
        const pos=XLSX.utils.decode_cell(location.cell),first=firstRows.get(key(location.file)+'|'+location.sheet)??pos.r;
        const header=headerSignature(sheet,first),headerCurrencyInvariant=headerSignature(sheet,first,true);
        let row=pos.r;
        if(!unchanged){
          if(!old||old.file!==key(location.file)||old.sheet!==location.sheet||(old.header!==header&&old.headerCurrencyInvariant!==headerCurrencyInvariant))throw new Error('Promenjena struktura ili nema potvrđenog prethodnog reda.');
          if(rowSignature(sheet,row,pos.c)!==old.rowSignature){
            const candidates=new Set(Object.keys(sheet).filter(ref=>ref[0]!=='!').map(ref=>XLSX.utils.decode_cell(ref).r));
            const matches=[...candidates].filter(r=>r>=first&&rowSignature(sheet,r,pos.c)===old.rowSignature);
            if(matches.length!==1)throw new Error('Promenjen naziv, mera, uslov ili nejednoznačan izvorni red.');
            row=matches[0];
          }
          priceCell=XLSX.utils.encode_cell({r:row,c:pos.c});
          if(withoutCurrency(sheet[priceCell]?.z)!==withoutCurrency(old.priceFormat))throw new Error('Promenjen format obračuna cene.');
          if(String(sheet[priceCell]?.f||'')!==old.priceFormula)throw new Error('Promenjen obračun cene.');
          // Explicit currency may change without changing the plant or price
          // basis. Conflicting cell/header currencies still fail closed.
          sourceCellCurrency(sheet,priceCell,first,original.currency||old.priceCurrency||'');
        }
        newAmount=amount(sheet[priceCell]?.v);
        const statedCurrency=sourceCellCurrency(sheet,priceCell,first,'');
        newCurrency=statedCurrency||original.currency;
        if(statedCurrency)sourceCurrencyEvidence={origin:'original_price_cell_format_or_header',currency:statedCurrency,sourceSha256:item.sha,sheet:location.sheet,priceCell};
        rowRecord={file:key(location.file),sheet:location.sheet,cell:priceCell,rowSignature:rowSignature(sheet,row,pos.c),header,headerCurrencyInvariant,
          priceFormat:String(sheet[priceCell]?.z||''),priceFormula:String(sheet[priceCell]?.f||''),priceCurrency:newCurrency,sourceSha256:item.sha};
        // A source cell that never held the archived unit price is not a safe price anchor.
        if(unchanged&&newAmount!==original.amount)rowRecord=null;
        if(!unchanged&&(!newAmount||!rowRecord))throw new Error('Jedinična cena nije potvrđen pozitivan broj.');
      }catch(error){if(!unchanged||error.code==='SOURCE_CURRENCY_CONFLICT'){pending(offer,error.message,location.file);continue;}rowRecord=null;}
    }else if(!unchanged){pending(offer,'Izmenjen PDF, slika ili prilog bez potvrđene ćelije: potrebna je provera sadržaja.',location.file);continue;}
    const sourceChanged=!unchanged&&(newAmount!==original.amount||newCurrency!==original.currency);
    if(sourceChanged){
      const before=original.amount;
      offer.priceRefresh={...(offer.priceRefresh||{}),originalAmount:offer.priceRefresh?.originalAmount??before,changedAt:now,previousAmount:before};
      offer.priceEvidence={...(offer.priceEvidence||{}),amount:newAmount,currency:newCurrency,folderUpdate:{method:'unchanged-identity-row-and-header',sourceSha256:item.sha,sheet:location.sheet,priceCell,rowSignature:rowRecord.rowSignature,headerSignature:rowRecord.header,checkedAt:now,previousAmount:before,currency:newCurrency}};
    }
    normalizeOfferCurrency(offer,rates,{sourceAmount:rowRecord?newAmount:original.amount,sourceCurrency:rowRecord?newCurrency:original.currency,sourceEvidence:rowRecord?sourceCurrencyEvidence:original.evidence,now});
    if(offer.priceConversion?.status==='unresolved'||!Number.isFinite(offer.price)){pending(offer,'Valuta izvorne cene nije potvrđena za preračunavanje u evre.',location.file);continue;}
    if(sourceChanged){report.updated++;report.changes.push({offerId:offer.id,before:beforePrice,after:offer.price,currency:offer.currency,previousCurrency:beforeCurrency,sourceBefore:original.amount,sourceAfter:newAmount,sourceCurrency:newCurrency,sourceFile:location.file,cell:priceCell});}
    offer.priceRefresh={...(offer.priceRefresh||{}),status:'verified',checkedAt:now,sourceSha256:item.sha};
    delete offer.priceRefresh.reason;delete offer.priceRefresh.attemptedAt;
    if(rowRecord)state.rows[offer.id]=rowRecord;
    report.verified++;
  }
  const nextInventory={};
  for(const file of files){const rel=key(path.relative(source,file)),ext=path.extname(file).toLowerCase();if(!formats.has(ext)&&!['.pdf','.jpg','.jpeg','.png'].includes(ext))continue;const item=await load(file);nextInventory[rel]=item.sha;if(!used.has(rel))report.unmappedFiles.push(item.relative);if(state.initializedAt&&!state.knownFiles[rel])report.newFiles.push(item.relative);else if(typeof state.knownFiles[rel]==='string'&&state.knownFiles[rel]!==item.sha)report.changedFiles.push(item.relative);}
  report.anchoredRows=Object.keys(state.rows).length;
  const publicStatus={checkedAt:now,sourceReadable:true,verifiedPrices:report.verified,updatedPrices:report.updated,pendingPrices:report.pending.length,newSourceFiles:report.newFiles.length,changedSourceFiles:report.changedFiles.length,source:'Poslovni folder Rasadnici ponude'};
  if(apply){
    next.updatedAt=now;
    await writeJson(path.join(repo,'data/kataloske-stavke.json'),next);
    await writeJson(path.join(repo,'data/price-sync-status.json'),publicStatus);
    state.knownFiles=nextInventory;state.initializedAt??=now;
    await fs.mkdir(path.dirname(stateFile),{recursive:true});await writeJson(stateFile,state);
  }
  await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
  return {report,document:next,publicStatus};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
  try{const {report}=await refreshFolder({source:value('--source')||process.env.DEMETRA_SOURCE_FOLDER,repo:value('--repo')||scriptRoot,stateFile:value('--state'),reportFile:value('--report'),apply:args.includes('--apply')});console.log(JSON.stringify({sourceReadable:report.sourceReadable,files:report.files,verified:report.verified,updated:report.updated,pending:report.pending.length,newFiles:report.newFiles.length,anchoredRows:report.anchoredRows,applied:args.includes('--apply')},null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

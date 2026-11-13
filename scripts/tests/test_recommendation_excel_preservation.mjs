import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const Excel=require(root+'/assets/recommendation-excel.js'),Zip=require(root+'/assets/vendor/jszip-3.10.1.min.js'),XLSX=require(root+'/assets/vendor/xlsx-0.20.3.full.min.js');
const template=await readFile(root+'/assets/brza-preporuka-template.xlsx');
const original=await readFile(root+'/assets/moja-ponuda-template.xlsx');
const before=await Zip.loadAsync(original),book=XLSX.read(original,{type:'buffer',cellDates:true,cellStyles:true});
const source=book.Sheets[book.SheetNames[0]],rows=XLSX.utils.sheet_to_json(source,{header:1,defval:''});
const originalColumns=XLSX.utils.decode_range(source['!ref']).e.c+1;
const sheets=book.SheetNames.map((name,index)=>({name,rows:index?XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:''}):rows.map(row=>row.slice()),processed:index===0,headerRow:0,originalColumns,columns:originalColumns+3}));
sheets[0].rows[0][originalColumns]='Rasadnik';sheets[0].rows[0][originalColumns+1]='Nabavna cena';sheets[0].rows[0][originalColumns+2]='Valuta';
sheets[0].rows[1][originalColumns]='Rasadnik A';sheets[0].rows[1][originalColumns+1]=80.5;sheets[0].rows[1][originalColumns+2]='EUR';
const bytes=await Excel.build(template,sheets,Zip,()=>{},original),after=await Zip.loadAsync(bytes,{checkCRC32:true});
const changed=[];let unchanged=0;
for(const [name,entry] of Object.entries(before.files)){if(entry.dir)continue;assert(after.file(name),name+' lost');const a=await entry.async('uint8array'),b=await after.file(name).async('uint8array');if(Buffer.compare(Buffer.from(a),Buffer.from(b)))changed.push(name);else unchanged++;}
assert.deepEqual(changed.sort(),['xl/styles.xml','xl/worksheets/sheet1.xml']);
const normalize=s=>s.replace(/xmlns:x="http:\/\/schemas.openxmlformats.org\/spreadsheetml\/2006\/main"/g,'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"').replace(/<(\/?)x:/g,'<$1');
const originalSheet=normalize(await before.file('xl/worksheets/sheet1.xml').async('string')),outputSheet=await after.file('xl/worksheets/sheet1.xml').async('string');
assert(outputSheet.indexOf('</sheetPr>')<outputSheet.indexOf('<dimension'),'Dimension follows sheet properties in OpenXML order');
assert(outputSheet.indexOf('</sheetData>')<outputSheet.indexOf('<autoFilter'),'Filter is a worksheet child after data');
for(const c of originalSheet.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)||[])assert(outputSheet.includes(c),'Original cell changed: '+c.slice(0,60));
for(const tag of ['mergeCells','drawing','sheetProtection']){const originalBlock=originalSheet.match(new RegExp('<'+tag+'\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/'+tag+'>)'))?.[0];if(originalBlock)assert(outputSheet.includes(originalBlock),tag+' changed');}
assert(Object.keys(before.files).some(name=>name.startsWith('xl/media/')&&!before.files[name].dir),'Source must contain actual logos');
const preserved=XLSX.read(bytes,{type:'array',cellDates:true,cellStyles:true});
for(const name of book.SheetNames)for(const [address,cell] of Object.entries(book.Sheets[name])){if(address.startsWith('!'))continue;const actual=preserved.Sheets[name][address];assert(actual,'Missing '+address);assert.equal(actual.f,cell.f,'Formula changed: '+address);assert.deepEqual(actual.v,cell.v,'Value changed: '+address);assert.equal(actual.z,cell.z,'Number format changed: '+address);}
assert.equal(preserved.Sheets[book.SheetNames[0]][XLSX.utils.encode_cell({r:1,c:originalColumns+1})].v,80.5);
const fallback=await Excel.build(template,[{name:'Spisak',processed:true,headerRow:0,originalColumns:1,columns:3,rows:[['Biljka','Rasadnik','Cena'],['Acer','A',80.5]]}],Zip);
const fallbackZip=await Zip.loadAsync(fallback),fallbackWorkbook=await fallbackZip.file('xl/workbook.xml').async('string');
assert(/<workbook\b[^>]*xmlns:r="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships"/.test(fallbackWorkbook),'Every r:id has a root namespace declaration');
if(process.env.DEMETRA_EXCEL_QA_OUTPUT){await mkdir(process.env.DEMETRA_EXCEL_QA_OUTPUT,{recursive:true});await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'preserved-template.xlsx'),new Uint8Array(bytes));await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'fallback.xlsx'),new Uint8Array(fallback));}
console.log(JSON.stringify({ok:true,unchangedPackageParts:unchanged,onlySourceStylesAndProcessedSheetExtended:true,originalCellsFormulasFormatsPreserved:true,mergesAndLogosPreserved:true,fallbackRelationshipNamespaceValid:true}));

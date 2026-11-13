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
const headers=['Spisak rasadnika','Rasadnik sa najnižom cenom','Najniža nabavna cena (€)','Ponuđeni parametri','Datum izvorne ponude','Rezultat preporuke'];
const values=['Rasadnik A — 80,50 €\nRasadnik B — 95,00 €','Rasadnik A',80.5,'Obim: 18–20; Isporuka: Kontejner','2026-11-13','Najniža evidentirana cena za tražene parametre.'];
const sheets=book.SheetNames.map((name,index)=>({name,rows:index?XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:''}):rows.map(row=>row.slice()),processed:index===0,headerRow:0,originalColumns,columns:originalColumns+headers.length}));
headers.forEach((value,i)=>sheets[0].rows[0][originalColumns+i]=value);values.forEach((value,i)=>sheets[0].rows[1][originalColumns+i]=value);
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
const resultPrice=preserved.Sheets[book.SheetNames[0]][XLSX.utils.encode_cell({r:1,c:originalColumns+2})];
assert.equal(resultPrice.v,80.5);assert.equal(resultPrice.t,'n');assert.equal(resultPrice.z,'#,##0.00 "€"');
const supplier=preserved.Sheets[book.SheetNames[0]][XLSX.utils.encode_cell({r:1,c:originalColumns+1})];assert(!supplier.z.includes('€'),'Supplier name must not receive currency format');
const fallback=await Excel.build(template,[{name:'Spisak',processed:true,headerRow:0,originalColumns:1,columns:7,rows:[['Biljka',...headers],['Acer',...values]]},{name:'Promenjen redosled',processed:true,headerRow:0,originalColumns:1,columns:3,rows:[['Biljka','Najniža nabavna cena (€)','Spisak rasadnika'],['Acer',80.5,'A']]}],Zip);
const fallbackZip=await Zip.loadAsync(fallback),fallbackWorkbook=await fallbackZip.file('xl/workbook.xml').async('string');
assert(/<workbook\b[^>]*xmlns:r="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships"/.test(fallbackWorkbook),'Every r:id has a root namespace declaration');
const fallbackBook=XLSX.read(fallback,{type:'array',cellStyles:true});assert.equal(fallbackBook.Sheets.Spisak.D2.z,'#,##0.00 "€"');assert.equal(fallbackBook.Sheets['Promenjen redosled'].B2.z,'#,##0.00 "€"','Currency format follows header, not fixed position');
const extra={name:'Preporuka bez zaglavlja',processed:true,addedSheet:true,headerRow:0,originalColumns:2,columns:8,rows:[['Naziv biljke','Opis',...headers],['Acer campestre','visina 300–350 cm',...values]]};
const addedBytes=await Excel.build(template,[...sheets.map(s=>({...s,processed:false})),extra],Zip,()=>{},original),addedZip=await Zip.loadAsync(addedBytes),addedBook=XLSX.read(addedBytes,{type:'array',cellStyles:true});
assert.deepEqual(addedBook.SheetNames,[...book.SheetNames,extra.name]);assert.equal(addedBook.Sheets[extra.name].A2.v,'Acer campestre');assert.equal(addedBook.Sheets[extra.name].E2.v,80.5);assert.equal(addedBook.Sheets[extra.name].E2.z,'#,##0.00 "€"');
for(const name of Object.keys(before.files).filter(name=>/^xl\/worksheets\//.test(name)&&!before.files[name].dir))assert.equal(await addedZip.file(name).async('string'),await before.file(name).async('string'),'Headerless export changed original worksheet '+name);
const originalFormula=Object.entries(source).find(([address,c])=>!address.startsWith('!')&&c.f);assert(originalFormula,'Source must contain actual formulas');assert.equal(addedBook.Sheets[book.SheetNames[0]][originalFormula[0]].f,originalFormula[1].f);
// A native Excel table must include added results so sorting never detaches them from their plants.
const tableBase=await Excel.build(template,[{name:'Biljke',processed:false,headerRow:0,originalColumns:2,columns:2,rows:[['Naziv','Obim'],['Acer campestre','18-20']]}],Zip),tableZip=await Zip.loadAsync(tableBase);
const tableXml='<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Biljke" displayName="Biljke" ref="A1:B2" headerRowCount="1" totalsRowCount="0"><tableColumns count="2"><tableColumn id="1" name="Naziv"/><tableColumn id="2" name="Obim"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>';
tableZip.file('xl/tables/table1.xml',tableXml);
tableZip.file('xl/worksheets/_rels/sheet1.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="table1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>');
tableZip.file('xl/worksheets/sheet1.xml',(await tableZip.file('xl/worksheets/sheet1.xml').async('string')).replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ').replace('</worksheet>','<tableParts count="1"><tablePart r:id="table1"/></tableParts></worksheet>'));
tableZip.file('[Content_Types].xml',(await tableZip.file('[Content_Types].xml').async('string')).replace('</Types>','<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>'));
const tableOriginal=await tableZip.generateAsync({type:'arraybuffer'}),tableResult=await Excel.build(template,[{name:'Biljke',processed:true,headerRow:0,originalColumns:2,columns:8,rows:[['Naziv','Obim',...headers],['Acer campestre','18-20',...values]]}],Zip,()=>{},tableOriginal),tableAfter=await Zip.loadAsync(tableResult),tableAfterXml=await tableAfter.file('xl/tables/table1.xml').async('string');
assert(/<table\b[^>]*ref="A1:H2"/.test(tableAfterXml));assert(/<autoFilter ref="A1:H2"/.test(tableAfterXml));assert(/<tableColumns count="8"/.test(tableAfterXml));assert(tableAfterXml.includes('<tableColumn id="1" name="Naziv"/>'));assert(tableAfterXml.includes('<tableColumn id="2" name="Obim"/>'));assert(tableAfterXml.includes('TableStyleMedium2'));
if(process.env.DEMETRA_EXCEL_QA_OUTPUT){await mkdir(process.env.DEMETRA_EXCEL_QA_OUTPUT,{recursive:true});await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'preserved-template.xlsx'),new Uint8Array(bytes));await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'fallback.xlsx'),new Uint8Array(fallback));await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'headerless-preserved.xlsx'),new Uint8Array(addedBytes));await writeFile(resolve(process.env.DEMETRA_EXCEL_QA_OUTPUT,'native-table-preserved.xlsx'),new Uint8Array(tableResult));}
console.log(JSON.stringify({ok:true,unchangedPackageParts:unchanged,onlySourceStylesAndProcessedSheetExtended:true,originalCellsFormulasFormatsPreserved:true,mergesAndLogosPreserved:true,fallbackRelationshipNamespaceValid:true,currencyFollowsHeader:true,headerlessOriginalPreserved:true,nativeTableIncludesResults:true}));

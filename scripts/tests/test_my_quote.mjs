import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createContext,Script} from 'node:vm';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
const Core=require(root+'/assets/moja-ponuda-core.js');
const Zip=require(root+'/assets/vendor/jszip-3.10.1.min.js');
const html=await readFile(root+'/index.html','utf8');
assert(/<script src="\.\/assets\/moja-ponuda-core\.js(?:\?[^\"]*)?"><\/script>/.test(html));
assert(/<script src="\.\/assets\/moja-ponuda\.js(?:\?[^\"]*)?"><\/script>/.test(html));
const core=html.match(/\/\/ BEGIN CATALOG CORE\n([\s\S]*?)\/\/ END CATALOG CORE/)[1];
const ui=html.slice(html.indexOf('const $ = (id)'),html.indexOf('function openRecord(id)'));
const context=createContext({URL,atob:globalThis.atob,document:{baseURI:'https://example.test/',getElementById:()=>({})}});
new Script(core+'\n'+ui).runInContext(context);
const [plants,nurseries,offers]=await Promise.all(['biljke','rasadnici','kataloske-stavke'].map(async name=>JSON.parse(await readFile(root+'/data/'+name+'.json','utf8'))));
context.catalogInput=JSON.stringify({schemaVersion:1,sourcePolicy:offers.sourcePolicy,plants:plants.plants,nurseries:nurseries.nurseries,offers:offers.offers,favorites:[],updatedAt:offers.updatedAt});
new Script('state.catalog=validateImport(JSON.parse(catalogInput)).data;').runInContext(context);
const valid=offers.offers.filter(o=>!['needs_review','superseded'].includes(o.recordStatus));
const snapshots=[];
for(const offer of valid){
  context.offerId=offer.id;
  const item=JSON.parse(JSON.stringify(new Script('makeQuoteItem(offerId)').runInContext(context)));
  assert.equal(item.offerId,offer.id);assert.equal(item.plantId,offer.plantId);assert.equal(item.nurseryId,offer.nurseryId);
  context.sourceOffer=offer;const expectedPrice=new Script('catalogEuroPrice(sourceOffer)').runInContext(context);
  assert.equal(item.sourcePrice,expectedPrice);
  assert.equal(item.currency,'EUR');assert.equal(item.sourcePriceCurrency,'EUR');
  const normalized=Core.normalizeItem(item);
  assert(normalized.parameters.some(([key,value])=>key==='Obim sadnice'&&value===(offer.circumference||'')));
  assert(normalized.parameters.some(([key,value])=>key==='Visina sadnice'&&value===(offer.height||'')));
  if(expectedPrice!==null)assert(Core.lineResult(normalized).valid,'Catalog price must be usable: '+offer.id+' '+expectedPrice);
  snapshots.push(normalized);
}
for(const offer of offers.offers.filter(o=>['needs_review','superseded'].includes(o.recordStatus))){
  context.offerId=offer.id;assert.equal(new Script('makeQuoteItem(offerId)').runInContext(context),null);
}
const quote=Core.emptyQuote();
const first=snapshots.find(item=>item.sourcePrice>0&&item.parameters.some(([key,value])=>key==='Obim sadnice'&&value));
const second=snapshots.find(item=>item.plantId===first.plantId&&item.offerId!==first.offerId&&item.sourcePrice>0);
assert(second,'Fixture must contain two different variants of one plant.');
assert(Core.addItem(quote,first));assert(Core.addItem(quote,second));assert.equal(Core.addItem(quote,first),false);
assert.equal(quote.items.length,2);
quote.items[0].quantity='3';quote.items[0].price='12,50';
quote.items[1].quantity='2';quote.items[1].price='20';
quote.meta.number='PROVERA-11/26';quote.meta.client='Primer investitora';quote.meta.address='Primer adrese 1';
quote.meta.city='11070 Novi Beograd';quote.meta.taxId='001234567';quote.meta.registration='00123456';
quote.meta.date='2026-11-11';quote.meta.preparedBy='Primer sastavljača';
quote.items[0].note='=HYPERLINK("https://example.invalid/", "tekst")';
assert.equal(Core.summarize(quote).amount,77.5);
assert.deepEqual(Core.parseQuote(JSON.stringify(quote)),quote);
assert.equal(Core.lineResult({...first,quantity:'30',price:'0,0525'}).amount,1.58);
assert.equal(Core.lineResult({...first,quantity:'3',price:'0.1'}).amount,0.3);
assert.equal(Core.lineResult({...first,quantity:'1',price:'0'}).amount,0);
for(const price of ['', '-1','1e6','abc','12,34567'])assert.equal(Core.lineResult({...first,price}).valid,false);
for(const quantity of ['', '0','-2','100001'])assert.equal(Core.lineResult({...first,quantity}).valid,false);
assert.equal(Core.parseDecimal('1.234,56').value,1234.56);
assert.equal(Core.parseDecimal('1,234.56').value,1234.56);
assert.equal(Core.parseDecimal('1.2.3').valid,false);
assert.throws(()=>Core.parseQuote('{bad json'));
assert.throws(()=>Core.parseQuote({...quote,items:[first,first]}));
assert.equal(Core.normalizeItem({...first,currency:'RSD'}).currency,'RSD');
assert.throws(()=>Core.normalizeItem({...first,currency:'XXXX'}));
// Previously cached catalogue amounts refresh; manual price overrides retain their amount and currency.
const legacy={...first,sourcePrice:5800,price:'5800',currency:'EUR',quantity:'3',note:'Zadrži moju napomenu'};delete legacy.priceEdited;delete legacy.sourcePriceCurrency;
const cached=Core.parseQuote({...Core.emptyQuote(),items:[legacy]});assert.equal(cached.items[0].priceEdited,false);
const current={...first,sourcePrice:49.31,price:'49.31',currency:'EUR',sourcePriceCurrency:'EUR',priceEdited:false};
assert(Core.refreshCatalogPrices(cached,()=>current));assert.equal(cached.items[0].price,'49.31');assert.equal(cached.items[0].sourcePrice,49.31);assert.equal(cached.items[0].quantity,'3');assert.equal(cached.items[0].note,legacy.note);assert(!Core.refreshCatalogPrices(cached,()=>current));
for(const override of [{...legacy,price:'120'},{...legacy,price:'5800',priceEdited:true},{...legacy,price:'',priceEdited:true},{...legacy,price:'6000',currency:'RSD'}]){
  const manual=Core.parseQuote({...Core.emptyQuote(),items:[override]});assert.equal(manual.items[0].priceEdited,true);Core.refreshCatalogPrices(manual,()=>current);assert.equal(manual.items[0].price,override.price);assert.equal(manual.items[0].currency,override.currency);assert.equal(manual.items[0].sourcePrice,49.31);assert.equal(manual.items[0].sourcePriceCurrency,'EUR');assert.equal(Core.parseQuote(JSON.stringify(manual)).items[0].priceEdited,true);
}
Core.refreshCatalogPrices(cached,()=>({...current,sourcePrice:null,price:''}));assert.equal(cached.items[0].price,'');assert.equal(cached.items[0].sourcePrice,null);
// Exercise the actual app's storage migration and price-input handler in an isolated DOM/storage.
const uiNodes=new Map(),saved=new Map([[Core.STORAGE_KEY,JSON.stringify({...Core.emptyQuote(),items:[legacy]})]]);
const uiNode=id=>{if(!uiNodes.has(id))uiNodes.set(id,{innerHTML:'',textContent:'',listeners:{},setAttribute(){},addEventListener(name,listener){this.listeners[name]=listener;},querySelectorAll(){return [];}});return uiNodes.get(id);};
const uiDocument={baseURI:'https://example.test/',getElementById:uiNode,querySelectorAll:()=>[],addEventListener(){}};
const appContext=createContext({URL,document:uiDocument,window:{DemetraQuoteCore:Core},localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)}});
new Script(await readFile(root+'/assets/moja-ponuda.js','utf8')).runInContext(appContext);
let latest={...current};const app=appContext.window.DemetraQuote.create({getItem:()=>latest});app.refresh();
assert.equal(JSON.parse(saved.get(Core.STORAGE_KEY)).items[0].price,'49.31');
uiNode('my-quote-view').listeners.input({target:{dataset:{quoteEdit:'price',quoteItem:first.offerId},value:'120'}});
latest={...current,price:'77',sourcePrice:77};app.refresh();
const savedOverride=JSON.parse(saved.get(Core.STORAGE_KEY)).items[0];assert.equal(savedOverride.price,'120');assert.equal(savedOverride.priceEdited,true);assert.equal(savedOverride.sourcePrice,77);
const template=await readFile(root+'/assets/moja-ponuda-template.xlsx');
const bytes=await Core.buildXlsx(template,quote,Zip);
const zip=await Zip.loadAsync(bytes,{checkCRC32:true});
const sheet=await zip.file('xl/worksheets/sheet1.xml').async('string');
const workbook=await zip.file('xl/workbook.xml').async('string');
assert.equal((workbook.match(/<(?:x:)?sheet\b/g)||[]).length,1,'Excel must contain only one worksheet.');
assert(workbook.includes('name="Moja ponuda"')&&!workbook.includes('name="Parametri"'));
assert.equal(zip.file('xl/worksheets/sheet2.xml'),null,'Removed worksheet must not remain in the file.');
// Read the exported unit-column geometry from the actual XLSX worksheet XML.
const unitColumn = [...sheet.matchAll(/<col\b[^>]*\/>/g)].find(([tag])=>{
  const min=Number(tag.match(/\bmin="(\d+)"/)?.[1]);
  const max=Number(tag.match(/\bmax="(\d+)"/)?.[1]);
  return min<=7&&max>=7;
})?.[0];
assert(unitColumn,'Unit column G must be explicitly sized');
assert(Number(unitColumn.match(/\bwidth="([\d.]+)"/)?.[1])>=12,'Unit width must fit full words instead of single letters');

const a4Columns = [...sheet.matchAll(/<col\b[^>]*\/>/g)].map(([tag]) => ({
  min: Number(tag.match(/\bmin="(\d+)"/)?.[1]),
  max: Number(tag.match(/\bmax="(\d+)"/)?.[1]),
  width: Number(tag.match(/\bwidth="([\d.]+)"/)?.[1]),
  hidden: /\bhidden="1"/.test(tag)
})).filter(col => col.min <= 10 && col.max >= 1 && !col.hidden);
assert.equal(a4Columns.length,10,'All ten printable columns must have a specified A4 width');
assert.deepEqual(a4Columns.map(col=>col.width),[4.5,11,11,11,10,10,12,7,7,15]);
const printableA4MM = 210 - 2*0.25*25.4;
const approximateExcelWidthMM = a4Columns.reduce((sum,col)=>sum + col.width*7 + 5,0)*25.4/96;
assert(approximateExcelWidthMM <= printableA4MM,
  'The worksheet must be designed for physical portrait A4, not merely shrunk by print settings');
assert(approximateExcelWidthMM > printableA4MM*0.94,
  'The visible table should occupy the printable A4 width instead of leaving a large empty margin');

assert(sheet.includes('Jed.')||sheet.includes('Jed'), 'Original unit heading must remain unchanged');
assert(sheet.includes('customHeight="1"'),'Rows must retain custom height for wrapped text');
assert(sheet.includes('orientation="portrait"')&&sheet.includes('paperSize="9"'),'Excel must print on portrait A4');
assert(sheet.includes('fitToWidth="1"')&&sheet.includes('fitToHeight="0"'),'Fit to one A4 page wide');
assert(!sheet.includes('Valuta'),'No visible currency column');
assert(sheet.includes('<mergeCell ref="B18:C18"')&&sheet.includes('<mergeCell ref="D19:F19"'),'Names and parameters must use their two-column areas');
const totalStyle=Number(sheet.match(/<c r="J21" s="(\d+)"/)?.[1]);
assert(Number.isInteger(totalStyle),'Total formula must have currency style');
const styleXml=await zip.file('xl/styles.xml').async('string');
assert(styleXml.includes('&quot;EUR&quot;'),'Currency must be formatted into the total');
assert(workbook.includes('_xlnm.Print_Area')&&workbook.includes("'Moja ponuda'!$A$1:$J$21"),
  'A4 print area must end after totals, without the hidden currency column');

const tableHeader=sheet.match(/<row\b[^>]*\br="18"[^>]*>[\s\S]*?<\/row>/)?.[0]||'';
assert(!/<t[^>]*>(?:Rasadnik|Količina)<\/t>/.test(sheet),'Supplier and quantity excluded');
assert(!/\bPDV\b/.test(sheet),'VAT text excluded');
assert(sheet.includes('min="11" max="12" width="2" hidden="1"'),'Internal quantity and currency hidden');
const firstPlant=sheet.match(/<row\b[^>]*\br="19"[^>]*>[\s\S]*?<\/row>/)?.[0]||'';
assert(tableHeader.includes('Biljka')&&tableHeader.includes('Parametri sadnice'),
  'Plant table header must move to row 18.');
assert(firstPlant.includes('r="B19"') && firstPlant.includes(Core.xmlEscape(first.latinName)),
  'First plant must start directly at row 19.');
for(const number of [23,24]) assert(!sheet.includes('<row r="'+number+'"'),
  'No abandoned header rows or whitespace should remain after moving the table.');

assert(sheet.includes('<f>ROUND(L19*H19,2)</f><v>37.5</v>'));
assert(sheet.includes('<f>ROUND(L20*H20,2)</f><v>40</v>'));
assert(sheet.includes('<f>SUM(J19:J20)</f><v>77.5</v>'));
assert(sheet.includes('001234567')&&sheet.includes('00123456'));
assert(sheet.includes('U Beogradu, 11.11.2026.'),'Date directly next to city');
assert(sheet.includes('<mergeCell ref="E4:J4"')&&sheet.includes('<mergeCell ref="E8:J8"'),'Company directly below accreditation marks');
assert(sheet.includes('<mergeCell ref="E9:F9"')&&sheet.includes('<mergeCell ref="G9:J9"'),'Investor opposite preparer');
for(const [ref,value] of Object.entries({G9:'Primer investitora',G10:'Primer adrese 1',G12:'001234567 · 00123456'})){
  const found=sheet.match(new RegExp('<c\\b(?=[^>]*\\br="' + ref + '")[^>]*>[\\s\\S]*?<\\/c>'))?.[0];
  assert(found&&found.includes(value),'Investor field '+ref);
}

for(const label of ['Investitor / kontakt:','Adresa:','Kontakt:','Matični broj:','Ponuda biljaka i sadnog materijala','R.br.'])assert(sheet.includes(label),'Header label disappeared: '+label);
assert(sheet.includes('HYPERLINK')&&!sheet.includes('<f>HYPERLINK'));
assert(sheet.includes(Core.xmlEscape(first.offerId))===false,'Technical offer IDs are not public workbook fields.');
for(const item of quote.items)for(const [label,value] of item.parameters){
  if(value!==''&&value!==null&&!/\b(?:PDV|VAT)\b/i.test(label+' '+value)&&!/^nije navedeno|^nepoznat/i.test(String(value)))
    assert(sheet.includes(Core.xmlEscape(String(value))),label+' must survive in the main worksheet');
}
const longParameter='Dodatni podatak '.repeat(80)+'KRAJ';
assert(Core.compactParameters({...first,parameters:[['Opis',longParameter]]}).includes(longParameter));
assert(!sheet.includes('list Parametri'),'Export must not refer to the removed worksheet.');
const digest=data=>createHash('sha256').update(data).digest('hex');
const expectedImages=await Promise.all(['demetra-memorandum-logo.png','demetra-memorandum-standardi.jpg'].map(async name=>digest(await readFile(root+'/assets/'+name))));
const exportedImages=await Promise.all(Object.keys(zip.files).filter(name=>name.startsWith('xl/media/')&&!zip.files[name].dir).map(async name=>digest(await zip.file(name).async('uint8array'))));
for(const hash of expectedImages)assert(exportedImages.includes(hash),'An original memorandum image changed or disappeared');
await assert.rejects(Core.buildXlsx(template,{...quote,items:[{...first,price:''}]},Zip));
await assert.rejects(Core.buildXlsx(template,{...quote,meta:{...quote.meta,date:''}},Zip));
const mixed={...quote,items:[quote.items[0],{...quote.items[1],currency:'RSD'}]};
assert.equal(Core.summarize(mixed).amount,null);
assert.deepEqual(Core.summarize(mixed).totals.map(t=>[t.currency,t.amount]),[['EUR',37.5],['RSD',40]]);
const mixedFile=await Zip.loadAsync(await Core.buildXlsx(template,mixed,Zip));
const mixedXml=await mixedFile.file('xl/worksheets/sheet1.xml').async('string');
assert(mixedXml.includes('SUMIF(K19:K20,&quot;EUR&quot;,J19:J20)'));
assert(mixedXml.includes('r="K19"')&&mixedXml.includes('r="K20"'),'Currency retained only in hidden data');
assert(mixedXml.includes('SUMIF(K19:K20,&quot;RSD&quot;,J19:J20)'));
assert(!mixedXml.includes('Valuta'),'Visible currency column title must be removed');
// A saved offer date must not leak into the current download filename.
assert.equal(Core.filename({number:'',date:'2026-11-11'},new Date(2026,10,20,12)),'Demetra-RB-ponuda-2026-11-20.xlsx');
assert.equal(Core.filename({number:'01/26',date:'2026-11-11'},new Date(2026,10,21,0,1)),'Demetra-RB-ponuda-2026-11-21-01-26.xlsx');
// Descriptions longer than Excel's row-height limit continue visibly.
const extended={...quote,items:[{...quote.items[0],parameters:[['Opis',longParameter]]}]};
const extendedZip=await Zip.loadAsync(await Core.buildXlsx(template,extended,Zip));
const extendedXml=await extendedZip.file('xl/worksheets/sheet1.xml').async('string');
const descriptions=[...extendedXml.matchAll(/<c r="D(\d+)" s="\d+" t="inlineStr"><is><t[^>]*>([\s\S]*?)<\/t><\/is><\/c>/g)].filter(m=>Number(m[1])>=19).map(m=>m[2]).join('');
assert.equal(descriptions,Core.xmlEscape(Core.compactParameters(extended.items[0])),'Continuation rows preserve the entire description');
assert([...extendedXml.matchAll(/<row\b[^>]*\bht="([\d.]+)"/g)].every(m=>Number(m[1])<=400),'No row exceeds the readable Excel height');
assert(extendedXml.includes('KRAJ'),'The end of the long description is retained');
assert(extendedXml.includes('SUM(J19:J'),'Totals include continued rows without counting a plant twice');
const headerRows=[...sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>/g)].filter(m=>Number(m[1])<18);
const headerHeight=headerRows.reduce((sum,m)=>sum+Number(m[0].match(/\bht="([\d.]+)"/)?.[1]||0),0);
assert(headerHeight<260,'The plant table must begin substantially higher on the page');
for(const row of [7,13,14,15])assert(new RegExp('<row\\b(?=[^>]*\\br="'+row+'")(?=[^>]*\\bhidden="1")').test(sheet),'Unused formal row must collapse: '+row);
assert(sheet.includes('PIB / matični broj:'),'Condensed investor identifiers retain their meaning');
assert(sheet.includes(Core.COMPANY.email)&&sheet.includes(Core.COMPANY.website),'Company contacts remain in the compact memorandum');
const testDir=process.env.DEMETRA_QUOTE_TEST_OUTPUT;
if(testDir){await mkdir(testDir,{recursive:true});await writeFile(resolve(testDir,'provera-moja-ponuda.xlsx'),bytes);}
console.log(JSON.stringify({ok:true,selectableVariants:snapshots.length,hiddenOffersRejected:offers.offers.length-valid.length,
 exactVariantIdentity:true,allParametersPreserved:true,duplicateSelectionPrevented:true,overridesAndPersistence:true,
 decimalCommaAndZero:true,missingPriceBlocksExport:true,formulaInjectionPrevented:true,
 originalHeaderImagesUnchanged:true,excelLineFormulas:true,worksheetCount:1,parametersInMainSheet:true,total:77.5},null,2));

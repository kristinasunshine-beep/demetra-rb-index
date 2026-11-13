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
assert(sheet.includes('<f>ROUND(F23*G23,2)</f><v>37.5</v>'));
assert(sheet.includes('<f>ROUND(F24*G24,2)</f><v>40</v>'));
assert(sheet.includes('<f>SUM(H23:H24)</f><v>77.5</v>'));
assert(sheet.includes('001234567')&&sheet.includes('00123456'));
for(const label of ['Ime i prezime / naziv firme','Adresa','Grad i poštanski broj','Telefon','Ponuda biljaka i sadnog materijala','R.br.'])assert(sheet.includes(label),'Header label disappeared: '+label);
assert(sheet.includes('HYPERLINK')&&!sheet.includes('<f>HYPERLINK'));
assert(sheet.includes(Core.xmlEscape(first.offerId))===false,'Technical offer IDs are not public workbook fields.');
for(const item of quote.items)for(const [label,value] of item.parameters){
  if(value!==''&&value!==null&&!/^nije navedeno|^nepoznat/i.test(String(value)))
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
assert(mixedXml.includes('SUMIFS(H23:H24,I23:I24,&quot;EUR&quot;)'));
assert(mixedXml.includes('SUMIFS(H23:H24,I23:I24,&quot;RSD&quot;)'));
const testDir=process.env.DEMETRA_QUOTE_TEST_OUTPUT;
if(testDir){await mkdir(testDir,{recursive:true});await writeFile(resolve(testDir,'provera-moja-ponuda.xlsx'),bytes);}
console.log(JSON.stringify({ok:true,selectableVariants:snapshots.length,hiddenOffersRejected:offers.offers.length-valid.length,
 exactVariantIdentity:true,allParametersPreserved:true,duplicateSelectionPrevented:true,overridesAndPersistence:true,
 decimalCommaAndZero:true,missingPriceBlocksExport:true,formulaInjectionPrevented:true,
 originalHeaderImagesUnchanged:true,excelLineFormulas:true,worksheetCount:1,parametersInMainSheet:true,total:77.5},null,2));

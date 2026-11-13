import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const Core=require(root+'/assets/brza-preporuka-core.js'),Excel=require(root+'/assets/recommendation-excel.js'),Zip=require(root+'/assets/vendor/jszip-3.10.1.min.js'),XLSX=require(root+'/assets/vendor/xlsx-0.20.3.full.min.js');
const base={id:'a-old',plantId:'p1',nurseryId:'n1',circumference:'18–20',height:'300–350',crownWidth:'',potSize:'50 L',rootType:'Kontejner (cont)',seedlingType:'standard',transplantCount:3,unit:'kom',taxStatus:'Bez PDV-a',price:40,currency:'EUR',priceKind:'historical',sourceDate:'2025-01-01'};
const catalog={plants:[{id:'p1',latinName:"Acer campestre 'Elsrijk'",synonyms:[]},{id:'p2',latinName:'Acer campestre',synonyms:[]},{id:'p3',latinName:"Acer campestre 'Elegant'",synonyms:[]}],nurseries:[{id:'n1',name:'Rasadnik A'},{id:'n2',name:'Rasadnik B'}],offers:[base,{...base,id:'a-new',price:70,sourceDate:'2026-11-13'},{...base,id:'b-match',nurseryId:'n2',price:65,sourceDate:'2026-11-12'},{...base,id:'bad-size',circumference:'12-14',price:5},{...base,id:'bad-cultivar',plantId:'p3',price:1},{...base,id:'bad-species',plantId:'p2',price:2},{...base,id:'hidden',recordStatus:'needs_review',price:3},{...base,id:'pending',price:4,priceRefresh:{status:'pending'}},{...base,id:'no-stock',price:1,availability:'Out of stock'}]};
const index=Core.makeIndex(catalog),request={name:"Acer campestre 'Elsrijk'",circumference:'18-20',height:'3-3.5m',potSize:'C50',rootType:'container',seedlingType:'standard',transplantCount:3,quantity:5};
const result=Core.recommend(index,request);assert.equal(result.offerId,'b-match');assert.equal(result.price,65);
assert.deepEqual(result.suppliers.map(s=>[s.name,s.price]),[['Rasadnik B',65],['Rasadnik A',70]]);
assert.equal(result.values.length,6);assert.equal(result.values[1],'Rasadnik B');assert.equal(result.values[2],65);assert(result.values[0].includes('Rasadnik A')&&result.values[0].includes('Rasadnik B'));
assert.equal(Core.recommend(index,{...request,cultivar:'Elsrijk'}).price,65);
assert.equal(Core.recommend(index,{...request,cultivar:'Elegant'}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,name:"Acer campestre 'Wrong'"}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,height:'400-450'}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,currency:'RSD'}).price,65,'Input currency is preserved in the source sheet; output compares normalized EUR offers');
const converted={...base,id:'converted-rsd',price:49.31,currency:'EUR',sourceAmount:5800,sourceCurrency:'RSD',currencyStatus:'converted',priceConversion:{status:'converted',fromCurrency:'RSD',toCurrency:'EUR',originalAmount:5800,rate:117.6203,rateDate:'2026-11-13'}};
assert.equal(Core.euroPrice(converted),49.31);
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[converted]}),request).price,49.31);
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[converted]}),request).suppliers[0].price,49.31);
for(const invalid of [{...converted,price:5800},{...converted,currency:'RSD',price:5800},{...converted,priceConversion:undefined},{...converted,priceConversion:{...converted.priceConversion,rate:0}},{...converted,priceConversion:{...converted.priceConversion,originalAmount:5000}},{...converted,currencyStatus:'unresolved'},{...converted,priceConversion:{...converted.priceConversion,status:'unresolved'}}]){
  assert.equal(Core.euroPrice(invalid),null);const failed=Core.recommend(Core.makeIndex({...catalog,offers:[invalid]}),request);assert.equal(failed.status,'unmatched');assert.equal(failed.suppliers[0].price,null);
}
assert.equal(Core.euroPrice({...base,price:5800,sourceCurrency:'EUR',sourceAmount:5800}),5800);
assert.equal(Core.euroPrice({...base,price:5800,sourceCurrency:'EUR',sourceAmount:58}),null);
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[base,{...base,id:'new-unconverted',sourceDate:'2026-11-13',price:5800,currency:'RSD'}]}),request).status,'unmatched','A newer currency change must not revive the obsolete EUR price');
assert.equal(Core.recommend(index,{...request,preferences:'18-20'}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,preferences:'crven list'}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,quantity:-1}).status,'unmatched');
assert.equal(Core.recommend(index,{...request,quantity:Infinity}).status,'unmatched');
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[base,{...base,id:'new-pending',sourceDate:'2026-11-13',priceRefresh:{status:'pending'}}]}),request).status,'unmatched');
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,id:'fresh-file',price:90,priceRefresh:{status:'verified',changedAt:'2026-11-13'}},{...base,id:'old-file',price:10,sourceDate:'2026-11-12'}]}),request).price,90);
assert.equal(Core.recommend(index,{name:"Acer campestre 'Elsrijk' obim 18-20; h 300-350; C50; standard; container"}).offerId,'b-match');
assert(Core.measureMatches('>=300','300-350','height'));assert(!Core.measureMatches('300-350','350-400','height'));
assert(Core.measureMatches('3-3.5m','300-350 cm','height'));assert(!Core.measureMatches('50L','50cm','potSize'));
// A supplier's open-ended measurement cannot prove a customer's bounded specification.
assert(!Core.measureMatches('300-350','300+','height'));
assert(!Core.measureMatches('100-300','<=300','height'));
assert(Core.measureMatches('>=300','300+','height'));
assert(Core.measureMatches('<=350','<350','height'));
assert(!Core.measureMatches('>300','>=300','height'));
assert(Core.measureMatches('>=300','>300','height'));
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,height:'300+'}]}),request).status,'unmatched');
// Catalog display labels and their explicit nursery abbreviations describe the same delivery type.
for(const [requestedRoot,offeredRoot] of [['RB','Busen (RB)'],['RB','Busen (KL)'],['BR','Goli koren (BR)'],['container','Kontejner (CLT)'],['container','Kontejner (CG)'],['WRB','Busen u žičanoj korpi (DRKL)'],['WRB','Busen u žičanoj korpi (mDb)'],['WRB','Busen u žičanoj korpi (w.b.)']]){
  assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,rootType:offeredRoot}]}),{...request,rootType:requestedRoot}).price,40);
}
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,rootType:'Busen u žičanoj korpi (WRB)'}]}),{...request,rootType:'RB'}).status,'unmatched');
// A formatting/unit change in a newer price list must not resurrect a cheaper obsolete price.
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[base,{...base,id:'new-units',sourceDate:'2026-11-13',height:'3-3.5m',circumference:'18-20 cm',potSize:'C50',price:95}]}),request).price,95);
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,id:'net',price:10},{...base,id:'tax-unknown',nurseryId:'n2',price:9,taxStatus:'PDV nije naveden'}]}),request).status,'unmatched');
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,id:'piece',price:10},{...base,id:'pack',nurseryId:'n2',price:9,unit:'pakovanje'}]}),request).status,'unmatched');
assert.equal(Core.recommend(Core.makeIndex({...catalog,offers:[{...base,validUntil:'2020-01-01'}]}),request).status,'unmatched');
const header=Core.detectHeader([['Naslov'],[],['Naziv biljke','Obim (cm)','Količina','Visina (cm)']]);assert.equal(header.row,2);assert.deepEqual(header.map,{name:0,circumference:1,quantity:2,height:3});
// Numeric Excel cells inherit dimension units from their mapped column heading.
const unitHeaders=['Naziv biljke','Visina (m)','Obim (mm)','Veličina saksije (litres)'];
const unitMap=Core.detectHeader([unitHeaders]).map;
assert.deepEqual(unitMap,{name:0,height:1,circumference:2,potSize:3});
assert.equal(Core.recommend(index,Core.requestFromRow([request.name,'3–3,5','180-200',50],unitMap,unitHeaders)).price,65);
assert.equal(Core.recommend(index,Core.requestFromRow([request.name,'300-350 cm','18-20 cm','50 L'],unitMap,unitHeaders)).price,65);
assert.equal(Core.recommend(index,Core.requestFromRow([request.name,'3–3,5','180-200',50],unitMap,['Naziv biljke','Visina (m/cm)','Obim (mm)','Saksija (L)'])).status,'unmatched');
// Automatic recognition preserves every descriptive constraint; no column-mapping UI is needed.
const descriptiveRows=[['Naziv biljke','Parametri sadnice','Opis','Napomena'],[request.name,'obim 18–20','h 300–350','crven list']];
const descriptive=Core.detectSheet(descriptiveRows,index);assert.equal(descriptive.enabled,true);assert.deepEqual(descriptive.map.preferences,[1,2,3]);
assert.match(Core.recommend(index,Core.requestFromRow(descriptiveRows[1],descriptive.map,descriptive.headers)).message,/crven list/);
descriptiveRows[1][3]='container';assert.equal(Core.recommend(index,Core.requestFromRow(descriptiveRows[1],descriptive.map,descriptive.headers)).price,65);
const multilineRows=[['Latinski','Visina','Obim'],['naziv','(m)','(cm)'],[request.name,'3–3,5','18–20']];
const multiline=Core.detectSheet(multilineRows,index);assert.equal(multiline.headerRow,1);assert.equal(multiline.dataStartRow,2);assert.equal(Core.recommend(index,Core.requestFromRow(multilineRows[2],multiline.map,multiline.headers)).price,65);
const headerless=Core.detectSheet([[request.name,'obim 18–20; h 300–350']],index);assert.equal(headerless.hasHeader,false);assert.equal(headerless.headerRow,-1);assert.equal(headerless.dataStartRow,0);assert.equal(headerless.map.name,0);
assert.equal(Core.detectSheet(Array(130000).fill([request.name]),index).enabled,true);
assert.equal(Core.detectSheet([['Naziv biljke','Parametar','Vrednost'],[request.name,'Visina','300–350'],[request.name,'Obim','18–20']],index).enabled,false);
const withDescription={...request,sourceDescription:request.name+' - klen; visina sadnice 300–350cm, obim 18–20cm, kontejnirano, 3x presađivano'};
assert.equal(Core.recommend(index,withDescription).price,65);
assert.match(Core.recommend(index,{...withDescription,preferences:'I. klasa; pravilno oblikovana krošnja'}).message,/I.? klasa.*pravilno oblikovana krošnja/i);
const priorOutput=[['Naziv biljke','Parametri sadnice',...Core.EXTRA_HEADERS],[request.name,'obim 18–20; h 300–350',...result.values]];
const repeat=Core.detectSheet(priorOutput,index);assert.deepEqual(repeat.map,{name:0,preferences:1});assert.equal(Core.recommend(index,Core.requestFromRow(priorOutput[1],repeat.map,repeat.headers)).price,65);
const actual=await Promise.all(['biljke','rasadnici','kataloske-stavke'].map(async n=>JSON.parse(await readFile(root+'/data/'+n+'.json','utf8'))));
const actualIndex=Core.makeIndex({plants:actual[0].plants,nurseries:actual[1].nurseries,offers:actual[2].offers});
let reviewed=0;for(const offer of actual[2].offers){if(!offer.price||['needs_review','superseded'].includes(offer.recordStatus))continue;const plant=actualIndex.plants.get(offer.plantId);const req={name:plant.latinName,circumference:offer.circumference,height:offer.height,potSize:offer.potSize,rootType:offer.rootType,seedlingType:offer.seedlingType,currency:offer.currency};const found=Core.recommend(actualIndex,req);if(found.status==='matched'){const chosen=actual[2].offers.find(o=>o.id===found.offerId);assert.equal(chosen.plantId,offer.plantId);for(const key of ['circumference','height','potSize'])if(req[key])assert(Core.measureMatches(req[key],chosen[key],key));assert.equal(chosen.currency,'EUR');assert.equal(found.price,Core.euroPrice(chosen));}reviewed++;}
// Preserve every row and every original column, including text identifiers and literal formula-like text.
const original=[['Naziv biljke','Obim','Šifra'],[request.name,'18-20','0012'],['=HYPERLINK("https://example.invalid")','','0000']];
const sheets=[{name:'Spisak',processed:true,headerRow:0,originalColumns:3,columns:3+Core.EXTRA_HEADERS.length,rows:original.map((row,i)=>[...row,...(i===0?Core.EXTRA_HEADERS:i===1?result.values:Array(Core.EXTRA_HEADERS.length).fill(''))])},{name:'Napomena',processed:false,columns:1,rows:[['Sačuvan drugi list']]}];
const bytes=await Excel.build(await readFile(root+'/assets/brza-preporuka-template.xlsx'),sheets,Zip);
const book=XLSX.read(bytes,{type:'array',cellDates:true});assert.deepEqual(book.SheetNames,['Spisak','Napomena']);
const rows=XLSX.utils.sheet_to_json(book.Sheets.Spisak,{header:1,defval:''});
for(let r=0;r<original.length;r++)for(let c=0;c<original[r].length;c++)assert.equal(rows[r][c],original[r][c]);
assert.equal(book.Sheets.Spisak.F2.v,65);assert.equal(book.Sheets.Spisak.F2.t,'n');assert(!book.Sheets.Spisak.A3.f);
const zip=await Zip.loadAsync(bytes,{checkCRC32:true});const main=await zip.file('xl/worksheets/sheet1.xml').async('string');assert(main.includes('state="frozen"')&&main.includes('<autoFilter'));
if(process.env.DEMETRA_RECOMMEND_TEST_OUTPUT){await mkdir(process.env.DEMETRA_RECOMMEND_TEST_OUTPUT,{recursive:true});await writeFile(resolve(process.env.DEMETRA_RECOMMEND_TEST_OUTPUT,'provera-preporuke.xlsx'),new Uint8Array(bytes));}
// No application-level row cap: rows beyond common 100/1000/10000 limits use the same exact matching.
for(let n=0;n<12000;n++)assert.equal(Core.recommend(index,request).price,65);
console.log(JSON.stringify({ok:true,catalogPricesChecked:reviewed,strictCultivarAndMeasures:true,latestComparablePrice:true,noCurrencyOrTaxMixing:true,originalRowsAndColumnsPreserved:true,literalTextSafe:true,multipleSheets:true,rowsProcessedInScaleCheck:12000},null,2));

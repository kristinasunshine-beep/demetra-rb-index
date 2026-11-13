import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {refreshFolder,amount} from '../refresh_folder_prices.mjs';
import {normalizeOfferCurrency} from '../currency-normalization.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url),Zip=require(root+'/assets/vendor/jszip-3.10.1.min.js');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'demetra-price-test-')),source=path.join(temp,'source'),repo=path.join(temp,'repo');
await fs.mkdir(source);await fs.mkdir(path.join(repo,'data'),{recursive:true});
const rates={schemaVersion:1,base:'EUR',quote:'RSD',rate:117.6203,rateDate:'2026-11-13',source:'NBS official middle rate',sourceUrl:'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate',listNumber:'217',fetchedAt:'2026-11-13T07:00:00Z'};
await fs.writeFile(path.join(repo,'data/exchange-rates.json'),JSON.stringify(rates));
const seed=await fs.readFile(root+'/assets/brza-preporuka-template.xlsx');
async function sourceBook(price,name="Acer campestre 'Elsrijk'",size='18-20',currency='EUR'){
 const zip=await Zip.loadAsync(seed),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 const main=xml.replace(/<(?:x:)?sheetData\b[^>]*>[\s\S]*?<\/(?:x:)?sheetData>/,`<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Girth</x:t></x:is></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Price ${currency}</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>${name}</x:t></x:is></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>${size}</x:t></x:is></x:c><x:c r="C2"><x:v>${price}</x:v></x:c></x:row></x:sheetData>`);
 zip.file('xl/worksheets/sheet1.xml',main);const bytes=await zip.generateAsync({type:'nodebuffer'});await fs.writeFile(path.join(source,'offer.xlsx'),bytes);return createHash('sha256').update(bytes).digest('hex');
}
const sha=await sourceBook(80.5),offer={id:'test-plant',plantId:'p1',nurseryId:'n1',price:80.5,currency:'EUR',circumference:'18-20',height:'',image:'unchanged.jpg',sourceEvidence:{archivePath:'Rasadnici ponude/offer.xlsx',sourceSha256:sha,sheet:'Preporuka',priceCell:'C2'},priceEvidence:{amount:80.5,priceCell:'C2',sheet:'Preporuka'}};
await fs.writeFile(path.join(repo,'data/kataloske-stavke.json'),JSON.stringify({sourcePolicy:{nonPhoto:'rasadnici-ponude-zip',onlineUpdates:['photos']},offers:[offer]}));
const options={source,repo,stateFile:path.join(temp,'state.json'),reportFile:path.join(temp,'report.json'),apply:true,now:'2026-11-13T06:00:00Z'};
let run=await refreshFolder(options);assert.equal(run.report.verified,1);assert.equal(run.report.updated,0);assert.equal(run.report.anchoredRows,1);
await sourceBook(92);run=await refreshFolder(options);assert.equal(run.report.updated,1);assert.equal(run.document.offers[0].price,92);assert.equal(run.document.offers[0].image,'unchanged.jpg');assert.equal(run.document.offers[0].priceEvidence.folderUpdate.previousAmount,80.5);
await sourceBook(30,"Acer campestre 'Elegant'");run=await refreshFolder(options);assert.equal(run.report.updated,0);assert.equal(run.report.pending.length,1);assert.equal(run.document.offers[0].price,92);assert.equal(run.document.offers[0].priceRefresh.status,'pending');
await sourceBook(30,"Acer campestre 'Elsrijk'",'12-14');run=await refreshFolder(options);assert.equal(run.report.updated,0);assert.equal(run.document.offers[0].price,92);
// An amount may change while its cell stays General. Currency text must still
// prevent importing dinars under the unchanged catalogue's EUR currency.
await sourceBook(95);
{
 const file=path.join(source,'offer.xlsx'),zip=await Zip.loadAsync(await fs.readFile(file));
 const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 zip.file('xl/worksheets/sheet1.xml',xml.replace('<x:c r="C2"><x:v>95</x:v></x:c>','<x:c r="C2" t="inlineStr"><x:is><x:t>95 RSD</x:t></x:is></x:c>'));
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
}
run=await refreshFolder(options);assert.equal(run.report.updated,0);assert.equal(run.document.offers[0].price,92);assert.equal(run.document.offers[0].currency,'EUR');assert.match(run.report.pending[0].reason,/valuta/);
const before=await fs.readFile(path.join(repo,'data/kataloske-stavke.json'),'utf8');await assert.rejects(refreshFolder({...options,source:path.join(temp,'missing')}));assert.equal(await fs.readFile(path.join(repo,'data/kataloske-stavke.json'),'utf8'),before);
// A converted public price is never used as the original spreadsheet anchor.
// This also repairs a legacy private state that remembered EUR before the audit.
const rsdSha=await sourceBook(5800,undefined,undefined,'RSD');
const rsdOffer=normalizeOfferCurrency({...offer,sourceEvidence:{...offer.sourceEvidence,sourceSha256:rsdSha},priceEvidence:{...offer.priceEvidence,amount:5800,currency:'RSD'}},rates,{sourceAmount:5800,sourceCurrency:'RSD',now:options.now});
await fs.writeFile(path.join(repo,'data/kataloske-stavke.json'),JSON.stringify({sourcePolicy:{nonPhoto:'rasadnici-ponude-zip'},offers:[rsdOffer]}));
const eur=(value,rate=rates.rate)=>Math.round((value/rate+Number.EPSILON)*100)/100;
run=await refreshFolder(options);assert.equal(run.report.verified,1);assert.equal(run.report.pending.length,0);assert.equal(run.document.offers[0].price,eur(5800));assert.equal(run.document.offers[0].sourceAmount,5800);assert.equal(run.document.offers[0].sourceCurrency,'RSD');
assert.equal(JSON.parse(await fs.readFile(options.stateFile,'utf8')).rows[offer.id].priceCurrency,'RSD');
await sourceBook(6200,undefined,undefined,'RSD');
run=await refreshFolder(options);assert.equal(run.report.updated,1);assert.equal(run.document.offers[0].price,eur(6200));assert.equal(run.document.offers[0].currency,'EUR');assert.equal(run.document.offers[0].sourceAmount,6200);assert.equal(run.document.offers[0].sourceCurrency,'RSD');assert.equal(run.document.offers[0].priceEvidence.amount,6200);assert.equal(run.document.offers[0].priceEvidence.currency,'RSD');assert.equal(run.document.offers[0].priceEvidence.folderUpdate.previousAmount,5800);assert.equal(run.report.changes[0].sourceBefore,5800);assert.equal(run.report.changes[0].sourceAfter,6200);assert.equal(run.document.offers[0].image,'unchanged.jpg');
run=await refreshFolder(options);assert.equal(run.report.updated,0);assert.equal(run.report.pending.length,0);assert.equal(run.document.offers[0].price,eur(6200),'Repeated refresh must not divide EUR again');
const newerRates={...rates,rate:117.5,rateDate:'2026-11-14'};await fs.writeFile(path.join(repo,'data/exchange-rates.json'),JSON.stringify(newerRates));
run=await refreshFolder({...options,now:'2026-11-14T07:00:00Z'});assert.equal(run.document.offers[0].price,eur(6200,newerRates.rate));assert.equal(run.document.offers[0].sourceAmount,6200);assert.equal(run.report.updated,0,'A rate change does not change the supplier source amount');
// A consistent supplier currency change is automatic when only the currency
// label changes and every plant/measure/price-basis anchor remains identical.
await sourceBook(60,undefined,undefined,'EUR');
run=await refreshFolder(options);assert.equal(run.report.updated,1);assert.equal(run.report.pending.length,0);assert.equal(run.document.offers[0].price,60);assert.equal(run.document.offers[0].sourceAmount,60);assert.equal(run.document.offers[0].sourceCurrency,'EUR');assert.equal(run.document.offers[0].priceConversion,undefined);
run=await refreshFolder(options);assert.equal(run.report.updated,0);assert.equal(run.document.offers[0].price,60);
// An explicit source currency outranks a wrong legacy public EUR label.
const correctedSha=await sourceBook(5800,undefined,undefined,'RSD');
await fs.writeFile(path.join(repo,'data/kataloske-stavke.json'),JSON.stringify({sourcePolicy:{nonPhoto:'rasadnici-ponude-zip'},offers:[{...offer,price:5800,currency:'EUR',priceEvidence:{...offer.priceEvidence,amount:5800},sourceEvidence:{...offer.sourceEvidence,sourceSha256:correctedSha}}]}));
run=await refreshFolder(options);assert.equal(run.document.offers[0].price,eur(5800,newerRates.rate));assert.equal(run.document.offers[0].sourceCurrency,'RSD');assert.equal(run.document.offers[0].currency,'EUR');
const unsupportedSha=await sourceBook(80,undefined,undefined,'GBP');
await fs.writeFile(path.join(repo,'data/kataloske-stavke.json'),JSON.stringify({sourcePolicy:{nonPhoto:'rasadnici-ponude-zip'},offers:[{...offer,price:80,currency:'GBP',sourceEvidence:{...offer.sourceEvidence,sourceSha256:unsupportedSha},priceEvidence:{...offer.priceEvidence,amount:80,currency:'GBP'}}]}));
run=await refreshFolder(options);assert.equal(run.document.offers[0].price,null);assert.equal(run.document.offers[0].currency,'');assert.equal(run.report.pending.length,1,'Unsupported currency cannot become a raw EUR amount');
assert.equal(amount('€ 1.234,56'),1234.56);assert.equal(amount('42,50 EUR'),42.5);assert.equal(amount('price on request'),null);assert.equal(amount('0'),null);assert.equal(amount('-12'),null);
console.log(JSON.stringify({ok:true,unchangedSourceVerified:true,exactRowPriceUpdated:true,wrongCultivarRejected:true,wrongMeasureRejected:true,conflictingPriceCurrencyRejected:true,missingFolderPreservesData:true,photosPreserved:true,originalRsdAnchorPreserved:true,rsdSourceChangeConverted:true,repeatedConversionIdempotent:true,newRateUsesOriginalAmount:true,consistentSourceCurrencyChangeConverted:true,explicitSourceCurrencyWins:true,unsupportedCurrencyNotPublished:true},null,2));

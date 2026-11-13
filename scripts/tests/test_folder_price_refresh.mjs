import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {refreshFolder,amount} from '../refresh_folder_prices.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url),Zip=require(root+'/assets/vendor/jszip-3.10.1.min.js');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'demetra-price-test-')),source=path.join(temp,'source'),repo=path.join(temp,'repo');
await fs.mkdir(source);await fs.mkdir(path.join(repo,'data'),{recursive:true});
const seed=await fs.readFile(root+'/assets/brza-preporuka-template.xlsx');
async function sourceBook(price,name="Acer campestre 'Elsrijk'",size='18-20'){
 const zip=await Zip.loadAsync(seed),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
 const main=xml.replace(/<(?:x:)?sheetData\b[^>]*>[\s\S]*?<\/(?:x:)?sheetData>/,`<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Girth</x:t></x:is></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Price EUR</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>${name}</x:t></x:is></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>${size}</x:t></x:is></x:c><x:c r="C2"><x:v>${price}</x:v></x:c></x:row></x:sheetData>`);
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
assert.equal(amount('€ 1.234,56'),1234.56);assert.equal(amount('42,50 EUR'),42.5);assert.equal(amount('price on request'),null);assert.equal(amount('0'),null);assert.equal(amount('-12'),null);
console.log(JSON.stringify({ok:true,unchangedSourceVerified:true,exactRowPriceUpdated:true,wrongCultivarRejected:true,wrongMeasureRejected:true,changedPriceCurrencyRejected:true,missingFolderPreservesData:true,photosPreserved:true},null,2));

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareMorningPrices,preserveMorningPriceScope} from '../prepare_morning_prices.mjs';
import {normalizeOfferCurrency} from '../currency-normalization.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url),XLSX=require(root+'/assets/vendor/xlsx-0.20.3.full.min.js');
const rates={schemaVersion:1,base:'EUR',quote:'RSD',rate:117.6203,rateDate:'2026-11-13',source:'NBS official middle rate',sourceUrl:'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate',fetchedAt:'2026-11-13T07:00:00Z'};
const sha='a'.repeat(64),now='2026-11-17T07:00:00Z';
const offer={id:'offer-1',plantId:'plant-1',nurseryId:'nursery-1',circumference:'18-20',unit:'kom',price:80.5,currency:'EUR',sourceAmount:80.5,sourceCurrency:'EUR',image:'assets/biljke/same.jpg',priceEvidence:{amount:80.5,currency:'EUR'},sourceCurrencyEvidence:{origin:'reviewed_document',sourceSha256:sha},priceRefresh:{status:'verified',checkedAt:'2026-11-16T07:00:00Z',sourceSha256:sha}};
const document=()=>({sourcePolicy:{nonPhoto:'rasadnici-ponude-zip',onlineUpdates:['photos']},updatedAt:'2026-11-16T07:00:00Z',offers:[structuredClone(offer)]});
const report=()=>({updated:0,changes:[],pending:[],startedAt:now});

test('unchanged source retains all price proof and conversion bytes while advancing verification',()=>{
  const before=document();
  normalizeOfferCurrency(before.offers[0],rates,{sourceAmount:5800,sourceCurrency:'RSD',now:'2026-11-13T07:00:00Z'});
  const after=structuredClone(before);
  normalizeOfferCurrency(after.offers[0],{...rates,rate:110,rateDate:'2026-11-17'},{sourceEvidence:{origin:'new_cell_description'},now});
  after.offers[0].priceRefresh.checkedAt=now;after.updatedAt=now;
  assert.notEqual(after.offers[0].price,before.offers[0].price);
  assert.equal(preserveMorningPriceScope(before,after,report()).preservedRecords,1);
  assert.deepEqual(after.offers[0],{...before.offers[0],priceRefresh:{...before.offers[0].priceRefresh,checkedAt:now}});
});

test('pending unsupported-currency attempt cannot null or relabel a reviewed price',()=>{
  const before=document(),after=structuredClone(before),r=report();
  normalizeOfferCurrency(after.offers[0],rates,{sourceAmount:90,sourceCurrency:'GBP',now});
  after.offers[0].priceRefresh={...after.offers[0].priceRefresh,status:'pending',attemptedAt:now,reason:'Unsupported currency'};
  r.pending=[{offerId:offer.id}];
  preserveMorningPriceScope(before,after,r);
  assert.equal(after.offers[0].price,80.5);assert.equal(after.offers[0].currency,'EUR');
  assert.equal(after.offers[0].sourceAmount,80.5);assert.equal(after.offers[0].sourceCurrency,'EUR');
  assert.equal(after.offers[0].priceConversion,undefined);assert.equal(after.offers[0].priceRefresh.status,'pending');
});

test('offer identity, photo, parameter changes and unsupported claimed updates fail closed',()=>{
  for(const [field,value] of [['image','wrong.jpg'],['circumference','12-14'],['id','other-offer']]){
    const before=document(),after=structuredClone(before);after.offers[0][field]=value;
    assert.throws(()=>preserveMorningPriceScope(before,after,report()));
  }
  const before=document(),after=structuredClone(before),r=report();
  after.offers[0].price=92;after.offers[0].sourceAmount=92;
  r.updated=1;r.changes=[{offerId:offer.id,before:80.5,after:92,sourceBefore:80.5,sourceAfter:92,sourceCurrency:'EUR',cell:'C2'}];
  assert.throws(()=>preserveMorningPriceScope(before,after,r),/dokaz/);
  assert.throws(()=>preserveMorningPriceScope(document(),document(),{...report(),updated:1}),/usklađen/);
});

test('real spreadsheet preparation preserves baseline evidence and rate bytes, then permits an exact source-price change',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'demetra-morning-prepare-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const source=path.join(temp,'source'),work=path.join(temp,'work');await fs.mkdir(source);
  async function workbook(price,name="Acer campestre 'Elsrijk'"){
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Plant','Girth','Price EUR'],[name,'18-20',price]]),'Offer');
    const bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx'});await fs.writeFile(path.join(source,'offer.xlsx'),bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }
  const sourceSha=await workbook(80.5),baseline=document();
  Object.assign(baseline.offers[0],{sourceEvidence:{archivePath:'Rasadnici ponude/offer.xlsx',sourceSha256:sourceSha,sheet:'Offer',priceCell:'C2'},priceEvidence:{amount:80.5,currency:'EUR',sheet:'Offer',priceCell:'C2'},priceRefresh:{...offer.priceRefresh,sourceSha256:sourceSha}});
  const baseCommit='b'.repeat(40),rateText=JSON.stringify(rates,null,4)+'\n\n',urls=[];
  const fetchImpl=async url=>{
    urls.push(url);
    if(url.endsWith('/git/ref/heads/main'))return new Response(JSON.stringify({object:{sha:baseCommit}}));
    assert.ok(url.includes('/'+baseCommit+'/data/'),'Every snapshot must be pinned to the same SHA');
    return new Response(url.endsWith('/exchange-rates.json')?rateText:JSON.stringify(baseline));
  };
  const first=await prepareMorningPrices({work,source,fetchImpl});
  assert.deepEqual(first.files,['data/kataloske-stavke.json','data/price-sync-status.json']);
  assert.deepEqual(first.readOnlySnapshotFiles,['data/exchange-rates.json']);assert.equal(first.published,false);
  assert.equal(first.verified,1);assert.equal(first.changed,0);assert.equal(first.preservation.preservedRecords,1);
  const firstData=JSON.parse(await fs.readFile(path.join(work,'prepared/data/kataloske-stavke.json'),'utf8'));
  assert.deepEqual(firstData.offers[0].sourceCurrencyEvidence,baseline.offers[0].sourceCurrencyEvidence);
  assert.deepEqual({...firstData.offers[0],priceRefresh:baseline.offers[0].priceRefresh},baseline.offers[0]);
  assert.equal(await fs.readFile(path.join(work,'prepared/data/exchange-rates.json'),'utf8'),rateText);
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(source,'offer.xlsx'))).digest('hex'),sourceSha,'Original business file stays byte-identical');
  await workbook(92);
  const changed=await prepareMorningPrices({work,source,fetchImpl});
  const changedData=JSON.parse(await fs.readFile(path.join(work,'prepared/data/kataloske-stavke.json'),'utf8'));
  assert.equal(changed.changed,1);assert.equal(changed.preservation.confirmedSourceChanges,1);
  assert.equal(changedData.offers[0].price,92);assert.equal(changedData.offers[0].sourceAmount,92);
  assert.equal(changedData.offers[0].priceEvidence.folderUpdate.method,'unchanged-identity-row-and-header');
  assert.equal(changedData.offers[0].image,baseline.offers[0].image);
  await workbook(99,"Acer campestre 'Elegant'");
  const rejected=await prepareMorningPrices({work,source,fetchImpl});
  const rejectedData=JSON.parse(await fs.readFile(path.join(work,'prepared/data/kataloske-stavke.json'),'utf8'));
  assert.equal(rejected.changed,0);assert.equal(rejected.pending,1);assert.equal(rejectedData.offers[0].price,80.5);
  assert.equal(await fs.readFile(path.join(work,'prepared/data/exchange-rates.json'),'utf8'),rateText);
  assert.ok(urls.every(url=>!url.includes('/git/blobs')),'Preparation cannot publish');
});

test('--publish is rejected before reading sources or regenerating reviewed data',()=>{
  const result=spawnSync(process.execPath,[path.join(root,'scripts/prepare_morning_prices.mjs'),'--publish'],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/samo priprema podatke/);
});

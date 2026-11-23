#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {refreshFolder} from './refresh_folder_prices.mjs';
import {getSourcePrice} from './currency-normalization.mjs';
import {auditArchiveCoverage} from './audit_archive_coverage.mjs';

const repository='kristinasunshine-beep/demetra-rb-index';
const priceFields=['price','currency','currencyStatus','currencyEvidence','sourceAmount','sourceCurrency','sourceCurrencyEvidence','priceConversion','priceEvidence'];
const without=(value,fields)=>Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)));

// A folder check is not a new currency audit. Normalization can refresh proof or
// conversions even when the original supplier amount has not changed. Preserve
// the reviewed baseline in that case, including records held pending for review.
export function preserveMorningPriceScope(before,after,report){
  if(!Array.isArray(before.offers)||!Array.isArray(after.offers)||before.offers.length!==after.offers.length)throw new Error('Promenjen broj zapisa tokom cenovnog ažuriranja.');
  if(!isDeepStrictEqual(without(before,['offers','updatedAt']),without(after,['offers','updatedAt'])))throw new Error('Promenjeni podaci izvan cenovnih zapisa.');
  const changes=new Map((report.changes||[]).map(change=>[change.offerId,change]));
  if(changes.size!==(report.changes||[]).length||changes.size!==report.updated)throw new Error('Izveštaj promenjenih cena nije usklađen.');
  const pending=new Set((report.pending||[]).map(item=>item.offerId));
  const seen=new Set();let preservedRecords=0;
  for(let i=0;i<before.offers.length;i++){
    const previous=before.offers[i],candidate=after.offers[i];
    if(!previous.id||seen.has(previous.id)||previous.id!==candidate.id)throw new Error('Promenjen identitet ili redosled cenovnih zapisa.');
    seen.add(previous.id);
    if(!isDeepStrictEqual(without(previous,[...priceFields,'priceRefresh']),without(candidate,[...priceFields,'priceRefresh'])))throw new Error('Ažuriranje pokušava da promeni podatke izvan cene: '+previous.id);
    const change=changes.get(previous.id);
    if(!change){
      if(priceFields.some(key=>!isDeepStrictEqual(previous[key],candidate[key])||Object.hasOwn(previous,key)!==Object.hasOwn(candidate,key)))preservedRecords++;
      for(const key of priceFields){
        if(Object.hasOwn(previous,key))candidate[key]=structuredClone(previous[key]);
        else delete candidate[key];
      }
      continue;
    }
    const original=getSourcePrice(previous),updated=getSourcePrice(candidate),proof=candidate.priceEvidence?.folderUpdate;
    if(pending.has(previous.id)||candidate.priceRefresh?.status!=='verified'||!Number.isFinite(candidate.price)||candidate.price<=0||candidate.currency!=='EUR'||
      change.sourceBefore!==original.amount||change.sourceAfter!==updated.amount||change.sourceCurrency!==updated.currency||
      (original.amount===updated.amount&&original.currency===updated.currency)||change.before!==previous.price||change.after!==candidate.price||
      proof?.method!=='unchanged-identity-row-and-header'||proof.sourceSha256!==candidate.priceRefresh.sourceSha256||
      !/^[a-f0-9]{64}$/.test(proof.sourceSha256||'')||!proof.rowSignature||!proof.headerSignature||proof.priceCell!==change.cell||
      candidate.priceEvidence.amount!==updated.amount||candidate.priceEvidence.currency!==updated.currency){
      throw new Error('Promena nema usklađen dokaz izvorne cene: '+previous.id);
    }
  }
  for(const id of changes.keys())if(!seen.has(id))throw new Error('Izveštaj sadrži nepoznat cenovni zapis: '+id);
  return {preservedRecords,confirmedSourceChanges:changes.size};
}

export async function prepareMorningPrices({work,source,fetchImpl=fetch}){
  if(!work||!source)throw new Error('Navedite lokalni radni folder i folder ponuda.');
  const headers={'User-Agent':'DemetraRB-Price-Sync/1.0','Accept':'application/vnd.github+json'};
  if(process.env.GITHUB_TOKEN)headers.Authorization='Bearer '+process.env.GITHUB_TOKEN;
  const api='https://api.github.com/repos/'+repository;
  async function read(url){const response=await fetchImpl(url,{headers});if(!response.ok)throw new Error('GitHub pristup nije uspeo: HTTP '+response.status);return response;}
  await fs.mkdir(work,{recursive:true});
  const lockFile=path.join(work,'morning.lock');let lock;
  try{lock=await fs.open(lockFile,'wx');}catch{throw new Error('Prethodna jutarnja obrada još traje.');}
  try{
    const head=await (await read(api+'/git/ref/heads/main')).json();
    const run=path.join(work,'prepared'),dataDir=path.join(run,'data');await fs.mkdir(dataDir,{recursive:true});
    // Both documents come from the same immutable commit. The exchange-rate
    // document is a read-only input and is never part of the publication set.
    const snapshots=await Promise.all(['kataloske-stavke.json','exchange-rates.json'].map(async name=>({name,text:await (await read(`https://raw.githubusercontent.com/${repository}/${head.object.sha}/data/${name}`)).text()})));
    for(const snapshot of snapshots)await fs.writeFile(path.join(dataDir,snapshot.name),snapshot.text);
    const original=snapshots.find(s=>s.name==='kataloske-stavke.json').text;
    const rateSnapshot=snapshots.find(s=>s.name==='exchange-rates.json');
    const {report}=await refreshFolder({source,repo:run,stateFile:path.join(work,'private-price-state.json'),reportFile:path.join(work,'last-price-report.json'),apply:true});
    const before=JSON.parse(original),after=JSON.parse(await fs.readFile(path.join(dataDir,'kataloske-stavke.json'),'utf8'));
    const preservation=preserveMorningPriceScope(before,after,report);
    if(await fs.readFile(path.join(dataDir,'exchange-rates.json'),'utf8')!==rateSnapshot.text)throw new Error('Jutarnja provera ne sme da promeni potvrđeni kurs.');
    // Keep a single JSON file uploadable in GitHub's browser after the archive grows.
    const prettyCatalog=JSON.stringify(after,null,2)+'\n';
    const catalogText=Buffer.byteLength(prettyCatalog)>20*1024*1024?JSON.stringify(after)+'\n':prettyCatalog;
    await fs.writeFile(path.join(dataDir,'kataloske-stavke.json'),catalogText);
    const archiveReview=await auditArchiveCoverage({source,catalog:after,ledgerFile:path.join(work,'archive-review-ledger.json')});
    await fs.writeFile(path.join(work,'archive-coverage-report.json'),JSON.stringify(archiveReview,null,2)+'\n');
    report.archiveCoverage={complete:archiveReview.catalogReviewComplete,unreviewedFiles:archiveReview.unreviewedFiles.length,uniqueDocuments:archiveReview.uniqueDocuments,reportFile:'archive-coverage-report.json'};
    await fs.writeFile(path.join(work,'last-price-report.json'),JSON.stringify(report,null,2)+'\n');
    const statusPath=path.join(dataDir,'price-sync-status.json');
    const publicStatus=JSON.parse(await fs.readFile(statusPath,'utf8'));
    publicStatus.catalogReviewComplete=archiveReview.catalogReviewComplete;
    publicStatus.unreviewedSourceFiles=archiveReview.unreviewedFiles.length;
    await fs.writeFile(statusPath,JSON.stringify(publicStatus,null,2)+'\n');
    const manifest={archiveCoverage:report.archiveCoverage,preparedAt:new Date().toISOString(),repository,baseCommit:head.object.sha,files:['data/kataloske-stavke.json','data/price-sync-status.json'],readOnlySnapshotFiles:['data/exchange-rates.json'],verified:report.verified,changed:report.updated,pending:report.pending.length,newSources:report.newFiles.length,exchangeRateDate:JSON.parse(rateSnapshot.text).rateDate,preservation,published:false};
    await fs.writeFile(path.join(work,'prepared-update.json'),JSON.stringify(manifest,null,2)+'\n');
    return manifest;
  }finally{await lock.close();await fs.unlink(lockFile);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
  // Publication must use the already-reviewed bytes with an expected main SHA;
  // regenerating them as part of a --publish call would invalidate that review.
  if(args.includes('--publish'))throw new Error('Ova skripta samo priprema podatke. Objavite već pregledane datoteke povezanim GitHub pristupom, uz proveru baseCommit.');
  console.log(JSON.stringify(await prepareMorningPrices({work:get('--work'),source:get('--source')||process.env.DEMETRA_SOURCE_FOLDER}),null,2));
}


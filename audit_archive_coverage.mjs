import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const extensions=new Set(['.pdf','.xlsx','.xls','.xlsm','.xlsb','.ods','.csv','.tsv','.jpg','.jpeg','.png']);
const closedDispositions=new Set(['reconciled','photo_only','terms_only','inquiry_without_price','not_a_supplier_offer']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// A known file or even a linked row is NOT a proof that every source row was reviewed.
// This private ledger is keyed by content hash, so renamed/copy files share review.
export async function auditArchiveCoverage({source,catalog,ledgerFile}) {
  let ledger={documents:[]};
  if(ledgerFile)try{ledger=JSON.parse(await fs.readFile(ledgerFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!Array.isArray(ledger.documents))throw new Error('Neispravan privatni registar pregleda arhive.');
  const scopeFingerprint=digest(JSON.stringify([...new Set(catalog.offers.map(o=>o.plantId).filter(Boolean))].sort()));
  const scopeCurrent=ledger.scopeFingerprint===scopeFingerprint;
  const offerIds=new Set(catalog.offers.filter(o=>!['needs_review','superseded'].includes(o.recordStatus)).map(o=>o.id));
  const byHash=new Map();
  for(const offer of catalog.offers){const e=offer.sourceEvidence||{},p=offer.priceEvidence||{},sha=e.sourceSha256||p.sourceSha256||p.sha256;if(!sha)continue;if(!byHash.has(sha))byHash.set(sha,[]);byHash.get(sha).push(offer);}
  const files=[];
  async function visit(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink()||e.name.startsWith('~$'))continue;const full=path.join(dir,e.name);if(e.isDirectory())await visit(full);else if(extensions.has(path.extname(e.name).toLowerCase())){
    const sha256=digest(await fs.readFile(full)),offers=byHash.get(sha256)||[],review=ledger.documents.find(x=>x.sha256===sha256);
    const rows=review?.rows||[],pendingRows=rows.filter(x=>!['represented','added','duplicate','excluded','unpriced','not_available','non_offer'].includes(x.disposition)||(['represented','added'].includes(x.disposition)&&![...(x.offerIds||[]),...(x.existingOfferIds||[]),x.offerId].some(id=>offerIds.has(id))));
    const complete=Boolean(scopeCurrent&&review?.reviewedAt&&closedDispositions.has(review.disposition)&&review.allRowsReviewed===true&&pendingRows.length===0);
    files.push({path:path.relative(source,full).replaceAll('\\','/'),sha256,linkedOfferIds:offers.map(x=>x.id),reviewed:complete,disposition:review?.disposition||'unreviewed',pendingRows:pendingRows.length});
  }}}
  await visit(source);
  const groups=new Map();for(const f of files){if(!groups.has(f.sha256))groups.set(f.sha256,[]);groups.get(f.sha256).push(f.path);}
  return {schemaVersion:1,scopeFingerprint,reviewedScopeMatches:scopeCurrent,checkedAt:new Date().toISOString(),files:files.length,uniqueDocuments:groups.size,duplicateFiles:files.length-groups.size,catalogReviewComplete:files.every(x=>x.reviewed),unreviewedFiles:files.filter(x=>!x.reviewed).map(x=>({path:x.path,sha256:x.sha256,linkedOffers:x.linkedOfferIds.length,disposition:x.disposition,pendingRows:x.pendingRows})),inventory:files};
}


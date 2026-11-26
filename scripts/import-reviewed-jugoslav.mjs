import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {normalizeOfferCurrency,checkNormalizedPrices,loadExchangeRates} from './currency-normalization.mjs';
const root=process.cwd(), manifestPath='docs/import-jugoslav-2026-08.json';
const read=async p=>JSON.parse(await fs.readFile(path.join(root,p),'utf8'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const norm=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[‘’'"\x60]/g,'').replace(/×/g,'x').replace(/\s+/g,' ').trim();
const manifest=await read(manifestPath);
const [plants,nurseries,offers,scope,config,rates,exclusions]=await Promise.all([read('data/biljke.json'),read('data/rasadnici.json'),read('data/kataloske-stavke.json'),read('scripts/catalog-scope.json'),read('scripts/price-sources.json'),loadExchangeRates(root),read('scripts/catalog-exclusions.json')]);
const original=JSON.stringify([plants,nurseries,offers,scope,config]);
const now=new Date().toISOString();
assert.equal(manifest.rows.length,33);assert.equal(new Set(manifest.rows.map(r=>r.row)).size,33);
assert.match(manifest.sourceSha256,/^[a-f0-9]{64}$/);
const nursery=nurseries.nurseries.find(n=>n.id===manifest.nurseryId);
assert(nursery,'Existing reviewed nursery identity missing');assert.equal(nursery.name,manifest.nurseryName);
assert.equal(nursery.country,manifest.country);
const sourceId='src-'+manifest.sourceSha256.slice(0,14);
const report={source:manifest.sourceFile,sourceSha256:manifest.sourceSha256,sourcePeriod:manifest.sourcePeriod,rate:rates.rate,rateDate:rates.rateDate,createdPlants:[],existingPlants:[],newOffers:[],existingOffers:[],noOffer:[],duplicates:[]};
const handled=new Set(),plantSeen=new Set(),newIds=new Set(),allOfferIds=new Set(offers.offers.map(o=>o.id));
for(const row of manifest.rows){
  const name=row.latinName.trim(), key=norm(name);
  assert(name&&row.request&&Number.isInteger(row.row));
  const matches=plants.plants.filter(p=>[p.latinName,...(p.synonyms||[])].some(v=>norm(v)===key));
  assert(matches.length<=1,'Ambiguous exact botanical name: '+name);
  let plant=matches[0];
  if(!plant){
    const id='plant-'+hash(key).slice(0,14);
    assert(!plants.plants.some(p=>p.id===id),'Plant ID collision');
    plant={id,latinName:name,commonName:'',category:'Biljka',description:'',synonyms:[],searchAliases:[],demo:false};
    plants.plants.push(plant);scope.plants.push({id,latinName:name,offerEvidence:[]});config.scope.allowedPlantIds.push(id);
    report.createdPlants.push({id,name});newIds.add(id);
  }else if(!plantSeen.has(plant.id)&&!newIds.has(plant.id))report.existingPlants.push({id:plant.id,name:plant.latinName});
  plantSeen.add(plant.id);
  const proof=scope.plants.find(p=>p.id===plant.id);assert(proof&&proof.latinName===plant.latinName);
  const evidence={id:'occ-'+hash(manifest.sourceSha256+'|'+manifest.sheet+'|A'+row.row).slice(0,20),sourceId,row:row.row,rawNameSha256:hash(row.request)};
  if(!proof.offerEvidence.some(e=>e.id===evidence.id))proof.offerEvidence.push(evidence);
  if(!row.offered.trim()){report.noOffer.push({row:row.row,name:plant.latinName});continue;}
  const m=row.offered.match(/^(?:(\d+(?:[.,]\d+)?)l|(fi\d+))\s*-\s*(\d+)\s*din(?:\s+H(\d+)cm)?$/i);
  assert(m,'Unreviewed supplier cell F'+row.row+': '+row.offered);
  const amount=Number(m[3]),pot=m[1]?m[1].replace(',','.')+' L':'',height=m[4]||'',extra=m[2]?[{label:'Prečnik iz ponude',value:m[2]}]:[];
  const signature=JSON.stringify([plant.id,nursery.id,pot,height,extra,amount]);
  if(handled.has(signature)){report.duplicates.push({row:row.row,name:plant.latinName});continue;}handled.add(signature);
  const sameSource=offers.offers.filter(o=>o.nurseryId===nursery.id&&o.plantId===plant.id&&o.sourceEvidence?.sourceSha256===manifest.sourceSha256&&o.sourceEvidence?.row===row.row);
  assert(sameSource.length<=1,'Existing duplicate source row F'+row.row);
  if(sameSource.length){
    const old=sameSource[0];assert.equal(old.sourceAmount,amount,'Conflicting previously imported source price F'+row.row);
    report.existingOffers.push({row:row.row,id:old.id,name:plant.latinName});continue;
  }
  const id='record-'+hash(manifest.sourceSha256+'|'+manifest.sheet+'|F'+row.row).slice(0,14);
  assert(!allOfferIds.has(id),'Offer ID collision');
  assert(!exclusions.excludedOffers.some(e=>e.offerId===id||e.sourceSha256===manifest.sourceSha256&&e.sheet===manifest.sheet&&e.priceCell==='F'+row.row),'Source row has been explicitly excluded');
  const sourceEvidence={sourceId,sourceFile:manifest.sourceFile,sourceSha256:manifest.sourceSha256,sheet:manifest.sheet,row:row.row,priceCell:'F'+row.row,nameCell:'A'+row.row,parameterRole:'offered',requestedSpecification:row.request,sourceSpecifications:[row.offered],archiveVerified:true};
  const priceEvidence={sourceFile:manifest.sourceFile,sourceSha256:manifest.sourceSha256,sheet:manifest.sheet,priceCell:'F'+row.row,amount,currency:'RSD',raw:row.offered};
  const offer={id,plantId:plant.id,nurseryId:nursery.id,seedlingType:'',circumference:'',height,crownWidth:'',rootBall:'',potSize:pot,rootType:pot?'Kontejner':'',additionalParameters:extra,price:amount,currency:'RSD',currencyStatus:'stated',sourceAmount:amount,sourceCurrency:'RSD',sourceCurrencyEvidence:{origin:'explicit_source_cell',raw:row.offered},priceEvidence,unit:'kom',availability:'Proveriti dostupnost',source:manifest.sourceFile,sourceDate:'',sourcePeriod:manifest.sourcePeriod,priceKind:'historical',priceNote:'Cena iz ponude, avgust 2026; aktuelnost nije potvrđena.',dataOrigin:'rasadnici-ponude-zip',dataAccuracyNote:'Parametri i dinarska cena isključivo iz F'+row.row+'; A'+row.row+' je upit, ne ponuđena mera. Dan u mesecu i količina nisu navedeni.',recordStatus:'active',specification:row.offered,sourceEvidence,demo:false};
  normalizeOfferCurrency(offer,rates,{now});
  offers.offers.push(offer);allOfferIds.add(id);
  report.newOffers.push({row:row.row,id,name:plant.latinName,pot,height,sourceAmount:amount,price:offer.price});
}
assert.equal(plantSeen.size,32);
assert.equal(report.noOffer.length,5);assert.equal(report.duplicates.length,1);
assert.equal(report.newOffers.length+report.existingOffers.length,27);
checkNormalizedPrices(offers,rates);
assert.equal(new Set(plants.plants.map(p=>p.id)).size,plants.plants.length);
assert.equal(new Set(offers.offers.map(o=>o.id)).size,offers.offers.length);
assert.deepEqual([...config.scope.allowedPlantIds].sort(),scope.plants.map(p=>p.id).sort());
assert.deepEqual(plants.plants.map(p=>p.id).sort(),scope.plants.map(p=>p.id).sort());
scope.policy='Biljke se dodaju samo iz dostavljenih i pregledanih ponuda i upita firme. Odobreni uvozi proširuju spisak uz dokaz izvornog reda; jutarnje cenovno ažuriranje ne proširuje spisak.';
const changed=JSON.stringify([plants,nurseries,offers,scope,config])!==original;
if(changed){
  if(report.createdPlants.length)plants.updatedAt=now;
  if(report.newOffers.length)offers.updatedAt=now;
  for(const [p,d] of [['data/biljke.json',plants],['data/kataloske-stavke.json',offers],['scripts/catalog-scope.json',scope],['scripts/price-sources.json',config]])await fs.writeFile(path.join(root,p),JSON.stringify(d,null,2)+'\n');
}
console.log(JSON.stringify({...report,changed},null,2));

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeOfferCurrency,normalizeDocument,getSourcePrice,checkNormalizedPrices,NBS_URL} from '../currency-normalization.mjs';
import {parseNbsRates,updateExchangeRates} from '../update_exchange_rates.mjs';
const rates={schemaVersion:1,base:'EUR',quote:'RSD',rate:117.6203,rateDate:'2026-11-13',sourceUrl:NBS_URL};
const now='2026-11-13T12:00:00Z';
const html='<h3>КУРСНА ЛИСТА БР. 217</h3><p>ФОРМИРАНА НА ДАН 13.11.2026. ГОДИНЕ</p><table><tr><td>EUR</td><td>978</td><td>ЕМУ</td><td>1</td><td>117,6203</td></tr></table>';

test('5800 RSD is 49.31 EUR; repeated conversion and a new rate always use original dinars',()=>{
  const offer={id:'rsd',price:5800,currency:'EUR',priceEvidence:{amount:5800,currency:'RSD'}};
  normalizeOfferCurrency(offer,rates,{now});assert.equal(offer.price,49.31);assert.equal(offer.currency,'EUR');assert.equal(offer.sourceAmount,5800);assert.equal(offer.sourceCurrency,'RSD');assert.equal(offer.priceEvidence.amount,5800);
  const first=structuredClone(offer);normalizeOfferCurrency(offer,rates,{now:'2026-11-14T12:00:00Z'});assert.deepEqual(offer,first);
  normalizeOfferCurrency(offer,{...rates,rate:116,rateDate:'2026-11-14'},{now:'2026-11-14T12:00:00Z'});assert.equal(offer.price,50);assert.equal(getSourcePrice(offer).amount,5800);
});
test('native EUR stays unchanged; unknown currencies are never relabelled as EUR',()=>{
  const eur={id:'eur',price:5800,currency:'EUR'},unknown={id:'unknown',price:5800,currency:''};
  normalizeOfferCurrency(eur,rates);assert.equal(eur.price,5800);assert.equal(eur.sourceCurrency,'EUR');assert.equal(eur.priceConversion,undefined);
  normalizeOfferCurrency(unknown,rates);assert.equal(unknown.price,null);assert.equal(unknown.sourceAmount,5800);assert.equal(unknown.priceConversion.status,'unresolved');
  assert.throws(()=>checkNormalizedPrices({offers:[{...eur,sourceCurrency:'RSD'}]},rates),/konverzije/);
});
test('source price change from RSD to EUR replaces the conversion instead of dividing again',()=>{
  const offer={id:'change',price:5800,currency:'RSD'};normalizeOfferCurrency(offer,rates,{now});
  normalizeOfferCurrency(offer,rates,{sourceAmount:60,sourceCurrency:'EUR',now});assert.equal(offer.price,60);assert.equal(offer.sourceAmount,60);assert.equal(offer.sourceCurrency,'EUR');assert.equal(offer.priceConversion,undefined);
});
test('NBS extraction checks date, EUR unit and exact numeric rate',()=>{
  const parsed=parseNbsRates(html,now);assert.equal(parsed.rate,117.6203);assert.equal(parsed.rateDate,'2026-11-13');assert.equal(parsed.listNumber,'217');
  assert.throws(()=>parseNbsRates(html.replace('<td>1</td>','<td>100</td>'),now),/jedinica/);
  assert.throws(()=>parseNbsRates(html.replace('117,6203','117,6203 EUR'),now),/format/);
  assert.throws(()=>parseNbsRates(html.replace('13.11.2026','01.01.2020'),now),/datum/);
  assert.throws(()=>parseNbsRates(html.replace('13.11.2026','31.02.2026'),'2026-03-04T12:00:00Z'),/kurs/);
  assert.throws(()=>parseNbsRates('<html>Access denied</html>',now),/datum/);
});
test('failed NBS download changes no file; unchanged rate and normalized prices create no changes',async()=>{
  const repo=await fs.mkdtemp(path.join(os.tmpdir(),'demetra-fx-test-'));try{
    await fs.mkdir(path.join(repo,'data'));const doc={offers:[{id:'rsd',price:5800,currency:'RSD'},{id:'eur',price:80.5,currency:'EUR'}]};normalizeDocument(doc,rates,{now});
    const rateText=JSON.stringify(rates,null,2)+'\n',offerText=JSON.stringify(doc,null,2)+'\n';await fs.writeFile(path.join(repo,'data/exchange-rates.json'),rateText);await fs.writeFile(path.join(repo,'data/kataloske-stavke.json'),offerText);
    await assert.rejects(()=>updateExchangeRates(repo,{now,fetchImpl:async()=>{throw new Error('offline');}}),/offline/);
    assert.equal(await fs.readFile(path.join(repo,'data/exchange-rates.json'),'utf8'),rateText);assert.equal(await fs.readFile(path.join(repo,'data/kataloske-stavke.json'),'utf8'),offerText);
    const report=await updateExchangeRates(repo,{now,fetchImpl:async()=>({ok:true,text:async()=>html})});assert.equal(report.changed,0);assert.equal(report.rateChanged,false);
    assert.equal(await fs.readFile(path.join(repo,'data/kataloske-stavke.json'),'utf8'),offerText);
  }finally{assert.equal(path.dirname(path.resolve(repo)),path.resolve(os.tmpdir()));assert(path.basename(repo).startsWith('demetra-fx-test-'));await fs.rm(repo,{recursive:true,force:true});}
});

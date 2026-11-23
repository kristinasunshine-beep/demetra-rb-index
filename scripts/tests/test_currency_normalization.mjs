import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOfferCurrency,getSourcePrice,checkNormalizedPrices,NBS_URL} from '../currency-normalization.mjs';
const rates={schemaVersion:1,base:'EUR',quote:'RSD',rate:117.6203,rateDate:'2026-11-13',sourceUrl:NBS_URL};
const now='2026-11-13T12:00:00Z';

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

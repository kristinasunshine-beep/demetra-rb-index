import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const read = p => readFile(new URL('../../'+p, import.meta.url), 'utf8');
const json = async p => JSON.parse(await read(p));

test('Control Room integrates existing catalog without demo records', async () => {
  const [plants,nurseries,offers] = await Promise.all([
    json('data/biljke.json'),json('data/rasadnici.json'),json('data/kataloske-stavke.json')]);
  assert.equal(plants.plants.length,619);
  assert.equal(nurseries.nurseries.length,24);
  assert.equal(offers.offers.length,3079);
  assert.equal(new Set(plants.plants.map(p=>p.id)).size,619);
  assert.ok(plants.plants.every(p=>!p.demo));
  assert.ok(offers.offers.every(o=>!o.demo));
});
test('Control Room keeps exact live DOM entry points for navigation and search', async () => {
  const html = await read('index.html');
  for (const id of ['main','plant-search','search-popup','plant-dialog','plant-dialog-content',
    'open-my-quote','open-quick-recommendation','my-quote-view','quick-recommendation-view',
    'my-quote-count','quote-toast']) {
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/class="control-room"/);
  assert.match(html,/assets\/control-room\.css/);
  assert.match(html,/PREDLOZI SE OTVARAJU TOKOM KUCANJA/);
  assert.doesNotMatch(html,/NASUMIČNO ODABRANE BILJKE/);
});
test('Search, all supplier offers, images and quote/Excel modules remain wired', async () => {
  const [html,rec,quote,css] = await Promise.all([read('index.html'),
    read('assets/brza-preporuka.js'),read('assets/moja-ponuda.js'),read('assets/control-room.css')]);
  for (const key of ['function searchPlants','function validateImport','function renderRecord',
    'function renderOffer','function renderEmptyRecord','function makeQuoteItem',
    'function referencePhotoMarkup','function hideFailedPhoto','function submitSearch',
    'function handleSearchInput','function handleRoute','function init()']) {
    assert.ok(html.includes(key),key);
  }
  assert.ok(html.includes("variants.slice(1).map((offer) => renderOffer(offer"));
  assert.ok(html.includes("const photoValue = offer.image || (referenceAllowed ? plant.photo.image : '')"));
  assert.ok(html.includes("const photoMarkup = supplierPhoto ?"));
  assert.ok(html.includes("class=\"offer-price\""));
  assert.ok(html.includes("class=\"quote-add\""));
  assert.ok(rec.includes("new Worker(workerUrl)"));
  assert.ok(rec.includes("postMessage({type:'export'"));
  assert.ok(quote.includes("Core.summarize(quote)"));
  assert.ok(quote.includes("loadZip()"));
  assert.ok(quote.includes("demetra-memorandum-logo.png"));
  assert.ok(quote.includes("demetra-memorandum-standardi.jpg"));
  assert.match(css,/\.detail-hero h2/);
  assert.match(css,/\.offer-pricing \.quote-add/);
  assert.match(css,/@media\(max-width:760px\)/);
});

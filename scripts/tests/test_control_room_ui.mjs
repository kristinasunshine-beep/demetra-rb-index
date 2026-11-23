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
  assert.ok(offers.offers.length >= 3000, 'Izvorni katalog mora zadržati više od 3.000 zapisa; precizan broj prati važeće podatke.');
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

test('The opening sidebar shows only its three workspaces; Back and Home remain in inner views', async () => {
  const [html,quote,rec] = await Promise.all([
    read('index.html'),read('assets/moja-ponuda.js'),read('assets/brza-preporuka.js')
  ]);
  const sidebar = html.match(/<nav class="header-actions"[^>]*>([\s\S]*?)<\/nav>/)?.[1] || '';
  assert(!sidebar.includes('Nazad'), 'Back must not appear on the opening panel');
  assert(!sidebar.includes('⌂ Početna'), 'Home must not be duplicated on the opening panel');
  assert(sidebar.includes('Pretraga') && sidebar.includes('Brza preporuka') && sidebar.includes('Moja ponuda'));
  assert(html.includes('window.DemetraNavigation={back:navigateBack,home:navigateHome,openPlant:navigateToCard}'));
  assert(!html.includes('data-action="record-back"'), 'Plant card must not duplicate the close action');
  assert(!html.includes('data-action="record-home"') && html.includes('data-action="close-record"'));
  assert(!quote.includes('data-quote-action="back"') && !quote.includes('data-quote-action="home"'));
  assert(!rec.includes('id="recommend-back"') && !rec.includes('id="recommend-home"'));
});

test('Navigation and quick recommendation omit unwanted decorative arrows',async()=>{
  const [html,recommend,css,room]=await Promise.all([
    read('index.html'),read('assets/brza-preporuka.js'),read('assets/brza-preporuka.css'),read('assets/control-room.css')
  ]);
  const sidebar=html.match(/<nav class="header-actions"[^>]*>([\s\S]*?)<\/nav>/)?.[1]||'';
  assert.match(sidebar,/<span class="nav-num">01<\/span> Pretraga/);
  assert.match(sidebar,/<span class="nav-num">02<\/span> Brza preporuka/);
  assert.doesNotMatch(sidebar,/<span class="nav-corner">/);
  assert.doesNotMatch(recommend,/recommend-emblem/);
  assert.doesNotMatch(css,/\.recommend-emblem/);
  assert.doesNotMatch(room,/\.recommend-emblem/);
  assert.match(room,/body\.control-room \.recommend-titlebar\{grid-template-columns:minmax\(0,1fr\)\}/);
});

test('Variant selector keeps approved dark green with white text',async()=>{const style=await read('assets/control-room.css');assert.match(style,/supplier-variants > summary\{background:#203E2D!important;color:#FFFFFF!important/);assert.doesNotMatch(style,/supplier-variants>summary\{background:#FA593B/);});

test('The empty quote Find plant shortcut navigates directly to the search bar, never browser history',async()=>{
  const [html,quote]=await Promise.all([read('index.html'),read('assets/moja-ponuda.js')]);
  assert.match(quote,/data-quote-action="find-plant">Pronađi biljku/);
  assert.match(quote,/target\.dataset\.quoteAction === 'find-plant'/);
  assert.match(quote,/DemetraNavigation\.home\(\)/);
  assert.match(quote,/getElementById\('plant-search'\)/);
  assert.match(quote,/search\?\.scrollIntoView/);
  assert.match(quote,/search\?\.focus\(\{preventScroll:true\}\)/);
  assert.doesNotMatch(quote,/data-quote-action="back"/);
  assert.match(html,/moja-ponuda\.js\?v=quote-find-searchbar-20261123/);
});

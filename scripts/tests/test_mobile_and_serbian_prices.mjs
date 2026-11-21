import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

test('Mobile font, long names, parameter grid and cache invalidation are present', () => {
  const html = read('index.html');
  const css = read('assets/control-room-mobile-outline.css');
  const sw = read('service-worker.js');
  assert.match(html, /id="long-query-preview"/);
  assert.match(html, /function syncLongQueryPreview\(\)/);
  assert.match(html, /outline-r6-20261118/);
  assert.ok(css.includes("recommend-titlebar h1 span.outline"));
  assert.ok(css.includes("letter-spacing:-.055em !important"));
  assert.match(html, /id="mobile-outline-no-crossing"/);
  assert.ok(html.includes("letter-spacing:-.055em !important"));
  assert.ok(html.includes('id="demetra-mobile-union-outline"'));
  assert.ok(html.includes('operator="erode" radius="1"'));
  assert.ok(html.includes('operator="out" result="clean-contour"'));
  assert.ok(html.includes('-webkit-text-stroke:0 !important'));
  assert.ok(css.includes('filter:url("#demetra-mobile-union-outline")'));
  assert.ok(!html.includes('letter-spacing:.055em !important'));
  assert.ok(!css.includes('letter-spacing:.055em;'));
  assert.match(css, /quote-titlebar h1 span\.outline/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\) !important/);
  assert.match(sw, /demetra-rb-pwa-shell-08-outline-r6-20261118/);
  assert.match(sw, /cache:'reload'/);
});

test('Quote mobile nursery labels keep whole words and quantity heading is concise', () => {
  const html = read('index.html');
  const js = read('assets/moja-ponuda.js');
  const css = read('assets/control-room.css');
  assert.ok(js.includes('<span class="quote-nursery-name">'));
  assert.ok(js.includes('<small class="quote-nursery-country">'));
  assert.ok(js.includes('<span>Količina</span>'));
  assert.ok(!js.includes('<span>Količina (${escape(item.unit)})</span>'));
  assert.ok(css.includes('Mobile quote nursery labels: full-width words'));
  assert.ok(css.includes('body.control-room .quote-item .quote-nursery'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr);'));
  assert.ok(css.includes('overflow-wrap:normal;'));
  assert.ok(css.includes('word-break:normal;'));
  assert.ok(html.includes('moja-ponuda.js?v=history-20261120'));
  assert.ok(html.includes('control-room.css?v=green-variants-navless-r1-20261121'));
});

test('All 97 priced Žiča and Topalović offers retain audited RSD to EUR conversions', () => {
  const catalog = JSON.parse(read('data/kataloske-stavke.json'));
  const plants = JSON.parse(read('data/biljke.json'));
  const serbian = catalog.offers.filter(o => ['rasadnik-zica', 'topalovic-unresolved'].includes(o.nurseryId));
  const priced = serbian.filter(o => typeof o.price === 'number');
  assert.equal(priced.length, 97, 'Unexpected count of priced Serbian offers');
  for (const offer of priced) {
    assert.equal(offer.sourceCurrency, 'RSD', offer.id);
    assert.equal(offer.currency, 'EUR', offer.id);
    assert.equal(offer.priceConversion?.status, 'converted', offer.id);
    assert.equal(offer.priceConversion?.fromCurrency, 'RSD', offer.id);
    assert.equal(offer.priceConversion?.toCurrency, 'EUR', offer.id);
    assert.equal(offer.priceConversion?.originalAmount, offer.sourceAmount, offer.id);
    assert.ok(offer.priceConversion.rate > 0, offer.id);
    const expected = Math.round((offer.sourceAmount / offer.priceConversion.rate + Number.EPSILON) * 100) / 100;
    assert.ok(Math.abs(expected - offer.price) < .001, offer.id + ': ' + expected + ' vs ' + offer.price);
  }
  const picea = plants.plants.find(p => p.latinName === 'Picea abies');
  assert.ok(picea, 'Picea abies must exist');
  assert.ok(priced.some(o => o.plantId === picea.id), 'Picea abies RSD conversion missing');
});


test('One Home button and no redundant Back button on platform subviews', () => {
  const html=read('index.html'), quote=read('assets/moja-ponuda.js'), recommendation=read('assets/brza-preporuka.js');
  assert.ok(html.includes('data-action="record-home"'));
  assert.ok(!html.includes('data-action="record-back"'));
  assert.ok(quote.includes('data-quote-action="home"'));
  assert.ok(!quote.includes('← Korak nazad'));
  assert.ok(recommendation.includes('id="recommend-home"'));
  assert.ok(!recommendation.includes('id="recommend-back"'));
});

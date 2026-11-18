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
  assert.match(html, /mobile-r3-20261118/);
  assert.match(css, /recommend-titlebar h1 span\.outline/);
  assert.match(css, /quote-titlebar h1 span\.outline/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\) !important/);
  assert.match(sw, /demetra-rb-pwa-shell-05-mobile-r3-20261118/);
  assert.match(sw, /cache:'reload'/);
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

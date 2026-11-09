import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';

// Run the actual HTML renderer. No browser, external packages or fixed record count.
export async function verifyPanels(root) {
  const [html, plantFile, nurseryFile, offerFile] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'data/biljke.json'), 'utf8'),
    readFile(join(root, 'data/rasadnici.json'), 'utf8'),
    readFile(join(root, 'data/kataloske-stavke.json'), 'utf8')
  ]);
  const plants = JSON.parse(plantFile);
  const nurseries = JSON.parse(nurseryFile);
  const offers = JSON.parse(offerFile);
  const core = html.match(/\/\/ BEGIN CATALOG CORE\n([\s\S]*?)\/\/ END CATALOG CORE/);
  const start = html.indexOf('const $ = (id)');
  const end = html.indexOf('function openRecord(id)');
  assert(core && start >= 0 && end > start, 'Nije pronađen stvarni renderer kartica u index.html.');
  const elements = new Map();
  const document = {
    baseURI: 'https://example.test/demetra-rb-index/',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '' });
      return elements.get(id);
    }
  };
  const catalog = {
    schemaVersion: offers.schemaVersion, sourcePolicy: offers.sourcePolicy, updatedAt: offers.updatedAt,
    plants: plants.plants, nurseries: nurseries.nurseries, offers: offers.offers
  };
  const context = createContext({ URL, atob: globalThis.atob, document, catalogJSON: JSON.stringify(catalog) },
    { codeGeneration: { strings: false, wasm: false } });
  const run = code => new Script(code).runInContext(context, { timeout: 15000 });
  run(core[1] + '\n' + html.slice(start, end) + '\nstate.catalog = validateImport(JSON.parse(catalogJSON)).data;');
  const data = JSON.parse(run('JSON.stringify(state.catalog)'));
  const byId = new Map(data.offers.map(offer => [offer.id, offer]));
  const hiddenStatuses = new Set(['needs_review', 'superseded']);
  const active = data.offers.filter(offer => !hiddenStatuses.has(offer.recordStatus));
  const hidden = data.offers.filter(offer => hiddenStatuses.has(offer.recordStatus));
  const seen = new Set();
  const esc = value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const fields = [
    ['Obim sadnice', 'circumference'], ['Visina sadnice', 'height'],
    ['Širina krošnje', 'crownWidth'], ['Veličina busena', 'rootBall'],
    ['Veličina saksije', 'potSize'], ['Način isporuke', 'rootType']
  ];
  let knownParameters = 0;
  function checkPanel(markup, offer) {
    const label = offer.id + ': ';
    const panel = markup.match(/<dl class="measurements">([\s\S]*?)<\/dl>/)?.[1];
    assert(panel, label + 'nedostaje glavni panel parametara.');
    const entries = [...panel.matchAll(/<dt>([^<]+)<\/dt><dd(?: class="missing")?>([\s\S]*?)<\/dd>/g)];
    assert.deepEqual(entries.map(entry => entry[1]), ['Tip sadnice', ...fields.map(([name]) => name)],
      label + 'svih sedam polja mora biti prikazano u glavnom panelu, nezavisno od tipa sadnice.');
    const values = new Map(entries.map(entry => [entry[1], entry[2]]));
    const type = offer.seedlingType === 'standard' ? 'Standard' :
      offer.seedlingType === 'multistem' ? 'Multistem' : 'Nije navedeno u ponudi';
    assert.equal(values.get('Tip sadnice'), type, label + 'pogrešan tip sadnice.');
    for (const [name, field] of fields) {
      assert.equal(values.get(name), esc(offer[field] || 'Nije navedeno'),
        label + name + ' mora prikazati sopstvenu izvornu vrednost u glavnom panelu.');
      if (offer[field] && !/nije|nepoznat/i.test(offer[field])) knownParameters++;
    }
    const pricePanel = markup.match(/<div class="offer-price"><strong>([\s\S]*?)<\/strong>/)?.[1];
    const expectedPrice = offer.price === null ? 'Cena nije navedena' :
      new Intl.NumberFormat('sr-Latn-RS', offer.currency ?
        { style: 'currency', currency: offer.currency, maximumFractionDigits: 2 } :
        { maximumFractionDigits: 2 }).format(offer.price);
    assert.equal(pricePanel, esc(expectedPrice), label + 'izvorna cena mora biti u cenovnom panelu.');
  }

  for (const plant of data.plants) {
    context.plantId = plant.id;
    run('renderRecord(plantById(plantId));');
    const markup = elements.get('plant-dialog-content').innerHTML;
    assert(markup.includes('<h2 id="plant-detail-title">' + esc(plant.latinName) + '</h2>'),
      plant.id + ': kartica mora prikazati naziv svoje biljke.');
    const cards = [...markup.matchAll(/<article class="offer-card" data-offer-id="([^"]+)">[\s\S]*?<\/article>/g)];
    assert.equal(cards.length, active.filter(offer => offer.plantId === plant.id).length,
      plant.id + ': nisu prikazane sve aktivne varijante.');
    for (const card of cards) {
      const offer = byId.get(card[1]);
      assert(offer, plant.id + ': nepoznata varijanta ' + card[1]);
      assert.equal(offer.plantId, plant.id, offer.id + ': varijanta pripada drugoj biljci.');
      assert(!hiddenStatuses.has(offer.recordStatus), offer.id + ': nepotvrđena varijanta je prikazana kao ponuda.');
      assert(!seen.has(offer.id), offer.id + ': ista varijanta je prikazana više puta.');
      seen.add(offer.id);
      checkPanel(card[0], offer);
    }
  }
  assert.deepEqual([...seen].sort(), active.map(offer => offer.id).sort(), 'Nedostaju aktivne varijante u renderovanim karticama.');
  // Hidden records remain hidden, but their renderer must also obey the rule if
  // a later evidence review activates them.
  for (const offer of hidden) {
    context.offerId = offer.id;
    const markup = run('(() => { const offer = state.catalog.offers.find(item => item.id === offerId); return renderOffer(offer, plantById(offer.plantId), nurseryById(offer.nurseryId)); })()');
    checkPanel(markup, offer);
  }
  return { plants: data.plants.length, records: data.offers.length, activePanels: active.length,
    hiddenPanelsChecked: hidden.length, knownParameters, allFieldsInMainPanel: true, pricesInPricePanel: true };
}

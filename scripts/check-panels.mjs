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
  const originalById = new Map(offers.offers.map(offer => [offer.id, offer]));
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
  let sourceSpecificationsPreservedInData = 0;
  let transplantValuesInMainPanel = 0;
  let additionalParametersInMainPanel = 0;
  let genericDimensionDuplicatesRemoved = 0;
  function expectedExtraFields(original) {
    const parts = value => {
      const compact = String(value || '').toLowerCase().replace(/\s+/g, '')
        .replace(/(?<=\d),(?=\d)/g, '.').replace(/[-–—/]/g, '–');
      const result = /^([\d.]+(?:–[\d.]+)?\+?)(cm|mm|m)?$/.exec(compact);
      return result && { range: result[1], unit: result[2] || '' };
    };
    const typed = ['circumference', 'height', 'crownWidth', 'rootBall'].map(key => parts(original[key])).filter(Boolean);
    return (original.additionalParameters || []).flatMap(parameter => {
      if (!['Dimenzija iz ponude', 'Nerazvrstana mera iz ponude'].includes(parameter.label)) return [parameter];
      const originalValues = parameter.value.split(/[;·]/).map(value => value.trim()).filter(Boolean);
      const remaining = originalValues.filter(value => {
        const candidate = parts(value);
        return !candidate || !typed.some(known => known.range === candidate.range &&
          (!known.unit || !candidate.unit || known.unit === candidate.unit));
      });
      genericDimensionDuplicatesRemoved += originalValues.length - remaining.length;
      return remaining.length ? [{ ...parameter, value: remaining.join(' · ') }] : [];
    });
  }
  // Independent regressions from the actual archived offer rows. These cannot
  // pass merely because both JSON and UI contain the same empty field.
  const sourceRegressions = new Map([
    ['record-d291e70b52ac19', {
      source: '100-150 WRB',
      sourceFile: 'Offer for Inquiry Request 2 - Trees for spring 2025 75953.xlsx',
      fields: { 'Visina sadnice': '100–150', 'Način isporuke': 'Busen u žičanoj korpi (WRB)' }
    }],
    ['record-variant-bbe9089a200cd082db', {
      source: 'Acer Norwegian Sunset; Izvorna oznaka: 14-16 Ho 3xv',
      sourceFile: 'special stocklist Demetra.xlsx',
      fields: { 'Tip sadnice': 'Standard', 'Obim sadnice': '14–16', 'Broj presađivanja': '3 (3xv)' }
    }],
    ['record-ae82d0bdf916f9', {
      source: 'Product: Acer Pacific Sunset 16-18 STD RB',
      sourceFile: 'Copy of ARBOR_2026_04_15_CONTAINERSTOCK_SALESBOOK.xlsx',
      fields: { 'Tip sadnice': 'Standard', 'Obim sadnice': '16–18', 'Način isporuke': 'Busen (RB)' }
    }],
    ['record-b7abfc95049a24', {
      source: 'Product: Acer Pacific Sunset MULTISTEM 350-400 C230L',
      sourceFile: 'Copy of ARBOR_2026_04_15_CONTAINERSTOCK_SALESBOOK.xlsx',
      fields: { 'Tip sadnice': 'Multistem', 'Visina sadnice': '350–400', 'Veličina saksije': '230 L' }
    }],
    ['record-f80bf9874479e4', {
      source: 'Carpinus betulus 200-250 MS DRKL',
      sourceFile: 'Carpinus betulus 200-250 MS DRKL.jpg',
      fields: { 'Tip sadnice': 'Multistem', 'Visina sadnice': '200–250', 'Način isporuke': 'Busen u žičanoj korpi (DRKL)' }
    }],
    ['offer-pdf-c08a8d7071192d851a54', {
      source: 'Acer platanoides Cleveland; H 3xv mDb 25-30',
      sourceFile: 'Acer.pdf',
      fields: { 'Tip sadnice': 'Standard', 'Obim sadnice': '25–30',
        'Način isporuke': 'Busen u žičanoj korpi (mDb)', 'Broj presađivanja': '3 (3xv)' }
    }]
  ]);
  // Check the original, explicit column labels independently from the
  // extractor. An empty JSON field must not be allowed to validate an empty UI.
  let explicitSourceColumnsChecked = 0;
  const normalizedMeasure = value => String(value || '').trim().replace(/\s*[-–—/]\s*/g, '–');
  for (const original of offers.offers.filter(offer => !hiddenStatuses.has(offer.recordStatus))) {
    assert(!original.sourceEvidence?.multipleVariants &&
      (original.sourceEvidence?.sourceSpecifications || []).length <= 1,
      original.id + ': više izvornih varijanti mora biti razdvojeno pre prikaza.');
    for (const [field, label] of [['height', 'Height'], ['circumference', 'Circums\\.']]) {
      const match = new RegExp('(?:^|;\\s*)' + label + ':\\s*([0-9]+(?:[.,][0-9]+)?(?:[-–—/][0-9]+(?:[.,][0-9]+)?)?(?:\\s*(?:cm|mm|m))?)(?=;|$)', 'i')
        .exec(original.specification || '');
      if (!match) continue;
      assert.equal(normalizedMeasure(original[field]), normalizedMeasure(match[1]),
        original.id + ': izričita kolona ' + label + ' mora popuniti polje ' + field + '.');
      explicitSourceColumnsChecked++;
    }
  }
  const odsSHA = '8caa2e41d8d2cb80c9e6d364ce301c11f7c50efe4d7e4a2ebdcae922efd0ac02';
  for (const [row, height] of [[119, '100–150'], [131, '150–200']]) {
    const matches = offers.offers.filter(offer => !hiddenStatuses.has(offer.recordStatus) &&
      offer.plantId === 'plant-9bfd779b012c0c' && offer.nurseryId === 'combinatie-mauritz' &&
      offer.sourceEvidence?.sourceSha256 === odsSHA && offer.sourceEvidence?.row === row);
    assert.equal(matches.length, 1, 'Abies Glauca ODS red ' + row + ': očekuje se tačno jedna odvojena varijanta.');
    assert.equal(matches[0].height, height, 'Abies Glauca: izvorna Height kolona mora biti u visini.');
    assert.equal(matches[0].rootType, 'Busen (RB)', 'Abies Glauca: rb je način isporuke.');
    assert.equal(matches[0].price, null, 'Cena ponuđenog concolor ne pripada traženom Glauca kultivaru.');
  }
  const checkedSourceRegressions = new Set();
  function checkPanel(markup, offer) {
    const label = offer.id + ': ';
    const original = originalById.get(offer.id);
    const panel = markup.match(/<dl class="measurements">([\s\S]*?)<\/dl>/)?.[1];
    assert(panel, label + 'nedostaje glavni panel parametara.');
    const entries = [...panel.matchAll(/<dt>([^<]+)<\/dt><dd(?: class="missing")?>([\s\S]*?)<\/dd>/g)];
    const extra = expectedExtraFields(original);
    assert.deepEqual(entries.map(entry => entry[1]), ['Tip sadnice', ...fields.map(([name]) => name),
      'Broj presađivanja', ...extra.map(parameter => esc(parameter.label))],
      label + 'glavni panel mora imati parametre bez duplirane sirove specifikacije ili već raspoređene mere.');
    const values = new Map(entries.map(entry => [entry[1], entry[2]]));
    const type = offer.seedlingType === 'standard' ? 'Standard' :
      offer.seedlingType === 'multistem' ? 'Multistem' : 'Nije navedeno u ponudi';
    assert.equal(values.get('Tip sadnice'), type, label + 'pogrešan tip sadnice.');
    for (const [name, field] of fields) {
      assert.equal(values.get(name), esc(offer[field] || 'Nije navedeno'),
        label + name + ' mora prikazati sopstvenu izvornu vrednost u glavnom panelu.');
      if (offer[field] && !/nije|nepoznat/i.test(offer[field])) knownParameters++;
    }
    // Raw source evidence is preserved for verification, not printed as a
    // duplicate of the structured fields in the user-facing card.
    assert(!values.has('Specifikacija iz ponude'), label + 'sirova specifikacija ne sme duplirati parametre.');
    if (original.specification) {
      assert.equal(offer.specification, original.specification.trim(),
        label + 'izvorna specifikacija mora ostati sačuvana u podacima.');
      sourceSpecificationsPreservedInData++;
    }
    const rawTransplants = original.traitsEvidence?.transplants;
    const count = original.transplantCount ?? (rawTransplants?.status === 'exact' ? rawTransplants.count : null);
    const codes = [...new Set(original.transplantCodes || rawTransplants?.raw || [])];
    const transplantValue = count !== null && count !== undefined ?
      (codes.length ? String(count) + ' (' + codes.join(', ') + ')' : original.transplantNote || String(count)) :
      original.transplantNote || codes.join(', ');
    assert.equal(values.get('Broj presađivanja'), esc(transplantValue || 'Nije navedeno'),
      label + 'podatak o presađivanju mora biti u svom polju glavnog panela.');
    if (transplantValue) transplantValuesInMainPanel++;
    for (const parameter of extra) {
      assert.equal(values.get(esc(parameter.label)), esc(parameter.value),
        label + parameter.label + ' iz ponude mora biti u glavnom panelu.');
      additionalParametersInMainPanel++;
    }
    const regression = sourceRegressions.get(offer.id);
    if (regression) {
      assert.equal(original.specification, regression.source,
        label + 'regresiona provera mora biti vezana za poznati izvorni red.');
      assert.equal(original.sourceEvidence?.sourceFile, regression.sourceFile,
        label + 'regresioni podatak mora pripadati odgovarajućoj ponudi.');
      for (const [name, expected] of Object.entries(regression.fields)) {
        assert.equal(values.get(name), esc(expected),
          label + 'izvor „' + regression.source + '” zahteva ' + name + ': ' + expected + ' u glavnom panelu.');
      }
      checkedSourceRegressions.add(offer.id);
    }
    const footer = markup.split('<div class="offer-footer">')[1] || '';
    assert(!footer.includes('Specifikacija izvora:') && !footer.includes('Napomena o presađivanju:'),
      label + 'specifikacija i presađivanje ne smeju ostati izdvojeni u fusnoti.');
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
  assert.deepEqual([...checkedSourceRegressions].sort(), [...sourceRegressions.keys()].sort(),
    'Poznati ponudni redovi moraju proći nezavisne provere izvor → glavni panel.');
  return { plants: data.plants.length, records: data.offers.length, activePanels: active.length,
    hiddenPanelsChecked: hidden.length, knownParameters, sourceSpecificationsPreservedInData,
    transplantValuesInMainPanel, additionalParametersInMainPanel, genericDimensionDuplicatesRemoved,
    sourceDerivedRegressions: checkedSourceRegressions.size,
    explicitSourceColumnsChecked,
    allFieldsInMainPanel: true, rawSourcePreservedOnlyInData: true, pricesInPricePanel: true };
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = await readFile(root + '/index.html', 'utf8');
const core = html.match(/\/\/ BEGIN CATALOG CORE\n([\s\S]*?)\/\/ END CATALOG CORE/)[1];
const ui = html.slice(html.indexOf('const $ = (id)'), html.indexOf('function openRecord(id)'));
const elements = new Map();
const document = {
  baseURI: 'https://example.test/demetra-rb-index/',
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '' });
    return elements.get(id);
  }
};
const context = createContext({ URL, atob: globalThis.atob, document });
const run = code => new Script(code).runInContext(context, { timeout: 5000 });
run(core + '\n' + ui);
const sourcePolicy = { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos'] };
const baseOffer = {
  id: 'offer-a', plantId: 'plant-a', nurseryId: 'nursery-a',
  seedlingType: 'standard', seedlingTypeCode: 'STD',
  circumference: '25–30', height: '', crownWidth: '', rootBall: '', potSize: '', rootType: 'RB',
  price: 450, currency: 'EUR', priceKind: 'historical', unit: 'kom',
  source: 'Ponuda iz dostavljenog ZIP-a', sourceDate: '2026-02-23',
  dataOrigin: 'rasadnici-ponude-zip',
  dataAccuracyNote: 'Visina nije navedena u ponudi. Obim je sačuvan kao obim.',
  transplantCount: null, transplantNote: '', image: '', demo: false
};
function fixture(offerChanges = {}, envelopeChanges = {}) {
  return {
    schemaVersion: 1, sourcePolicy, updatedAt: '2026-11-09T00:00:00Z',
    plants: [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", demo: false }],
    nurseries: [{ id: 'nursery-a', name: 'Arbor', demo: false }],
    offers: [{ ...baseOffer, ...offerChanges }], ...envelopeChanges
  };
}
function render(offerChanges) {
  context.inputJSON = JSON.stringify(fixture(offerChanges));
  run('state.catalog = validateImport(JSON.parse(inputJSON)).data; renderRecord(plantById("plant-a"));');
  return elements.get('plant-dialog-content').innerHTML;
}
function rejects(offerChanges, envelopeChanges, expected) {
  context.inputJSON = JSON.stringify(fixture(offerChanges, envelopeChanges));
  assert.throws(() => run('validateImport(JSON.parse(inputJSON));'), expected);
}

const standard = render({});
assert(standard.includes('<dt>Tip sadnice</dt><dd>Standard</dd>'));
assert(standard.includes('<dt>Visina sadnice</dt><dd class="missing">Nije navedeno</dd>'));
assert(standard.includes('<dt>Obim sadnice</dt><dd>25–30</dd>'));
assert(!standard.includes('Obim sadnice u ponudi: 25–30.'));
assert(!standard.includes('<dt>Visina sadnice</dt><dd>25–30</dd>'));
assert(standard.includes('<dt>Broj presađivanja</dt><dd class="missing">Nije navedeno</dd>'));

const multistem = render({ seedlingType: 'multistem', seedlingTypeCode: 'MSTEM',
  circumference: '12–14', height: '300–350 cm', transplantCount: 3,
  transplantNote: '3xv — tri presađivanja prema oznaci iz ponude.' });
assert(multistem.includes('<dt>Tip sadnice</dt><dd>Multistem</dd>'));
assert(multistem.includes('<dt>Obim sadnice</dt><dd>12–14</dd>'));
assert(multistem.includes('<dt>Visina sadnice</dt><dd>300–350 cm</dd>'));
assert(!multistem.includes('Visina sadnice u ponudi: 300–350 cm.'));
assert(multistem.includes('<dt>Broj presađivanja</dt><dd>3xv — tri presađivanja prema oznaci iz ponude.</dd>'));
assert(!multistem.includes('Napomena o presađivanju:</strong>'));

const unknown = render({ seedlingType: '', seedlingTypeCode: '', height: '200 cm' });
assert(unknown.includes('<dt>Tip sadnice</dt><dd class="missing">Nije navedeno u ponudi</dd>'));
assert(unknown.includes('<dt>Obim sadnice</dt>') && unknown.includes('<dt>Visina sadnice</dt>'));
assert(!unknown.includes('Obim stabla'));
assert(!unknown.includes('Maksimalna visina biljke'));
const fullParameters = {
  circumference: '16–18 cm', height: '300–350 cm', crownWidth: '80–100 cm',
  rootBall: '60 cm', potSize: 'C80', rootType: 'Busen (RB)'
};
const parameterLabels = {
  circumference: 'Obim sadnice', height: 'Visina sadnice', crownWidth: 'Širina krošnje',
  rootBall: 'Veličina busena', potSize: 'Veličina saksije', rootType: 'Način isporuke'
};
for (const seedlingType of ['standard', 'multistem', '']) {
  const markup = render({ seedlingType, ...fullParameters });
  for (const [field, value] of Object.entries(fullParameters)) {
    assert(markup.includes('<dt>' + parameterLabels[field] + '</dt><dd>' + value + '</dd>'),
      `Tip ${seedlingType || 'nepoznat'} mora prikazati ${parameterLabels[field]} u glavnom panelu.`);
  }
}
// Ho/3xv becomes structured panel fields; the full source stays in JSON.
const mauritzSpec = 'Acer Norwegian Sunset; Izvorna oznaka: 14-16 Ho 3xv';
const mauritz = render({ circumference: '14–16', seedlingTypeCode: 'Ho',
  specification: mauritzSpec, transplantCount: null,
  traitsEvidence: { transplants: { status: 'exact', count: 3, raw: ['3xv'] } },
  transplantNote: 'Broj presađivanja: 3 (oznaka u ponudi: 3xv).' });
const mauritzPanel = mauritz.match(/<dl class="measurements">([\s\S]*?)<\/dl>/)[1];
assert(mauritzPanel.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));
assert(mauritzPanel.includes('<dt>Broj presađivanja</dt><dd>3 (3xv)</dd>'));
assert(!mauritz.includes('Specifikacija iz ponude'));
assert(!mauritz.includes(mauritzSpec));
assert.equal(run('state.catalog.offers[0].specification'), mauritzSpec);
assert(!mauritz.split('<div class="offer-footer">')[1].includes(mauritzSpec));
const rangeNote = 'Broj presađivanja: 3–4 (oznaka u ponudi: III–IV).';
const ranged = render({ transplantNote: rangeNote,
  traitsEvidence: { transplants: { status: 'range', count: null, raw: ['III–IV'] } } });
assert(ranged.includes('<dt>Broj presađivanja</dt><dd>' + rangeNote + '</dd>'));
const unclassified = render({ seedlingType: '', circumference: '', height: '',
  specification: 'Acer test; mera iz ponude: 125/150; oznaka XY',
  additionalParameters: [{ label: 'Dimenzija iz ponude', value: '125/150' }] });
assert(unclassified.match(/<dl class="measurements">([\s\S]*?)<\/dl>/)[1]
  .includes('<dt>Dimenzija iz ponude</dt><dd>125/150</dd>'));
assert(!unclassified.includes('Acer test; mera iz ponude: 125/150; oznaka XY'));
assert(unclassified.includes('<dt>Visina sadnice</dt><dd class="missing">Nije navedeno</dd>'));
const duplicateDimension = render({ height: '100–150 cm', specification: 'Acer test 100-150 WRB',
  additionalParameters: [{ label: 'Dimenzija iz ponude', value: '100-150' }] });
assert(duplicateDimension.includes('<dt>Visina sadnice</dt><dd>100–150 cm</dd>'));
assert(!duplicateDimension.includes('Dimenzija iz ponude'));
assert(!duplicateDimension.includes('Acer test 100-150 WRB'));
const partialDuplicate = render({ height: '100–150 cm',
  additionalParameters: [{ label: 'Dimenzija iz ponude', value: '100-150 · 200-250' }] });
assert(partialDuplicate.includes('<dt>Dimenzija iz ponude</dt><dd>200-250</dd>'));
const differentUnit = render({ height: '100–150 mm',
  additionalParameters: [{ label: 'Dimenzija iz ponude', value: '100-150 cm' }] });
assert(differentUnit.includes('<dt>Dimenzija iz ponude</dt><dd>100-150 cm</dd>'));
const additional = render({ additionalParameters: [
  { label: 'Visina čistog debla', value: '220 cm' },
  { label: 'Dimenzije panela', value: '150 × 180 cm' },
  { label: '<img src=x>', value: '<script>alert(1)</script>' }
] });
assert(additional.includes('<dt>Visina čistog debla</dt><dd>220 cm</dd>'));
assert(additional.includes('<dt>Dimenzije panela</dt><dd>150 × 180 cm</dd>'));
assert(additional.includes('<dt>&lt;img src=x&gt;</dt><dd>&lt;script&gt;alert(1)&lt;/script&gt;</dd>'));
assert(!additional.includes('<img src=x>') && !additional.includes('<script>alert(1)</script>'));
const escaped = render({ dataAccuracyNote: '<img src=x onerror=alert(1)>' });
assert(!escaped.includes('<img src=x'));
assert(escaped.includes('&lt;img src=x'));
const review = render({ recordStatus: 'needs_review',
  sourceEvidence: { sourceFile: 'ponuda<1>.pdf' },
  dataAccuracyNote: 'Cena i mere zamene nisu pripisane traženoj biljci.' });
assert(review.includes('<strong>Tačnost podataka</strong>'));
assert(review.includes('Cena i mere zamene nisu pripisane traženoj biljci.'));
assert(review.includes('Prilog: ponuda&lt;1&gt;.pdf'));
assert(!review.includes('Ponude rasadnika za ovu biljku još nisu unete.'));
assert(!review.includes('class="offer-price"') && !review.includes('<dl class="measurements">'));

rejects({ seedlingType: 'umbrella' }, {}, /tip sadnice/);
rejects({ dataOrigin: 'online' }, {}, /dostavljenih ponuda/);
rejects({ priceKind: 'public' }, {}, /dostavljenih ponuda/);
rejects({ matureHeight: '10 m' }, {}, /online kataloga/);
rejects({ transplantCount: -1 }, {}, /broj presađivanja/);
rejects({ traitsEvidence: { transplants: { status: 'exact', count: -1, raw: ['-1xv'] } } }, {}, /broj presađivanja/);
rejects({ additionalParameters: [{ label: 'Visina čistog debla', value: '' }] }, {}, /vrednost dodatnog parametra/);
rejects({}, { sourcePolicy: { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos', 'prices'] } }, /online se ažuriraju samo fotografije/);
console.log(JSON.stringify({ ok: true, allKnownParametersInMainPanelForEveryType: true,
  girthAndHeightRemainSeparate: true, noGeneratedDimensionFootnote: true, unknownTypeExplicit: true,
  transplantsInMainPanel: true, rawSpecificationPreservedOnlyInData: true,
  duplicateGenericDimensionsRemoved: true, additionalSourceParametersInMainPanel: true,
  sourcePolicyEnforced: true, notesEscaped: true,
  reviewExplainedWithoutUnconfirmedOffer: true }, null, 2));

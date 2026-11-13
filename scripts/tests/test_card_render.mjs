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
const offeredSizeNote = 'Tip sadnice nije izričito označen u ovom redu ponude; nije pretpostavljen. Ponuđena je sorta Globosa sa oznakom veličine 30-40 iz F10; tražena sorta Silver Globus i veličina 40/60 nisu preneti na ovu alternativu. Vrsta mere i njena jedinica nisu navedene.';
const offeredSize = render({ circumference: '', dataAccuracyNote: offeredSizeNote,
  additionalParameters: [{ label: 'Ponuđena veličina (izvorna oznaka)', value: '30–40' },
    { label: 'Dimenzija iz ponude', value: '30-40' }] });
assert(offeredSize.includes('<dt>Ponuđena veličina (izvorna oznaka)</dt><dd>30–40</dd>'));
assert(!offeredSize.includes('<dt>Dimenzija iz ponude</dt>'));
assert.equal([...offeredSize.matchAll(/30[–-]40/g)].length, 1);
assert(offeredSize.includes('Ponuđena je sorta Globosa; veličina je preneta iz F10;'));
assert(offeredSize.includes('tražena sorta Silver Globus i veličina 40/60 nisu preneti na ovu alternativu.'));
assert(offeredSize.includes('Vrsta mere i njena jedinica nisu navedene.'));
assert.equal(run('state.catalog.offers[0].dataAccuracyNote'), offeredSizeNote);
const countIsNotDimension = render({ circumference: '',
  additionalParameters: [{ label: 'Broj etaža', value: '3' }, { label: 'Dimenzija iz ponude', value: '3' }] });
assert(countIsNotDimension.includes('<dt>Broj etaža</dt><dd>3</dd>'));
assert(countIsNotDimension.includes('<dt>Dimenzija iz ponude</dt><dd>3</dd>'));
const namedDifferentUnit = render({ circumference: '',
  additionalParameters: [{ label: 'Ponuđena veličina (izvorna oznaka)', value: '30–40 mm' },
    { label: 'Dimenzija iz ponude', value: '30-40 cm' }] });
assert(namedDifferentUnit.includes('<dt>Dimenzija iz ponude</dt><dd>30-40 cm</dd>'));

// The original notes remain in the data. Only their already displayed values
// are omitted; source cells, uncertainty and requested alternatives still show.
const noteCases = [
  { fields: { circumference: '20–25' }, note: 'Ponuđeno 20/25 je iz D16; tražena visina 4/5m nije potvrđena za ovu varijantu.',
    absent: /20[–/-]25/, retained: 'Ponuđena mera je iz D16; tražena visina 4/5m nije potvrđena za ovu varijantu.' },
  { fields: { circumference: '20–25' }, note: 'Ponuđen obim20-25 iz H44; ostale tražene mere nisu potvrđene za izmenjenu varijantu.',
    absent: /20[–/-]25/, retained: 'Obim je prenet iz H44; ostale tražene mere nisu potvrđene za izmenjenu varijantu.' },
  { fields: { circumference: '', potSize: 'C2', additionalParameters: [{ label: 'Dimenzija iz ponude', value: '20-30' }] },
    note: '20-30 je neoznačena mera u koloni Size i nije pretvorena u visinu ili obim. C2 je doslovno preneta oznaka kontejnera.',
    absent: /20[–/-]30|C2/, retained: 'Mera iz kolone Size nema označen tip; nije protumačena kao visina ili obim. Oznaka kontejnera je doslovno preneta iz ponude.' },
  { fields: { circumference: '', additionalParameters: [{ label: 'Dimenzija iz ponude', value: '18 cm' }] },
    note: 'Doslovna neklasifikovana mera iz izvora: 18 cm.', absent: /18 cm/,
    retained: 'Vrsta ove mere nije navedena u izvoru.' },
  { fields: { circumference: '', additionalParameters: [{ label: 'Dimenzija iz ponude', value: '17 cm' }] },
    note: 'Neoznačena mera iz izvora: 17 cm.', absent: /17 cm/,
    retained: 'Vrsta ove mere nije navedena u izvoru.' },
  { fields: { circumference: '', additionalParameters: [{ label: 'Dimenzija iz ponude', value: '200-300 x 400-500' }] },
    note: 'Dimenzije su sačuvane doslovno iz specifikacije: 200-300 x 400-500; WRB je izvorni kod pakovanja.',
    absent: /200-300|400-500/, retained: 'Dimenzije su prenete bez promene; WRB je izvorni kod pakovanja.' },
  { fields: { circumference: '20–25' }, note: 'Obim sadnice u ponudi: 20/25. Jedinica nije navedena.',
    absent: /20[–/-]25/, retained: 'Jedinica nije navedena.' }
];
for (const example of noteCases) {
  const markup = render({ ...example.fields, measurementNote: example.note });
  const footer = markup.split('<div class="offer-footer">')[1];
  assert(!example.absent.test(footer), 'Ponovljena mera je ostala u fusnoti: ' + example.note);
  assert(footer.includes(example.retained), 'Izgubljeno je objašnjenje izvora: ' + example.note);
  assert.equal(run('state.catalog.offers[0].measurementNote'), example.note);
}
const containerNote = 'Mere i oznaka clt3 preneti su iz odštampanog reda upita. Ćelija jedinične cene je prazna; nula u koloni Ukupno nije jedinična cena. Ponuđena raspoloživost ove stavke nije potvrđena.';
const container = render({ potSize: 'clt3', dataAccuracyNote: containerNote });
assert.equal([...container.matchAll(/clt3/g)].length, 1);
assert(container.includes('Mere i oznaka kontejnera preneti su iz odštampanog reda upita.'));
assert(container.includes('Ćelija jedinične cene je prazna; nula u koloni Ukupno nije jedinična cena.'));
assert(container.includes('Ponuđena raspoloživost ove stavke nije potvrđena.'));
assert.equal(run('state.catalog.offers[0].dataAccuracyNote'), containerNote);
const conflictNote = 'Fascikla nosi oznaku 30-35, dok naziv same fotografije glasi 25-30HO DRKL; razlika nije prećutno usklađena.';
assert(render({ circumference: '25–30', dataAccuracyNote: conflictNote }).includes(conflictNote));
const undisplayedNote = 'Doslovna neklasifikovana mera iz izvora: 18 cm.';
assert(render({ circumference: '', height: '18 mm', measurementNote: undisplayedNote }).includes(undisplayedNote));
const unrelatedNumbers = 'Ponuđeno 20 je iz D16; cena je 20 EUR, provera je 20. 2. 2026.';
assert(render({ circumference: '20', measurementNote: unrelatedNumbers }).includes(unrelatedNumbers));
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
  duplicateGenericDimensionsRemoved: true, duplicateMeasurementNotesRemoved: true,
  sourceContextAndOriginalNotesPreserved: true, additionalSourceParametersInMainPanel: true,
  sourcePolicyEnforced: true, notesEscaped: true,
  reviewExplainedWithoutUnconfirmedOffer: true }, null, 2));

const unknownCurrency = render({price: 125.5, currency: '', currencyStatus:'not_stated',
  priceNote:'Valuta nije navedena u izvornom cenovniku; iznos je prenet bez konverzije. Današnja cena i dostupnost nisu potvrđene.'});
assert(unknownCurrency.includes('Cena nije navedena') && !unknownCurrency.includes('125,50'));
assert(unknownCurrency.includes('Valuta nije navedena'));
assert(unknownCurrency.includes('Današnja cena i dostupnost nisu potvrđene.'));
const noPrice = render({price:null,currency:''});
assert(noPrice.includes('Cena nije navedena'));
assert(!noPrice.includes('0,00'));
const statedCurrency = render({price:1000,currency:'RSD'});
assert(statedCurrency.includes('Cena nije navedena') && !statedCurrency.includes('1.000,00'));
const converted={price:49.31,currency:'EUR',currencyStatus:'converted',sourceAmount:5800,sourceCurrency:'RSD',priceConversion:{status:'converted',fromCurrency:'RSD',toCurrency:'EUR',originalAmount:5800,rate:117.6203,rateDate:'2026-11-13'}};
const euroPrice=render(converted);assert(euroPrice.includes('49,31')&&euroPrice.includes('€'));assert(!euroPrice.includes('5.800')&&!euroPrice.includes('117.6203'));
assert(render({...converted,price:5800}).includes('Cena nije navedena'),'A relabelled RSD amount must not become EUR');
assert(render({...converted,priceConversion:{...converted.priceConversion,rate:0}}).includes('Cena nije navedena'));
const nativeEuro=render({price:5800,currency:'EUR',sourceAmount:5800,sourceCurrency:'EUR'});assert(nativeEuro.includes('5.800,00')&&nativeEuro.includes('€'),'A genuine large EUR price must not be divided by an exchange rate');

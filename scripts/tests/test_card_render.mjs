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
assert(!standard.includes('<dt>Obim sadnice</dt>'));
assert(standard.includes('Obim sadnice u ponudi: 25–30.'));
assert(!standard.includes('<dt>Visina sadnice</dt><dd>25–30</dd>'));

const multistem = render({ seedlingType: 'multistem', seedlingTypeCode: 'MSTEM',
  circumference: '12–14', height: '300–350 cm', transplantCount: 3,
  transplantNote: '3xv — tri presađivanja prema oznaci iz ponude.' });
assert(multistem.includes('<dt>Tip sadnice</dt><dd>Multistem</dd>'));
assert(multistem.includes('<dt>Obim sadnice</dt><dd>12–14</dd>'));
assert(!multistem.includes('<dt>Visina sadnice</dt>'));
assert(multistem.includes('Visina sadnice u ponudi: 300–350 cm.'));
assert(multistem.includes('Napomena o presađivanju:</strong> 3xv'));
assert(!multistem.includes('<dt>Broj presađivanja</dt>'));

const unknown = render({ seedlingType: '', seedlingTypeCode: '', height: '200 cm' });
assert(unknown.includes('<dt>Tip sadnice</dt><dd class="missing">Nije navedeno u ponudi</dd>'));
assert(unknown.includes('<dt>Obim sadnice</dt>') && unknown.includes('<dt>Visina sadnice</dt>'));
assert(!unknown.includes('Obim stabla'));
assert(!unknown.includes('Maksimalna visina biljke'));
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
rejects({}, { sourcePolicy: { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos', 'prices'] } }, /online se ažuriraju samo fotografije/);
console.log(JSON.stringify({ ok: true, standardHeightSeparateFromGirth: true,
  multistemGirthSeparateFromHeight: true, unknownTypeExplicit: true,
  transplantCountOnlyInNotes: true, sourcePolicyEnforced: true, notesEscaped: true,
  reviewExplainedWithoutUnconfirmedOffer: true }, null, 2));

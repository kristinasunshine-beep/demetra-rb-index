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
const photo = {
  image: 'assets/biljke/reference-0123456789abcdef.jpg',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Acer_campestre.jpg',
  imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/00/Acer_campestre.jpg',
  taxon: 'Acer campestre', matchLevel: 'species_reference', origin: 'wikimedia',
  author: 'Primer autora', license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  checkedAt: '2026-11-09T14:45:00Z', status: 'verified'
};
const offer = {
  id: 'offer-a', plantId: 'plant-a', nurseryId: 'nursery-a',
  seedlingType: 'standard', circumference: '14–16', height: '',
  price: null, currency: '', priceKind: 'unpublished',
  dataOrigin: 'rasadnici-ponude-zip', dataAccuracyNote: 'Podaci iz ponude.',
  image: '', imageSourceUrl: '', demo: false
};
function fixture({ photoChanges = {}, plantChanges = {}, offerChanges = {}, offers } = {}) {
  return {
    schemaVersion: 1, updatedAt: '2026-11-09T14:45:00Z',
    sourcePolicy: { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos'] },
    plants: [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", photo: { ...photo, ...photoChanges },
      ...plantChanges }],
    nurseries: [{ id: 'nursery-a', name: 'Arbor' }],
    offers: offers || [{ ...offer, ...offerChanges }]
  };
}
function render(options) {
  context.inputJSON = JSON.stringify(fixture(options));
  run('state.catalog = validateImport(JSON.parse(inputJSON)).data; renderRecord(plantById("plant-a"));');
  return elements.get('plant-dialog-content').innerHTML;
}
function rejects(options, message) {
  context.inputJSON = JSON.stringify(fixture(options));
  assert.throws(() => run('validateImport(JSON.parse(inputJSON));'), message);
}

const reference = render();
assert(reference.includes('src="https://example.test/demetra-rb-index/assets/biljke/reference-0123456789abcdef.jpg"'));
assert(reference.includes('Referentna fotografija vrste: Acer campestre'));
assert(reference.includes('Autor: Primer autora'));
assert(reference.includes('href="https://commons.wikimedia.org/wiki/File:Acer_campestre.jpg"'));
assert(reference.includes('Licenca: <a href="https://creativecommons.org/licenses/by-sa/4.0/"'));
assert(reference.includes('CC BY-SA 4.0'));
assert(!reference.includes('<img src="https://upload.wikimedia.org'));
assert(!reference.includes('Izvor kataloške fotografije ↗'));
assert(reference.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));

const supplier = render({ offerChanges: { image: 'assets/biljke/supplier.jpg',
  imageSourceUrl: 'https://example.org/nursery/acer', imageKind: 'Kataloška fotografija rasadnika' } });
assert(supplier.includes('assets/biljke/supplier.jpg'));
assert(supplier.includes('Kataloška fotografija rasadnika'));
assert(!supplier.includes('reference-0123456789abcdef.jpg'));
assert(!supplier.includes('Referentna fotografija'));
assert(supplier.includes('Izvor kataloške fotografije ↗'));

const exact = render({ plantChanges: { latinName: 'Acer campestre' }, photoChanges: { matchLevel: 'exact' } });
assert(exact.includes('Referentna fotografija biljke'));
assert(!exact.includes('Referentna fotografija vrste:'));
const synonym = render({ plantChanges: { latinName: 'Styphnolobium japonicum', synonyms: ['Sophora japonica'] },
  photoChanges: { taxon: 'Sophora japonica', matchLevel: 'exact' } });
assert(synonym.includes('Referentna fotografija biljke'));

const empty = render({ offers: [] });
assert(empty.includes('Ponude rasadnika za ovu biljku još nisu unete.'));
assert(empty.includes('Referentna fotografija vrste: Acer campestre'));
const review = render({ offerChanges: { recordStatus: 'needs_review' } });
assert(review.includes('Tačnost podataka') && review.includes('Referentna fotografija vrste:'));
const missing = render({ plantChanges: { photo: null } });
assert(missing.includes('Fotografija nije dostupna u obrađenom izvoru'));
assert(!missing.includes('Wikimedia Commons'));

const escaped = render({ photoChanges: { author: '<img src=x onerror=alert(1)>',
  license: '<script>alert(1)</script>' } });
assert(escaped.includes('&lt;img src=x onerror=alert(1)&gt;'));
assert(escaped.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert(!escaped.includes('<img src=x') && !escaped.includes('<script>alert(1)</script>'));

rejects({ photoChanges: { matchLevel: 'exact' } }, /takson/);
rejects({ plantChanges: { synonyms: ['Acer campestre'] }, photoChanges: { matchLevel: 'exact' } }, /takson/);
rejects({ photoChanges: { taxon: 'Quercus robur' } }, /takson/);
rejects({ plantChanges: { searchAliases: ['Quercus robur'] }, photoChanges: { taxon: 'Quercus robur', matchLevel: 'exact' } }, /takson/);
rejects({ photoChanges: { image: 'https://upload.wikimedia.org/image.jpg' } }, /lokalni JPEG/);
rejects({ photoChanges: { image: 'assets/biljke/../../reference-0123456789abcdef.jpg' } }, /lokalni JPEG/);
rejects({ photoChanges: { image: 'assets/biljke/reference-0123456789abcdef.svg' } }, /lokalni JPEG/);
rejects({ photoChanges: { sourceUrl: 'javascript:alert(1)' } }, /HTTP/);
rejects({ photoChanges: { sourceUrl: 'https://example.com/fake-commons' } }, /Wikimedia/);
rejects({ photoChanges: { licenseUrl: 'javascript:alert(1)' } }, /HTTP/);
rejects({ photoChanges: { status: 'pending' } }, /potvrđen Wikimedia/);
rejects({ photoChanges: { origin: 'supplier' } }, /potvrđen Wikimedia/);
rejects({ photoChanges: { author: '' } }, /obavezno polje/);
rejects({ photoChanges: { license: '' } }, /obavezno polje/);
rejects({ photoChanges: { checkedAt: '2026-02-30' } }, /datum/);

console.log(JSON.stringify({ ok: true, nurseryPhotoHasPriority: true,
  verifiedSpeciesReferenceClearlyLabelled: true, attributionAndLicenseVisible: true,
  referenceIsLocal: true, emptyRecordsShowReference: true,
  unsafeMetadataRejectedOrEscaped: true, colloquialAliasesNotUsedForIdentity: true }, null, 2));

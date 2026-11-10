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
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Acer_campestre_Elsrijk.jpg'
};
const legacyPhoto = {
  ...photo,
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
assert(!reference.includes('Referentna fotografija'));
assert(!reference.includes('Autor:'));
assert(!reference.includes('commons.wikimedia.org'));
assert(!reference.includes('Licenca:'));
assert(!reference.includes('CC BY-SA'));
assert(!reference.includes('<img src="https://upload.wikimedia.org'));
assert(!reference.includes('Izvor kataloške fotografije ↗'));
assert(reference.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));
assert(render({ photoChanges: { status: 'verified' } }).includes('reference-0123456789abcdef.jpg'));
assert(render({ photoChanges: { sourceUrl: 'https://www.gbif.org/occurrence/12345' } }).includes('reference-0123456789abcdef.jpg'));
assert(render({ photoChanges: { sourceUrl: 'https://example.org/nursery/acer' } }).includes('reference-0123456789abcdef.jpg'));

const supplier = render({ offerChanges: { image: 'assets/biljke/supplier.jpg',
  imageSourceUrl: 'https://example.org/nursery/acer', imageKind: 'Kataloška fotografija rasadnika' } });
assert(supplier.includes('assets/biljke/supplier.jpg'));
assert(!supplier.includes('Kataloška fotografija rasadnika'));
assert(!supplier.includes('reference-0123456789abcdef.jpg'));
assert(!supplier.includes('Referentna fotografija'));
assert(!supplier.includes('Izvor kataloške fotografije ↗'));
assert(!supplier.includes('https://example.org/nursery/acer'));

const exact = render({ plantChanges: { latinName: 'Acer campestre', photo: {
  ...legacyPhoto, matchLevel: 'exact', license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' } } });
assert(exact.includes('reference-0123456789abcdef.jpg'));
assert(!exact.includes('Referentna fotografija') && !exact.includes('Autor:'));
const synonym = render({ plantChanges: { latinName: 'Styphnolobium japonicum', synonyms: ['Sophora japonica'] },
  photoChanges: { ...legacyPhoto, taxon: 'Sophora japonica', matchLevel: 'exact', license: 'Public domain' } });
assert(synonym.includes('reference-0123456789abcdef.jpg'));
const hiddenSpecies = render({ plantChanges: { photo: { ...legacyPhoto, license: 'CC0' } } });
assert(!hiddenSpecies.includes('reference-0123456789abcdef.jpg'));
const hiddenAttribution = render({ plantChanges: { latinName: 'Acer campestre',
  photo: { ...legacyPhoto, matchLevel: 'exact' } } });
assert(!hiddenAttribution.includes('reference-0123456789abcdef.jpg'));

const empty = render({ offers: [] });
assert(empty.includes('Ponude rasadnika za ovu biljku još nisu unete.'));
assert(empty.includes('reference-0123456789abcdef.jpg'));
const review = render({ offerChanges: { recordStatus: 'needs_review' } });
assert(review.includes('Tačnost podataka') && review.includes('reference-0123456789abcdef.jpg'));
const missing = render({ plantChanges: { photo: null } });
assert(missing.includes('Fotografija nije dostupna u obrađenom izvoru'));
assert(!missing.includes('Wikimedia Commons'));

const escaped = render({ photoChanges: { ...legacyPhoto, author: '<img src=x onerror=alert(1)>',
  license: '<script>alert(1)</script>' } });
assert(!escaped.includes('<img src=x') && !escaped.includes('<script>alert(1)</script>'));

rejects({ photoChanges: { ...legacyPhoto, matchLevel: 'exact' } }, /takson/);
rejects({ plantChanges: { synonyms: ['Acer campestre'] }, photoChanges: { ...legacyPhoto, matchLevel: 'exact' } }, /takson/);
rejects({ photoChanges: { ...legacyPhoto, taxon: 'Quercus robur' } }, /takson/);
rejects({ plantChanges: { searchAliases: ['Quercus robur'] }, photoChanges: { ...legacyPhoto, taxon: 'Quercus robur', matchLevel: 'exact' } }, /takson/);
rejects({ photoChanges: { image: 'https://upload.wikimedia.org/image.jpg' } }, /lokalni JPEG/);
rejects({ photoChanges: { image: 'assets/biljke/../../reference-0123456789abcdef.jpg' } }, /lokalni JPEG/);
rejects({ photoChanges: { image: 'assets/biljke/reference-0123456789abcdef.svg' } }, /lokalni JPEG/);
rejects({ photoChanges: { sourceUrl: 'javascript:alert(1)' } }, /HTTP/);
rejects({ photoChanges: { sourceUrl: 'http://example.org/photo' } }, /HTTPS/);
rejects({ photoChanges: { sourceUrl: '' } }, /HTTPS/);
rejects({ photoChanges: { ...legacyPhoto, sourceUrl: 'https://example.com/fake-commons' } }, /Wikimedia/);
rejects({ photoChanges: { ...legacyPhoto, licenseUrl: 'javascript:alert(1)' } }, /HTTP/);
rejects({ photoChanges: { status: 'pending' } }, /potvrđena/);
rejects({ photoChanges: { ...legacyPhoto, origin: 'supplier' } }, /potvrđen Wikimedia/);
rejects({ photoChanges: { ...legacyPhoto, author: '' } }, /obavezno polje/);
rejects({ photoChanges: { ...legacyPhoto, license: '' } }, /obavezno polje/);
rejects({ photoChanges: { ...legacyPhoto, checkedAt: '2026-02-30' } }, /datum/);

console.log(JSON.stringify({ ok: true, nurseryPhotoHasPriority: true,
  compactPhotoRecordsSupported: true, publicPhotoMetadataHidden: true,
  unsafeLegacyReferencesHidden: true,
  referenceIsLocal: true, emptyRecordsShowReference: true,
  unsafeMetadataRejectedOrEscaped: true, colloquialAliasesNotUsedForIdentity: true }, null, 2));

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
  sourceUrl: 'https://www.arbor.be/plants/acer-campestre-elsrijk'
};
const legacyPhoto = {
  ...photo, sourceUrl: 'https://commons.wikimedia.org/wiki/File:Acer_campestre.jpg',
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
function fixture({ photoChanges = {}, plantChanges = {}, offerChanges = {}, offers, nurseries } = {}) {
  return {
    schemaVersion: 1, updatedAt: '2026-11-09T14:45:00Z',
    sourcePolicy: { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos'] },
    plants: [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", photo: { ...photo, ...photoChanges },
      ...plantChanges }],
    nurseries: nurseries || [{ id: 'nursery-a', name: 'Arbor' }],
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
assert.equal((reference.match(/<img\b/g) || []).length, 1);
assert(reference.indexOf('reference-0123456789abcdef.jpg') < reference.indexOf('class="detail-body"'));
assert(!reference.match(/<article\b[\s\S]*?<\/article>/)[0].includes('<img'));
assert(!reference.includes('Referentna fotografija'));
assert(!reference.includes('Autor:'));
assert(!reference.includes('commons.wikimedia.org'));
assert(!reference.includes('Licenca:'));
assert(!reference.includes('CC BY-SA'));
assert(!reference.includes('<img src="https://upload.wikimedia.org'));
assert(!reference.includes('Izvor kataloške fotografije ↗'));
assert(reference.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));
assert(render({ photoChanges: { status: 'verified' } }).includes('reference-0123456789abcdef.jpg'));
assert(!render({ photoChanges: { sourceUrl: 'https://www.gbif.org/occurrence/12345' } }).includes('reference-0123456789abcdef.jpg'));
assert(render({ photoChanges: { sourceUrl: 'https://example.org/nursery/acer' } }).includes('reference-0123456789abcdef.jpg'));

const supplier = render({ offerChanges: { image: 'assets/biljke/supplier.jpg',
  imageSourceUrl: 'https://example.org/nursery/acer', imageKind: 'Kataloška fotografija rasadnika' } });
assert(supplier.includes('assets/biljke/supplier.jpg'));
assert(!supplier.includes('Kataloška fotografija rasadnika'));
assert.equal((supplier.match(/reference-0123456789abcdef\.jpg/g) || []).length, 1);
const supplierArticle = supplier.match(/<article\b[\s\S]*?<\/article>/)[0];
assert(supplierArticle.includes('assets/biljke/supplier.jpg'));
assert(!supplierArticle.includes('reference-0123456789abcdef.jpg'));
assert(!supplier.includes('Referentna fotografija'));
assert(!supplier.includes('Izvor kataloške fotografije ↗'));
assert(!supplier.includes('https://example.org/nursery/acer'));

const exact = render({ plantChanges: { latinName: 'Acer campestre', photo: {
  ...legacyPhoto, matchLevel: 'exact', license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' } } });
assert(!exact.includes('reference-0123456789abcdef.jpg'));
assert(!exact.includes('Referentna fotografija') && !exact.includes('Autor:'));
const synonym = render({ plantChanges: { latinName: 'Styphnolobium japonicum', synonyms: ['Sophora japonica'] },
  photoChanges: { ...legacyPhoto, taxon: 'Sophora japonica', matchLevel: 'exact', license: 'Public domain' } });
assert(!synonym.includes('reference-0123456789abcdef.jpg'));
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
assert(!missing.includes('<img'));
assert(!missing.includes('Fotografija nije dostupna u obrađenom izvoru'));
assert(!missing.includes('Wikimedia Commons'));

const multipleSuppliers = render({
  nurseries: [{ id: 'nursery-a', name: 'Arbor' }, { id: 'nursery-b', name: 'Lorberg' }],
  offers: [offer, { ...offer, id: 'offer-a2', circumference: '18–20' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'assets/biljke/lorberg.jpg' }]
});
assert.equal((multipleSuppliers.match(/reference-0123456789abcdef\.jpg/g) || []).length, 1,
  'A plant photograph is shown once across suppliers and variants.');
const supplierArticles = [...multipleSuppliers.matchAll(/<article\b[^>]*data-offer-id="([^"]+)"[\s\S]*?<\/article>/g)];
assert.equal(supplierArticles.length, 3);
for (const [markup, id] of supplierArticles) {
  assert(!markup.includes('reference-0123456789abcdef.jpg'));
  assert.equal(markup.includes('<img'), id === 'offer-b');
  if (id === 'offer-b') assert(markup.includes('assets/biljke/lorberg.jpg'));
}
assert.equal((empty.match(/reference-0123456789abcdef\.jpg/g) || []).length, 1);
assert.equal((review.match(/reference-0123456789abcdef\.jpg/g) || []).length, 1);

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

// Check real catalogue cards, including collapsed variants, rather than only fixtures.
const [plantData, nurseryData, offerData] = await Promise.all(
  ['biljke.json', 'rasadnici.json', 'kataloske-stavke.json'].map(async name =>
    JSON.parse(await readFile(root + '/data/' + name, 'utf8')))
);
context.inputJSON = JSON.stringify({ schemaVersion: 1, sourcePolicy: offerData.sourcePolicy,
  plants: plantData.plants, nurseries: nurseryData.nurseries, offers: offerData.offers,
  updatedAt: offerData.updatedAt });
run('state.catalog = validateImport(JSON.parse(inputJSON)).data;');
const offerById = new Map(offerData.offers.map(item => [item.id, item]));
let cardsChecked = 0, offersChecked = 0;
for (const plant of plantData.plants) {
  context.plantId = plant.id;
  run('renderRecord(plantById(plantId));');
  const markup = elements.get('plant-dialog-content').innerHTML;
  const body = markup.slice(markup.indexOf('class="detail-body"'));
  if (plant.photo) {
    assert(!body.includes(plant.photo.image), 'Shared plant photo repeated in offers: ' + plant.latinName);
    assert.equal(markup.split(plant.photo.image).length - 1, 1,
      'Shared plant photo must appear once: ' + plant.latinName);
  }
  for (const [article, id] of markup.matchAll(/<article\b[^>]*data-offer-id="([^"]+)"[\s\S]*?<\/article>/g)) {
    const source = offerById.get(id);
    assert(source, 'Unknown displayed offer: ' + id);
    assert.equal((article.match(/<img\b/g) || []).length, source.image ? 1 : 0,
      'An offer must only show its own image: ' + id);
    if (source.image) assert(article.includes(source.image));
    offersChecked++;
  }
  cardsChecked++;
}

console.log(JSON.stringify({ ok: true, sharedPhotoShownOnce: true,
  supplierPhotosStayWithTheirOffers: true, cardsChecked, offersChecked,
  compactPhotoRecordsSupported: true, publicPhotoMetadataHidden: true,
  unsafeLegacyReferencesHidden: true,
  referenceIsLocal: true, emptyRecordsShowReference: true,
  unsafeMetadataRejectedOrEscaped: true, colloquialAliasesNotUsedForIdentity: true }, null, 2));

// Empty space never survives missing image data; adding data restores the image.
assert(missing.includes('detail-hero without-photo'));
assert(!missing.includes('class="plant-photo"'));
assert(!missing.includes('class="offer-photo"'));
assert(missing.includes('class="offer-pricing"'));
assert(missing.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));
assert(reference.includes('detail-hero with-photo'));
assert(!reference.includes('empty-image'));
const errorHandler = html.slice(html.indexOf('function hideFailedPhoto(image)'), html.indexOf("dialog.addEventListener('error'"));
run(errorHandler);
const classes = new Set(['with-photo']);
const hero = {classList: {add: x => classes.add(x), remove: x => classes.delete(x)}};
let removed = false;
const holder = {closest: () => hero, remove: () => { removed = true; }};
context.failedPhoto = {closest: selector => selector === '.plant-photo' ? holder : null};
run('hideFailedPhoto(failedPhoto)');
assert(removed && classes.has('without-photo') && !classes.has('with-photo'));
let visualRemoved = false;
const offerClasses = new Set();
const visual = {closest: () => ({classList: {add: x => offerClasses.add(x)}}), remove: () => {visualRemoved = true;}};
context.failedPhoto = {closest: selector => selector === '.offer-visual' ? visual : null};
run('hideFailedPhoto(failedPhoto)');
assert(visualRemoved && offerClasses.has('without-photo'));

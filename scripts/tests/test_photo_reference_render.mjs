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
function fixture({ photoChanges = {}, plantChanges = {}, offerChanges = {}, plants, offers, nurseries } = {}) {
  return {
    schemaVersion: 1, updatedAt: '2026-11-09T14:45:00Z',
    sourcePolicy: { nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos'] },
    plants: plants || [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", photo: { ...photo, ...photoChanges },
      ...plantChanges }],
    nurseries: nurseries || [{ id: 'nursery-a', name: 'Arbor' }],
    offers: offers || [{ ...offer, ...offerChanges }]
  };
}
function render(options, plantId = 'plant-a') {
  context.inputJSON = JSON.stringify(fixture(options));
  context.plantId = plantId;
  run('state.catalog = validateImport(JSON.parse(inputJSON)).data; renderRecord(plantById(plantId));');
  return elements.get('plant-dialog-content').innerHTML;
}
function rejects(options, message) {
  context.inputJSON = JSON.stringify(fixture(options));
  assert.throws(() => run('validateImport(JSON.parse(inputJSON));'), message);
}

// Match class tokens, not the order or complete spelling of a class attribute.
// Required containers must exist, so a missing boundary cannot silently become slice(-1).
function tags(markup, name) {
  return [...markup.matchAll(/<([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
    .filter(match => !name || match[1].toLowerCase() === name);
}
function attribute(tag, name) {
  return tag.match(new RegExp('\\s' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'i'))?.[2] || '';
}
function classTags(markup, token) {
  return tags(markup).filter(match => attribute(match[0], 'class').split(/\s+/).includes(token));
}
function requiredClass(markup, token) {
  const matches = classTags(markup, token);
  assert.equal(matches.length, 1, 'Expected exactly one .' + token + ' container');
  return matches[0];
}
function articles(markup) {
  return [...markup.matchAll(/<article\b[^>]*data-offer-id="([^"]+)"[\s\S]*?<\/article>/g)];
}
function assertOfferImage(markup, expectedImage, referenceFallback = false) {
  requiredClass(markup, 'offer-card');
  const body = requiredClass(markup, 'offer-card-body');
  const details = requiredClass(markup, 'offer-details');
  requiredClass(markup, 'offer-pricing');
  const images = tags(markup, 'img');
  assert.equal(images.length, expectedImage ? 1 : 0, 'An offer must show exactly its expected image');
  assert.equal(classTags(markup, 'offer-visual').length, expectedImage ? 1 : 0, 'Unexpected .offer-visual container');
  assert.equal(classTags(markup, 'offer-photo').length, expectedImage ? 1 : 0, 'Unexpected .offer-photo container');
  assert.equal(classTags(markup, 'record-photo-reference').length, referenceFallback ? 1 : 0,
    'Only a plant-reference fallback has the photograph-of-species label');
  assert.equal(classTags(markup, 'empty-image').length, 0, 'Missing photographs must not leave placeholders');
  assert.equal(attribute(body[0], 'class').split(/\s+/).includes('without-photo'), !expectedImage);
  if (expectedImage) {
    assert.equal(attribute(images[0][0], 'src'), new URL(expectedImage, document.baseURI).href,
      'The image must belong to this offer or its exact plant');
    const visual = requiredClass(markup, 'offer-visual');
    assert(visual.index < images[0].index && images[0].index < details.index,
      'The photograph belongs in the offer visual before its details');
  }
}
function assertRecordLayout(markup) {
  requiredClass(markup, 'detail-body');
  const hero = requiredClass(markup, 'detail-hero');
  assert(attribute(hero[0], 'class').split(/\s+/).includes('without-photo'));
  assert.equal(classTags(markup, 'plant-photo').length, 0, 'Photos belong to offers, not the record heading');
}

const reference = render();
assert(reference.includes('src="https://example.test/demetra-rb-index/assets/biljke/reference-0123456789abcdef.jpg"'));
assert.equal((reference.match(/<img\b/g) || []).length, 1);
assertRecordLayout(reference);
const referenceArticle = articles(reference)[0][0];
assertOfferImage(referenceArticle, photo.image, true);
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
assert.equal((supplier.match(/reference-0123456789abcdef\.jpg/g) || []).length, 0);
const supplierArticle = supplier.match(/<article\b[\s\S]*?<\/article>/)[0];
assertOfferImage(supplierArticle, 'assets/biljke/supplier.jpg');
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
for (const rejectedReference of [exact, synonym, hiddenSpecies, hiddenAttribution,
  render({ photoChanges: { sourceUrl: 'https://www.gbif.org/occurrence/12345' } })]) {
  assertOfferImage(articles(rejectedReference)[0][0], '');
}
const ownWithRejectedReference = render({ plantChanges: { photo: legacyPhoto },
  offerChanges: { image: 'assets/biljke/supplier.jpg' } });
assertOfferImage(articles(ownWithRejectedReference)[0][0], 'assets/biljke/supplier.jpg');

const empty = render({ offers: [] });
assert(empty.includes('Ponude rasadnika za ovu biljku još nisu unete.'));
assert.equal(tags(empty, 'img').length, 0);
assert.equal(articles(empty).length, 0);
const review = render({ offerChanges: { recordStatus: 'needs_review' } });
assert(review.includes('Tačnost podataka'));
assert.equal(tags(review, 'img').length, 0);
assert.equal(articles(review).length, 0);
const missing = render({ plantChanges: { photo: null } });
assert(!missing.includes('<img'));
assert(!missing.includes('Fotografija nije dostupna u obrađenom izvoru'));
assert(!missing.includes('Wikimedia Commons'));

const multipleSuppliers = render({
  nurseries: [{ id: 'nursery-a', name: 'Arbor' }, { id: 'nursery-b', name: 'Lorberg' }],
  offers: [offer, { ...offer, id: 'offer-a2', circumference: '18–20' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'assets/biljke/lorberg.jpg' }]
});
assert.equal((multipleSuppliers.match(/reference-0123456789abcdef\.jpg/g) || []).length, 2,
  'Each offer without its own image receives the photograph of the same plant.');
const supplierArticles = [...multipleSuppliers.matchAll(/<article\b[^>]*data-offer-id="([^"]+)"[\s\S]*?<\/article>/g)];
assert.equal(supplierArticles.length, 3);
for (const [markup, id] of supplierArticles) {
  assertOfferImage(markup, id === 'offer-b' ? 'assets/biljke/lorberg.jpg' : photo.image, id !== 'offer-b');
}
for (const noOffers of [empty, review]) {
  assertRecordLayout(noOffers);
  assert.equal(classTags(noOffers, 'offer-visual').length, 0);
  assert.equal(classTags(noOffers, 'empty-image').length, 0);
}

// The fallback is linked by plant identity, never borrowed from a similar cultivar.
const otherPhoto = { image: 'assets/biljke/reference-fedcba9876543210.jpg',
  sourceUrl: 'https://www.arbor.be/plants/acer-campestre-elegant' };
const cultivars = {
  plants: [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", photo },
    { id: 'plant-b', latinName: "Acer campestre 'Elegant'", photo: otherPhoto },
    { id: 'plant-c', latinName: 'Acer campestre' }],
  offers: [offer, { ...offer, id: 'offer-other', plantId: 'plant-b' },
    { ...offer, id: 'offer-species', plantId: 'plant-c' }]
};
for (const [id, image] of [['plant-a', photo.image], ['plant-b', otherPhoto.image], ['plant-c', '']]) {
  const markup = render(cultivars, id), shown = articles(markup);
  assert.equal(shown.length, 1);
  assertOfferImage(shown[0][0], image, !!image);
  assert.equal(tags(markup, 'img').length, image ? 1 : 0);
}

// Presentation class additions are harmless; missing containers, wrong plants,
// and repeated images must still make the verification fail.
assertOfferImage(referenceArticle.replace('class="offer-card-body"', 'class="layout offer-card-body compact"'), photo.image, true);
assert.throws(() => assertRecordLayout(reference.replace('class="detail-body"', 'class="detail-body-missing"')), /detail-body/);
assert.throws(() => assertOfferImage(referenceArticle.replace('class="offer-visual"', 'class="offer-visual-missing"'), photo.image, true), /offer-visual/);
assert.throws(() => assertOfferImage(referenceArticle.replace(photo.image, otherPhoto.image), photo.image, true), /exact plant/);
assert.throws(() => assertOfferImage(referenceArticle.replace('</article>', '<img src="extra.jpg"></article>'), photo.image, true), /expected image/);

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
const activeOffers = offerData.offers.filter(item => !['needs_review', 'superseded'].includes(item.recordStatus));
const seenOfferIds = new Set();
let cardsChecked = 0, offersChecked = 0, supplierImagesChecked = 0, referenceFallbacksChecked = 0;
for (const plant of plantData.plants) {
  context.plantId = plant.id;
  run('renderRecord(plantById(plantId));');
  const markup = elements.get('plant-dialog-content').innerHTML;
  assertRecordLayout(markup);
  const displayed = articles(markup);
  assert.deepEqual(displayed.map(([, id]) => id).sort(),
    activeOffers.filter(item => item.plantId === plant.id).map(item => item.id).sort(),
    'Every active offer, including collapsed variants, must be checked: ' + plant.latinName);
  const referenceHost = plant.photo ? new URL(plant.photo.sourceUrl).hostname : '';
  const allowedReference = plant.photo && !plant.photo.matchLevel &&
    !['commons.wikimedia.org', 'www.gbif.org', 'gbif.org'].includes(referenceHost) ? plant.photo.image : '';
  let expectedImages = 0;
  for (const [article, id] of displayed) {
    const source = offerById.get(id);
    assert(source, 'Unknown displayed offer: ' + id);
    assert.equal(source.plantId, plant.id, 'An offer must stay with its own plant: ' + id);
    assert(!seenOfferIds.has(id), 'Offer rendered more than once: ' + id);
    const expectedImage = source.image || allowedReference;
    assertOfferImage(article, expectedImage, !!expectedImage && !source.image);
    if (expectedImage) expectedImages++;
    if (source.image) supplierImagesChecked++;
    else if (expectedImage) referenceFallbacksChecked++;
    seenOfferIds.add(id);
    offersChecked++;
  }
  assert.equal(tags(markup, 'img').length, expectedImages,
    'No additional or cross-plant image may appear outside the offers: ' + plant.latinName);
  cardsChecked++;
}
assert.equal(offersChecked, activeOffers.length);

// Empty space never survives missing image data; adding data restores the image.
assertRecordLayout(missing);
assertOfferImage(articles(missing)[0][0], '');
assert(missing.includes('<dt>Obim sadnice</dt><dd>14–16</dd>'));
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

console.log(JSON.stringify({ ok: true, referenceFallbackPerOffer: true,
  supplierPhotosTakePriority: true, samePlantAndCultivarOnly: true,
  cardsChecked, offersChecked, supplierImagesChecked, referenceFallbacksChecked,
  allActiveOffersChecked: true, compactPhotoRecordsSupported: true,
  publicTechnicalPhotoMetadataHidden: true, unsafeLegacyReferencesHidden: true,
  emptyRecordsHaveNoPhotoPlaceholder: true, malformedContainersRejected: true,
  unsafeMetadataRejectedOrEscaped: true, colloquialAliasesNotUsedForIdentity: true }, null, 2));

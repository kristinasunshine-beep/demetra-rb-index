import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
function hiddenOfferIds(markup) {
  const hidden=new Set();
  for(const [tag] of markup.matchAll(/<article\b[^>]*data-offer-id="[^"]+"[^>]*>/g)){
    if(!attribute(tag,'class').split(/\s+/).includes('is-selected'))hidden.add(attribute(tag,'data-offer-id'));
  }
  return hidden;
}
function normalizedImage(value) {
  const url = new URL(value.replace(/&amp;/g, '&'), document.baseURI);
  url.hash = '';
  return url.href;
}
let imageContentHashes = new Map();
function photographIdentity(value) {
  const url = normalizedImage(value);
  return imageContentHashes.get(url) || url;
}
function assertUniqueImages(markup) {
  const sources = tags(markup, 'img').map(match => normalizedImage(attribute(match[0], 'src')));
  assert.equal(new Set(sources).size, sources.length,
    'A photograph must appear only once across the whole plant card, including hidden variants');
  assert.equal(new Set(sources.map(photographIdentity)).size, sources.length,
    'Identical image bytes under different filenames must appear only once in a plant card');
  return sources;
}
function assertOfferImage(markup, expectedImage) {
  requiredClass(markup,'offer-picker-option');
  requiredClass(markup,'offer-picker-select');
  requiredClass(markup,'offer-picker-ledger-meta');
  const images=tags(markup,'img');
  assert.equal(images.length,expectedImage?1:0,'An offer must show exactly its expected image');
  assert.equal(classTags(markup,'offer-picker-photo').length,expectedImage?1:0,'Unexpected offer photo disclosure');
  assert.equal(classTags(markup,'record-photo-reference').length,0);
  assert.equal(classTags(markup,'empty-image').length,0);
  if(expectedImage)assert.equal(normalizedImage(attribute(images[0][0],'src')),normalizedImage(expectedImage),'The image must belong to this exact offer');
}
function assertRecordLayout(markup, expectedReference = '') {
  const body = requiredClass(markup, 'detail-body');
  const hero = requiredClass(markup, 'detail-hero');
  const heroClasses = attribute(hero[0], 'class').split(/\s+/);
  assert.equal(heroClasses.includes('without-photo'), !expectedReference);
  assert.equal(heroClasses.includes('with-photo'), !!expectedReference);
  assert.equal(classTags(markup, 'plant-photo').length, expectedReference ? 1 : 0,
    'The exact plant reference appears once in the record heading');
  const heroImages = tags(markup.slice(hero.index, body.index), 'img');
  assert.equal(heroImages.length, expectedReference ? 1 : 0);
  if (expectedReference) {
    const holder = requiredClass(markup, 'plant-photo');
    assert(hero.index < holder.index && holder.index < body.index,
      'The shared photograph belongs in the plant heading, outside every offer');
    assert.equal(normalizedImage(attribute(heroImages[0][0], 'src')), normalizedImage(expectedReference),
      'The heading photograph must belong to the exact plant');
  }
  assertUniqueImages(markup);
}

const reference = render();
assert(reference.includes('src="https://example.test/demetra-rb-index/assets/biljke/reference-0123456789abcdef.jpg"'));
assert.equal((reference.match(/<img\b/g) || []).length, 1);
assertRecordLayout(reference, photo.image);
const referenceArticle = articles(reference)[0][0];
assertOfferImage(referenceArticle, '');
assert(!reference.includes('Referentna fotografija'));
assert(!reference.includes('Autor:'));
assert(!reference.includes('commons.wikimedia.org'));
assert(!reference.includes('Licenca:'));
assert(!reference.includes('CC BY-SA'));
assert(!reference.includes('<img src="https://upload.wikimedia.org'));
assert(!reference.includes('Izvor kataloške fotografije ↗'));
assert(reference.includes('<small>Obim</small><strong class="offer-cell-value">14–16</strong>'));
assert(render({ photoChanges: { status: 'verified' } }).includes('reference-0123456789abcdef.jpg'));
assert(!render({ photoChanges: { sourceUrl: 'https://www.gbif.org/occurrence/12345' } }).includes('reference-0123456789abcdef.jpg'));
assert(render({ photoChanges: { sourceUrl: 'https://example.org/nursery/acer' } }).includes('reference-0123456789abcdef.jpg'));

const supplier = render({ offerChanges: { image: 'assets/biljke/supplier.jpg',
  imageSourceUrl: 'https://example.org/nursery/acer', imageKind: 'Kataloška fotografija rasadnika' } });
assert(supplier.includes('assets/biljke/supplier.jpg'));
assert(!supplier.includes('Kataloška fotografija rasadnika'));
assertRecordLayout(supplier, photo.image);
assert.equal(tags(supplier, 'img').length, 2, 'A different original offer photo remains beside its offer');
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
assertRecordLayout(empty, photo.image);
assert.equal(tags(empty, 'img').length, 1, 'A known plant photograph remains visible without offers');
assert.equal(articles(empty).length, 0);
const review = render({ offerChanges: { recordStatus: 'needs_review' } });
assert(review.includes('Tačnost podataka'));
assertRecordLayout(review, photo.image);
assert.equal(tags(review, 'img').length, 1);
assert.equal(articles(review).length, 0);
const emptyWithoutPhoto = render({ offers: [], plantChanges: { photo: null } });
assertRecordLayout(emptyWithoutPhoto);
assert.equal(tags(emptyWithoutPhoto, 'img').length, 0);
const missing = render({ plantChanges: { photo: null } });
assert(!missing.includes('<img'));
assert(!missing.includes('Fotografija nije dostupna u obrađenom izvoru'));
assert(!missing.includes('Wikimedia Commons'));

const multipleSuppliers = render({
  nurseries: [{ id: 'nursery-a', name: 'Arbor' }, { id: 'nursery-b', name: 'Lorberg' }],
  offers: [offer, { ...offer, id: 'offer-a2', circumference: '18–20' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'assets/biljke/lorberg.jpg' }]
});
assertRecordLayout(multipleSuppliers, photo.image);
assert.equal((multipleSuppliers.match(/reference-0123456789abcdef\.jpg/g) || []).length, 1,
  'All variants share a single plant photograph in the heading.');
const supplierArticles = [...multipleSuppliers.matchAll(/<article\b[^>]*data-offer-id="([^"]+)"[\s\S]*?<\/article>/g)];
assert.equal(supplierArticles.length, 3);
for (const [markup, id] of supplierArticles) {
  assertOfferImage(markup, id === 'offer-b' ? 'assets/biljke/lorberg.jpg' : '');
}
for (const noOffers of [empty, review]) {
  assertRecordLayout(noOffers, photo.image);
  assert.equal(classTags(noOffers, 'offer-visual').length, 0);
  assert.equal(classTags(noOffers, 'empty-image').length, 0);
}

// Deduplicate original photographs across suppliers and collapsed variants,
// while preserving every distinct original with the offer that supplied it.
const repeatedOptions = {
  nurseries: [{ id: 'nursery-a', name: 'Arbor' }, { id: 'nursery-b', name: 'Lorberg' }],
  offers: [
    { ...offer, image: 'assets/biljke/supplier.jpg' },
    { ...offer, id: 'offer-a2', image: 'https://EXAMPLE.test:443/demetra-rb-index/assets/biljke/../biljke/supplier.jpg#detail' },
    { ...offer, id: 'offer-a3', image: 'https://example.org/plant.jpg?view=front&size=large' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'https://example.test/demetra-rb-index/assets/biljke/supplier.jpg' },
    { ...offer, id: 'offer-b2', nurseryId: 'nursery-b', image: 'https://example.org/plant.jpg?view=back&size=large' },
    { ...offer, id: 'offer-b3', nurseryId: 'nursery-b', image: 'https://example.org/plant.jpg?view=front&size=large' }
  ]
};
const repeated = render(repeatedOptions);
assertRecordLayout(repeated, photo.image);
assert.equal(classTags(repeated, 'supplier-offer-picker').length, 2);
const repeatedExpected = new Map([
  ['offer-a', 'assets/biljke/supplier.jpg'], ['offer-a2', ''],
  ['offer-a3', 'https://example.org/plant.jpg?view=front&size=large'], ['offer-b', ''],
  ['offer-b2', 'https://example.org/plant.jpg?view=back&size=large'], ['offer-b3', '']
]);
for (const [markup, id] of articles(repeated)) assertOfferImage(markup, repeatedExpected.get(id));
assert.equal(tags(repeated, 'img').length, 4,
  'One shared reference and three different originals are displayed, including collapsed variants');
const withoutReference = render({ ...repeatedOptions, plantChanges: { photo: null } });
assertRecordLayout(withoutReference);
assert.equal(tags(withoutReference, 'img').length, 3, 'Original deduplication also works without a shared reference');
for (const [markup, id] of articles(withoutReference)) assertOfferImage(markup, repeatedExpected.get(id));

const heroDuplicate = render({ offers: [
  { ...offer, image: photo.image },
  { ...offer, id: 'offer-a2', image: new URL(photo.image, document.baseURI).href + '#same-photo' }
] });
assertRecordLayout(heroDuplicate, photo.image);
assert.equal(tags(heroDuplicate, 'img').length, 1, 'The heading takes precedence over matching offer images');
for (const [markup] of articles(heroDuplicate)) assertOfferImage(markup, '');
const embedded = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQy8AAAAASUVORK5CYII=';
const repeatedEmbedded = render({ plantChanges: { photo: null }, offers: [
  { ...offer, image: embedded }, { ...offer, id: 'offer-a2', image: embedded }
] });
assertRecordLayout(repeatedEmbedded);
assert.equal(tags(repeatedEmbedded, 'img').length, 1, 'Imported embedded originals are deduplicated too');

const visiblePriority = render({
  nurseries: repeatedOptions.nurseries,
  offers: [{ ...offer, image: 'assets/biljke/first-original.jpg' },
    { ...offer, id: 'offer-a2', image: 'assets/biljke/other-original.jpg' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'assets/biljke/other-original.jpg' }]
});
assertRecordLayout(visiblePriority, photo.image);
assert(hiddenOfferIds(visiblePriority).has('offer-a2'));
for (const [markup, id] of articles(visiblePriority)) {
  assertOfferImage(markup, id === 'offer-a' ? 'assets/biljke/first-original.jpg' :
    id === 'offer-b' ? 'assets/biljke/other-original.jpg' : '');
}

// Different filenames can hold exactly the same photograph. The content map
// must suppress those copies without hiding genuinely different originals.
const fixtureIdentities = { schemaVersion: 1, identities: {
  [photo.image]: 'a'.repeat(64),
  'assets/biljke/copy-of-reference.jpg': 'a'.repeat(64),
  'assets/biljke/another-original.jpg': 'b'.repeat(64),
  'assets/biljke/copy-of-original.jpg': 'b'.repeat(64)
} };
context.identitiesJSON = JSON.stringify(fixtureIdentities);
run('setPhotoIdentities(JSON.parse(identitiesJSON));');
imageContentHashes = new Map(Object.entries(fixtureIdentities.identities).map(([path, hash]) =>
  [normalizedImage(path), 'sha256:' + hash]));
const sameBytes = render({ offers: [
  { ...offer, image: 'assets/biljke/copy-of-reference.jpg' },
  { ...offer, id: 'offer-a2', image: 'assets/biljke/another-original.jpg' },
  { ...offer, id: 'offer-a3', image: 'assets/biljke/copy-of-original.jpg' }
] });
assertRecordLayout(sameBytes, photo.image);
assert.equal(tags(sameBytes, 'img').length, 2);
for (const [markup, id] of articles(sameBytes)) {
  assertOfferImage(markup, id === 'offer-a2' ? 'assets/biljke/another-original.jpg' : '');
}
assert.throws(() => assertUniqueImages(sameBytes + '<img src="assets/biljke/copy-of-reference.jpg">'),
  /Identical image bytes/);
const sameBytesPriority = render({ plantChanges: { photo: null }, nurseries: repeatedOptions.nurseries,
  offers: [offer, { ...offer, id: 'offer-a2', image: 'assets/biljke/another-original.jpg' },
    { ...offer, id: 'offer-b', nurseryId: 'nursery-b', image: 'assets/biljke/copy-of-original.jpg' }]
});
assertRecordLayout(sameBytesPriority);
for (const [markup, id] of articles(sameBytesPriority)) {
  assertOfferImage(markup, id === 'offer-b' ? 'assets/biljke/copy-of-original.jpg' : '');
}
run('setPhotoIdentities({schemaVersion: 1, identities: {}});');
imageContentHashes = new Map();

// Reopening a card starts a fresh set. A previous plant must never consume
// the photographs of another plant, even when the stored URL is shared.
context.inputJSON = JSON.stringify(fixture(repeatedOptions));
run('state.catalog = validateImport(JSON.parse(inputJSON)).data; renderRecord(plantById("plant-a"));');
const firstOpening = elements.get('plant-dialog-content').innerHTML;
run('renderRecord(plantById("plant-a"));');
assert.equal(elements.get('plant-dialog-content').innerHTML, firstOpening,
  'Reopening the same plant must restore all unique photographs');
const sharedAcrossPlants = {
  plants: [{ id: 'plant-a', latinName: "Acer campestre 'Elsrijk'", photo },
    { id: 'plant-b', latinName: "Acer campestre 'Elsrijk'", photo }],
  offers: [offer, { ...offer, id: 'offer-other', plantId: 'plant-b' }]
};
context.inputJSON = JSON.stringify(fixture(sharedAcrossPlants));
run('state.catalog = validateImport(JSON.parse(inputJSON)).data;');
for (const id of ['plant-a', 'plant-b', 'plant-a']) {
  context.plantId = id;
  run('renderRecord(plantById(plantId));');
  const markup = elements.get('plant-dialog-content').innerHTML;
  assertRecordLayout(markup, photo.image);
  assert.equal(tags(markup, 'img').length, 1, 'Photo deduplication is scoped to each rendered card');
}

// The shared photograph is linked by plant identity, never borrowed from a similar cultivar.
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
  assertRecordLayout(markup, image);
  assertOfferImage(shown[0][0], '');
  assert.equal(tags(markup, 'img').length, image ? 1 : 0);
}

// Presentation class additions are harmless; missing containers, wrong plants,
// and repeated images must still make the verification fail.
assertOfferImage(supplierArticle.replace('class="offer-picker-option ', 'class="layout offer-picker-option '), 'assets/biljke/supplier.jpg');
assert.throws(() => assertRecordLayout(reference.replace('class="detail-body"', 'class="detail-body-missing"'), photo.image), /detail-body/);
assert.throws(() => assertOfferImage(supplierArticle.replace('class="offer-picker-photo"', 'class="offer-picker-photo-missing"'), 'assets/biljke/supplier.jpg'), /offer photo disclosure/);
assert.throws(() => assertRecordLayout(reference.replace(photo.image, otherPhoto.image), photo.image), /exact plant/);
assert.throws(() => assertOfferImage(supplierArticle.replace('assets/biljke/supplier.jpg', otherPhoto.image), 'assets/biljke/supplier.jpg'), /exact offer/);
assert.throws(() => assertOfferImage(referenceArticle.replace('</article>', '<img src="extra.jpg"></article>'), ''), /expected image/);
assert.throws(() => assertUniqueImages(reference + '<img src="' + photo.image + '">'), /only once/);

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
const identityData = JSON.parse(await readFile(root + '/assets/photo-identities.json', 'utf8'));
assert.equal(identityData.schemaVersion, 1);
assert(identityData.identities && typeof identityData.identities === 'object');
const localImagePaths = [...new Set([
  ...plantData.plants.map(plant => plant.photo?.image),
  ...offerData.offers.map(offer => offer.image)
].filter(path => typeof path === 'string' && /^assets\/biljke\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)))];
// Hash the real file bytes independently: trusting the supplied identity map
// alone could let a missing or stale entry hide a duplicate from this test.
const actualHashes = new Map(await Promise.all(localImagePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(root + '/' + path)).digest('hex')])));
const pathsByHash = new Map();
for (const [path, hash] of actualHashes) {
  if (!pathsByHash.has(hash)) pathsByHash.set(hash, []);
  pathsByHash.get(hash).push(path);
}
for (const [path, hash] of Object.entries(identityData.identities)) {
  assert.equal(actualHashes.get(path), hash, 'The content identity must match an actual catalog image: ' + path);
}
const duplicateContentGroups = [...pathsByHash.values()].filter(paths => paths.length > 1);
for (const paths of duplicateContentGroups) {
  for (const path of paths) assert.equal(identityData.identities[path], actualHashes.get(path),
    'Every filename for identical image bytes must be covered by the public map: ' + path);
}
imageContentHashes = new Map([...actualHashes].map(([path, hash]) =>
  [normalizedImage(path), 'sha256:' + hash]));
context.identitiesJSON = JSON.stringify(identityData);
run('setPhotoIdentities(JSON.parse(identitiesJSON));');
context.inputJSON = JSON.stringify({ schemaVersion: 1, sourcePolicy: offerData.sourcePolicy,
  plants: plantData.plants, nurseries: nurseryData.nurseries, offers: offerData.offers,
  updatedAt: offerData.updatedAt });
run('state.catalog = validateImport(JSON.parse(inputJSON)).data;');
const offerById = new Map(offerData.offers.map(item => [item.id, item]));
const activeOffers = offerData.offers.filter(item => !['needs_review', 'superseded'].includes(item.recordStatus));
const seenOfferIds = new Set();
let cardsChecked = 0, offersChecked = 0, supplierImagesChecked = 0, sharedReferencesChecked = 0;
let repeatedOriginalsSuppressed = 0, collapsedVariantGroupsChecked = 0;
for (const plant of plantData.plants) {
  context.plantId = plant.id;
  run('renderRecord(plantById(plantId));');
  const markup = elements.get('plant-dialog-content').innerHTML;
  const displayed = articles(markup);
  const expectedIds=JSON.parse(run('JSON.stringify([...new Set(offersFor(plantId).map(o=>o.nurseryId))].flatMap(id=>uniqueDisplayVariants(offersFor(plantId).filter(o=>o.nurseryId===id).sort(compareOfferDimensions)).visible.map(o=>o.id)))'));
  assert.deepEqual(displayed.map(([,id])=>id).sort(),expectedIds.sort(),'Every distinct active offer must be in its picker: '+plant.latinName);
  assert(!/class="(?:supplier-group|offer-card|supplier-variants|deduplicated-offer)\b/.test(markup),'Old duplicate offer cards must not be rendered');
  const referenceHost = plant.photo ? new URL(plant.photo.sourceUrl).hostname : '';
  const allowedReference = plant.photo && !plant.photo.matchLevel &&
    !['commons.wikimedia.org', 'www.gbif.org', 'gbif.org'].includes(referenceHost) ? plant.photo.image : '';
  assertRecordLayout(markup, allowedReference);
  collapsedVariantGroupsChecked += classTags(markup, 'supplier-offer-picker').length;
  const expectedSources = new Map(allowedReference ?
    [[photographIdentity(allowedReference), normalizedImage(allowedReference)]] : []);
  const hidden = hiddenOfferIds(markup), expectedByOffer = new Map();
  // Main offers are visible before expansion, so they have priority over a
  // matching photograph in any supplier's collapsed additional variants.
  const visibleFirst = [...displayed.filter(([, id]) => !hidden.has(id)),
    ...displayed.filter(([, id]) => hidden.has(id))];
  for (const [, id] of visibleFirst) {
    const original = offerById.get(id).image;
    const key = original ? photographIdentity(original) : '';
    if (key && !expectedSources.has(key)) {
      expectedByOffer.set(id, original);
      expectedSources.set(key, normalizedImage(original));
    }
  }
  if (allowedReference) sharedReferencesChecked++;
  for (const [article, id] of displayed) {
    const source = offerById.get(id);
    assert(source, 'Unknown displayed offer: ' + id);
    assert.equal(source.plantId, plant.id, 'An offer must stay with its own plant: ' + id);
    assert(!seenOfferIds.has(id), 'Offer rendered more than once: ' + id);
    const expectedImage = expectedByOffer.get(id) || '';
    assertOfferImage(article, expectedImage);
    if (expectedImage) {
      supplierImagesChecked++;
    } else if (source.image) repeatedOriginalsSuppressed++;
    seenOfferIds.add(id);
    offersChecked++;
  }
  assert.deepEqual(assertUniqueImages(markup).sort(), [...expectedSources.values()].sort(),
    'Only this plant reference and its distinct original offer photographs may appear: ' + plant.latinName);
  cardsChecked++;
}
assert.equal(offersChecked, seenOfferIds.size);
assert(offersChecked<=activeOffers.length);

// Empty space never survives missing image data; adding data restores the image.
assertRecordLayout(missing);
assertOfferImage(articles(missing)[0][0], '');
assert(missing.includes('<small>Obim</small><strong class="offer-cell-value">14–16</strong>'));
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
context.failedPhoto = {closest: selector => selector === '.offer-picker-photo' ? visual : null};
run('hideFailedPhoto(failedPhoto)');
assert(visualRemoved);

console.log(JSON.stringify({ ok: true, sharedReferenceOnceInHeading: true,
  distinctSupplierPhotosPreserved: true, samePlantAndCultivarOnly: true,
  cardsChecked, offersChecked, supplierImagesChecked, sharedReferencesChecked,
  repeatedOriginalsSuppressed, collapsedVariantGroupsChecked,
  uniqueImageSourcesPerCard: true, normalizedUrlsDeduplicated: true,
  localImageFilesHashed: actualHashes.size, duplicateContentGroupsChecked: duplicateContentGroups.length,
  uniqueImageContentPerCard: true, visibleOriginalsTakePriority: true,
  reopenedCardsRestoreImages: true, referencesVisibleWithoutOffers: true,
  allDistinctActiveOffersChecked: true, compactPhotoRecordsSupported: true,
  publicTechnicalPhotoMetadataHidden: true, unsafeLegacyReferencesHidden: true,
  emptyRecordsHaveNoPhotoPlaceholder: true, malformedContainersRejected: true,
  unsafeMetadataRejectedOrEscaped: true, colloquialAliasesNotUsedForIdentity: true }, null, 2));

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, Script } from 'node:vm';

// Run the actual HTML renderer. No browser, external packages or fixed record count.
export async function verifyPanels(root) {
  const [html, plantFile, nurseryFile, offerFile, reviewFile] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'data/biljke.json'), 'utf8'),
    readFile(join(root, 'data/rasadnici.json'), 'utf8'),
    readFile(join(root, 'data/kataloske-stavke.json'), 'utf8'),
    readFile(join(root, 'scripts/archive-measurement-axes.json'), 'utf8')
  ]);
  const plants = JSON.parse(plantFile);
  const nurseries = JSON.parse(nurseryFile);
  const offers = JSON.parse(offerFile);
  const reviewsById = new Map(JSON.parse(reviewFile).records.map(record => [record.id, record]));
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
    const namedDimensionLabels = new Set(['Visina čistog debla', 'Dimenzija oblikovane forme',
      'Dimenzije oblikovane forme', 'Dimenzije oblikovane krošnje', 'Obim / visina iz ponude',
      'Dimenzije sadnice iz ponude', 'Visina / prečnik iz ponude', 'Ponuđena veličina (izvorna oznaka)']);
    const typed = [...['circumference', 'height', 'crownWidth', 'rootBall'].map(key => original[key]),
      ...(original.additionalParameters || []).filter(parameter => namedDimensionLabels.has(parameter.label))
        .flatMap(parameter => parameter.value.split(/[;·]/))].map(parts).filter(Boolean);
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
    }],
    ['record-e74a55a1f76d6a', {
      source: "Acer 'Norwegian Sunset' 20/25",
      sourceFile: 'Acer plat Mauritz Upright 25-30 - 395,00 eur.jpg',
      fields: { 'Obim sadnice': '20–25' }, price: 265
    }],
    ['record-ddf001c975c8e9', {
      source: 'PONUĐENO: Globosa 30-40',
      sourceFile: 'Kopie van Shrubs perrenials.xlsx',
      fields: { 'Ponuđena veličina (izvorna oznaka)': '30–40' }
    }],
    ['record-537f5680ca6acf', {
      source: "Aesculus flava 'Vestita'; 18-20 Cont.",
      sourceFile: 'Copy of cheap trees.xlsx', sourceRow: 4, price: 80.5, currency: 'EUR',
      fields: { 'Obim sadnice': '18–20', 'Visina sadnice': 'Nije navedeno', 'Način isporuke': 'Kontejner (cont)' },
      noGenericDimensions: true
    }],
    ['record-75694722806a8c', {
      source: "Aesculus flava 'Vestita'; 20-25 Cont.",
      sourceFile: 'Copy of cheap trees.xlsx', sourceRow: 5, price: 92, currency: 'EUR',
      fields: { 'Obim sadnice': '20–25', 'Visina sadnice': 'Nije navedeno', 'Način isporuke': 'Kontejner (cont)' },
      noGenericDimensions: true
    }],
    ['record-64fdece00237f3', {
      source: 'Product: Cedrus atlantica Glauca 40-45 500+ STD STEM200 WOODBOX',
      sourceFile: 'Copy of ARBOR_2026_04_15_CONTAINERSTOCK_SALESBOOK.xlsx', sourceRow: 870,
      fields: { 'Obim sadnice': '40–45', 'Visina sadnice': '500+', 'Visina čistog debla': '200',
        'Način isporuke': 'Drvena kutija (WOODBOX)' },
      requiredNote: 'Podaci se odnose na ovu izvornu varijantu ponude.', noGenericDimensions: true
    }],
    ['record-b933c63839c7f4', {
      source: 'Product: Ginkgo biloba Globus 20-25 150+ STD C130L',
      sourceFile: 'Copy of ARBOR_2026_04_15_CONTAINERSTOCK_SALESBOOK.xlsx', sourceRow: 1507,
      fields: { 'Obim sadnice': '20–25', 'Visina sadnice': 'Nije navedeno', 'Oznaka veličine uz STD': '150+' },
      requiredNote: 'Visina sadnice nije posebno navedena u ponudi.', noGenericDimensions: true
    }],
    ['record-02d49f2a062ef4', {
      source: 'Magnolia kobus 4/5m; PONUĐENO: 20/25 295,00', sourceFile: 'MAURITZ .xlsx', sourceRow: 16,
      fields: { 'Obim sadnice': '20–25', 'Visina sadnice': 'Nije navedeno' }, noGenericDimensions: true
    }],
    ...[
      ['record-archive-c734df3af37d6e', 'Euphorbia palustris 18 cm', 'Echinacea itd.jpg', '18 cm (prečnik saksije)'],
      ['record-archive-6b5cb746a91b1f', 'Euphorbia palustris 9 cm', 'Echinacea itd.jpg', '9 cm (prečnik saksije)'],
      ['record-archive-3b6c3b1fb9bb12', 'Sedum makinoi 15 cm 1.75 L', 'Echinacea itd.jpg', '1.75 L / 15 cm (prečnik saksije)'],
      ['record-archive-52d4f5aa52a4c9', 'Hibiscus Carousel Pink Candy, Ghost and geant red 17 cm, 2 L', 'Hibiscus i vinka.jpg', '2 L / 17 cm (prečnik saksije)'],
      ['record-archive-3a9482be6f954d', 'Hibiscus Caroseul Ghost 5 l 23 cm', 'Hibiscus i vinka.jpg', '5 L / 23 cm (prečnik saksije)']
    ].map(([id, source, sourceFile, potSize]) => [id, { source, sourceFile,
      fields: { 'Veličina saksije': potSize, 'Visina sadnice': 'Nije navedeno', 'Obim sadnice': 'Nije navedeno' },
      noGenericDimensions: true }]),
    ...[
      ['record-archive-894616a11a45f9', "Fagus sylvatica 'Riversii' (= F.s.Purp.Major); Specimen, 5xtr, wrb, 200-300 x 400-500"],
      ['record-archive-99e5462ab003eb', "Gleditsia triacanthos 'Spectrum'; Specimen, 5xtr, wrb, multistem, 200-300 x 400-500"]
    ].map(([id, source]) => [id, { source, sourceFile: 'Quotation No 42418134.pdf',
      fields: { 'Širina krošnje': '200–300', 'Visina sadnice': '400–500',
        'Način isporuke': 'Busen u žičanoj korpi (WRB)' }, noGenericDimensions: true }])
  ]);
  const correctedMeasurementNotes = new Map([
    ['record-02d49f2a062ef4', 'Ponuđeno 20/25 je iz D16; tražena visina 4/5m nije potvrđena za ovu varijantu.'],
    ['record-archive-c734df3af37d6e', 'Doslovna neklasifikovana mera iz izvora: 18 cm.'],
    ['record-archive-6b5cb746a91b1f', 'Doslovna neklasifikovana mera iz izvora: 9 cm.'],
    ['record-archive-3b6c3b1fb9bb12', 'Doslovna neklasifikovana mera iz izvora: 15 cm.'],
    ['record-archive-52d4f5aa52a4c9', 'Neoznačena mera iz izvora: 17 cm.'],
    ['record-archive-3a9482be6f954d', 'Neoznačena mera iz izvora: 23 cm.'],
    ...['record-archive-894616a11a45f9', 'record-archive-99e5462ab003eb'].map(id =>
      [id, 'Dimenzije su sačuvane doslovno iz specifikacije: 200-300 x 400-500; WRB je izvorni kod pakovanja.'])
  ]);
  const noteRegressions = new Map([
    { ids: ['record-02d49f2a062ef4'], absent: /20[–/-]25|4[–/-]5m/,
      retained: ['Ponuđeni obim je iz ćelije D16.', 'Tražena visina iz A16 nije potvrđena za ovu varijantu.'] },
    { ids: ['record-bbdfe7b4807273'], absent: /20[–/-]25/,
      retained: ['Obim je prenet iz H44;', 'ostale tražene mere nisu potvrđene za izmenjenu varijantu.'] },
    { ids: ['record-903dfb59efd3b0'], absent: /20[–/-]30|C2/,
      retained: ['Mera iz kolone Size nema označen tip;', 'nije protumačena kao visina ili obim.',
        'Oznaka kontejnera je doslovno preneta iz ponude.'] },
    { ids: ['record-archive-c734df3af37d6e', 'record-archive-6b5cb746a91b1f',
      'record-archive-3b6c3b1fb9bb12', 'record-archive-52d4f5aa52a4c9', 'record-archive-3a9482be6f954d'],
      absent: /(?:18|9|15|17|23) cm|neklasifikovana mera|Neoznačena mera|Vrsta ove mere nije navedena/,
      retained: ['Tip sadnice nije izričito označen u ovom redu ponude; nije pretpostavljen.'] },
    { ids: ['record-archive-894616a11a45f9', 'record-archive-99e5462ab003eb'], absent: /200[–-]300|400[–-]500|WRB je izvorni kod pakovanja/,
      retained: ['Jedinica dužine nije navedena uz ovu meru u izvoru.'] },
    { ids: ['record-e1e3c0fad230dc', 'record-9c51ac6e174a1e', 'record-5ec2f15aed75ee',
      'record-69109de9535931', 'record-f3be20d5667456', 'record-6e1c9ef02b69af',
      'record-eb3f19f1a35ce1', 'record-d2e9fdf74f476c'], absent: /clt3/,
      retained: ['Mere i oznaka kontejnera preneti su iz odštampanog reda upita.',
        'Ćelija jedinične cene je prazna;', 'Ponuđena raspoloživost ove stavke nije potvrđena.'] },
    { ids: ['record-ddf001c975c8e9'], absent: /30[–/-]40/,
      retained: ['Ponuđena je sorta Globosa; veličina je preneta iz F10;',
        'tražena sorta Silver Globus i veličina 40/60 nisu preneti na ovu alternativu.',
        'Vrsta mere i njena jedinica nisu navedene.'] },
    { ids: ['record-abd2b1321ff2be'],
      retained: ['Fascikla nosi oznaku 30-35, dok naziv same fotografije glasi 25-30HO DRKL; razlika nije prećutno usklađena.'] },
    { ids: ['record-e74a55a1f76d6a'], absent: /20[–/-]25/,
      retained: ['Tip sadnice nije izričito označen u ovom redu ponude; nije pretpostavljen.',
        'Mere su prenete iz tačne ponuđene varijante; jedinica je navedena samo gde postoji u izvoru.'] }
  ].flatMap(regression => regression.ids.map(id => [id, regression])));
  const checkedNoteRegressions = new Set();
  const checkedNoteProvenance = new Set();
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
      if (Object.hasOwn(regression, 'price')) assert.equal(original.price, regression.price,
        label + 'cena iz poznatog izvornog reda mora ostati nepromenjena.');
      if (Object.hasOwn(regression, 'currency')) {
        const confirmedEUR = !regression.currency && original.currencyStatus === 'owner_confirmed' &&
          original.currencyEvidence?.origin === 'catalogue_owner_confirmation' &&
          original.currencyEvidence?.reference === 'docs/currency-confirmation.json';
        assert.equal(original.currency, confirmedEUR ? 'EUR' : regression.currency,
          label + 'valuta mora odgovarati izvoru ili izricitoj potvrdi vlasnice kataloga.');
      }
      if (Object.hasOwn(regression, 'sourceRow')) assert.equal(original.sourceEvidence?.row, regression.sourceRow,
        label + 'regresioni podatak mora ostati vezan za tačan red izvora.');
      if (regression.requiredNote) assert.equal(offer.dataAccuracyNote, regression.requiredNote,
        label + 'obavezna napomena mora odgovarati proverenoj varijanti.');
      if (regression.noGenericDimensions) assert(!values.has('Dimenzija iz ponude') && !values.has('Nerazvrstana mera iz ponude'),
        label + 'raspoređena ili isključivo tražena mera ne sme ostati kao dodatna generička dimenzija.');
      for (const [name, expected] of Object.entries(regression.fields)) {
        assert.equal(values.get(name), esc(expected),
          label + 'izvor „' + regression.source + '” zahteva ' + name + ': ' + expected + ' u glavnom panelu.');
      }
      checkedSourceRegressions.add(offer.id);
    }
    const footer = markup.split('<div class="offer-footer">')[1] || '';
    assert(!footer.includes('Specifikacija izvora:') && !footer.includes('Napomena o presađivanju:'),
      label + 'specifikacija i presađivanje ne smeju ostati izdvojeni u fusnoti.');
    const noteRegression = noteRegressions.get(offer.id);
    if (noteRegression) {
      if (noteRegression.absent) assert(!noteRegression.absent.test(footer),
        label + 'mera iz glavnog panela ne sme ponovo biti u redundantnoj napomeni.');
      for (const text of noteRegression.retained) assert(footer.includes(esc(text)),
        label + 'napomena mora sačuvati kontekst izvora: ' + text);
      checkedNoteRegressions.add(offer.id);
    }
    if (correctedMeasurementNotes.has(offer.id)) {
      const review = reviewsById.get(offer.id);
      const correction = review?.displayNoteCorrections?.measurementNote;
      assert.equal(correction?.expectedValue, correctedMeasurementNotes.get(offer.id),
        label + 'prethodna napomena mora ostati sačuvana u registru izvora.');
      assert.equal(original.measurementNote || '', correction?.value,
        label + 'prikazana napomena mora odgovarati odobrenoj ispravci iz izvora.');
      assert.equal(review.expected.source.sourceSha256, original.sourceEvidence?.sourceSha256,
        label + 'ispravka napomene mora biti vezana za isti izvorni prilog.');
      checkedNoteProvenance.add(offer.id);
    }
    const pricePanel = markup.match(/<div class="offer-price"><strong>([\s\S]*?)<\/strong>/)?.[1];
    const expectedPrice = offer.price === null ? 'Cena nije navedena' :
      new Intl.NumberFormat('sr-Latn-RS',
        { style: 'currency', currency: offer.currency || 'EUR', maximumFractionDigits: 2 }).format(offer.price);
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
  assert.deepEqual([...checkedNoteRegressions].sort(), [...noteRegressions.keys()].sort(),
    'Sve poznate napomene moraju proći proveru uklanjanja ponovljenih mera i čuvanja konteksta.');
  assert.deepEqual([...checkedNoteProvenance].sort(), [...correctedMeasurementNotes.keys()].sort(),
    'Izvorni tekst svih ispravljenih napomena mora ostati sačuvan u registru izvora.');
  const originalNotes = data.offers.map(({ id, dataAccuracyNote, measurementNote }) => ({ id, dataAccuracyNote, measurementNote }));
  const notesAfterRendering = JSON.parse(run('JSON.stringify(state.catalog.offers.map(({ id, dataAccuracyNote, measurementNote }) => ({ id, dataAccuracyNote, measurementNote })))'));
  assert.deepEqual(notesAfterRendering, originalNotes, 'Prikaz ne sme menjati izvorne napomene u podacima.');
  return { plants: data.plants.length, records: data.offers.length, activePanels: active.length,
    hiddenPanelsChecked: hidden.length, knownParameters, sourceSpecificationsPreservedInData,
    transplantValuesInMainPanel, additionalParametersInMainPanel, genericDimensionDuplicatesRemoved,
    sourceDerivedRegressions: checkedSourceRegressions.size,
    measurementNoteRegressions: checkedNoteRegressions.size,
    reviewedNoteProvenanceChecks: checkedNoteProvenance.size,
    originalNotesPreservedInData: true,
    explicitSourceColumnsChecked,
    allFieldsInMainPanel: true, rawSourcePreservedOnlyInData: true, pricesInPricePanel: true };
}

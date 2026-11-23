import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {updateExchangeRates} from '../update_exchange_rates.mjs';
import {refreshFolder} from '../refresh_folder_prices.mjs';
import {normalizeOfferCurrency, NBS_URL} from '../currency-normalization.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, 'assets/vendor/xlsx-0.20.3.full.min.js'));
const rates = {
  schemaVersion: 1, base: 'EUR', quote: 'RSD', rate: 117.6203,
  rateDate: '2026-11-13', source: 'NBS official middle rate', sourceUrl: NBS_URL,
  listNumber: '217', fetchedAt: '2026-11-13T07:00:00Z',
};
const priceFields = ['price', 'currency', 'currencyStatus', 'currencyEvidence',
  'sourceAmount', 'sourceCurrency', 'sourceCurrencyEvidence', 'priceConversion', 'priceEvidence'];
const pricing = offer => Object.fromEntries(priceFields.filter(key => Object.hasOwn(offer, key))
  .map(key => [key, structuredClone(offer[key])]));

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'demetra-eur-only-'));
  t.after(async () => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('demetra-eur-only-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return dir;
}

async function initialFiles(dir) {
  const repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, 'data'), {recursive: true});
  const rateText = JSON.stringify(rates, null, 2) + '\n';
  const catalogText = '{"offers":[],"updatedAt":"preserve-this-value"}\n';
  await fs.writeFile(path.join(repo, 'data/exchange-rates.json'), rateText);
  await fs.writeFile(path.join(repo, 'data/kataloske-stavke.json'), catalogText);
  return {repo, rateText, catalogText};
}

test('retired exchange-rate API never requests NBS or depends on repository files', async t => {
  const dir = await temporary(t);
  const {repo, rateText, catalogText} = await initialFiles(dir);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Network access must stay disabled'); };
  for (const target of [repo, path.join(dir, 'nonexistent-repository')]) {
    const result = await updateExchangeRates(target, {fetchImpl});
    assert.equal(result.enabled, false);
    assert.equal(result.skipped, true);
  }
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(path.join(repo, 'data/exchange-rates.json'), 'utf8'), rateText);
  assert.equal(await fs.readFile(path.join(repo, 'data/kataloske-stavke.json'), 'utf8'), catalogText);
  await assert.rejects(fs.access(path.join(dir, 'nonexistent-repository')), {code: 'ENOENT'});
});

test('direct exchange-rate CLI stays disabled and preserves saved rates and catalog bytes', async t => {
  const dir = await temporary(t);
  const {repo, rateText, catalogText} = await initialFiles(dir);
  const guard = 'globalThis.fetch=()=>{throw new Error("Unexpected network request");};';
  const result = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(guard),
    path.join(root, 'scripts/update_exchange_rates.mjs'), '--repo', repo,
  ], {encoding: 'utf8', timeout: 10000, windowsHide: true});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.enabled, false);
  assert.equal(report.skipped, true);
  assert.equal(await fs.readFile(path.join(repo, 'data/exchange-rates.json'), 'utf8'), rateText);
  assert.equal(await fs.readFile(path.join(repo, 'data/kataloske-stavke.json'), 'utf8'), catalogText);
});

test('scheduled price verification has no exchange-rate writer or publication privileges', async () => {
  const workflow = await fs.readFile(path.join(root, '.github/workflows/update-prices.yml'), 'utf8');
  assert.match(workflow, /contents:\s*read\b/);
  assert.doesNotMatch(workflow, /(?:contents|pages|id-token):\s*write\b/);
  assert.doesNotMatch(workflow, /^\s*normalize-currency:/m);
  assert.doesNotMatch(workflow, /\bnode\s+scripts\/update_exchange_rates\.mjs\b/);
  assert.doesNotMatch(workflow, /\bgit\s+(?:add|commit|push)\b/);
  assert.match(workflow, /persist-credentials:\s*false\b/);
  assert.match(workflow, /\bnode\s+scripts\/check-price-sync\.mjs\b/);
});

test('EUR-only refresh holds a changed RSD row while updating another EUR row and accepts a proven EUR transition', async t => {
  const dir = await temporary(t);
  const {repo, rateText} = await initialFiles(dir);
  const source = path.join(dir, 'source');
  await fs.mkdir(source);
  const bookFile = path.join(source, 'offer.xlsx');
  async function sourceBook(first, second) {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Girth', 'Unit price'],
      ["Acer campestre 'Elsrijk'", '18-20', first],
      ["Tilia cordata 'Greenspire'", '20-25', second],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, 'Ponuda');
    const bytes = XLSX.write(book, {type: 'buffer', bookType: 'xlsx'});
    await fs.writeFile(bookFile, bytes);
    return createHash('sha256').update(bytes).digest('hex');
  }
  const sha = await sourceBook('5800 RSD', '80.50 EUR');
  function offer(id, row, value, currency) {
    return normalizeOfferCurrency({
      id, plantId: id + '-plant', nurseryId: 'reviewed-nursery',
      price: value, currency, circumference: row === 2 ? '18-20' : '20-25',
      image: 'preserved-photo.jpg', sourceDate: '2026-11-13',
      sourceEvidence: {archivePath: 'Rasadnici ponude/offer.xlsx', sourceSha256: sha,
        sheet: 'Ponuda', priceCell: 'C' + row},
      priceEvidence: {amount: value, currency, sheet: 'Ponuda', priceCell: 'C' + row,
        reviewedRow: 'original supplier row ' + row},
      currencyEvidence: {currency, origin: 'reviewed-original-document'},
      sourceCurrencyEvidence: {currency, origin: 'reviewed-original-document'},
    }, rates, {now: '2026-11-13T07:00:00Z'});
  }
  await fs.writeFile(path.join(repo, 'data/kataloske-stavke.json'), JSON.stringify({
    sourcePolicy: {nonPhoto: 'rasadnici-ponude-zip', onlineUpdates: ['photos']},
    offers: [offer('historical-rsd', 2, 5800, 'RSD'), offer('native-eur', 3, 80.5, 'EUR')],
  }));
  const options = {source, repo, stateFile: path.join(dir, 'state.json'),
    reportFile: path.join(dir, 'report.json'), apply: true, euroInputsOnly: true,
    now: '2026-11-23T07:00:00Z'};
  let run = await refreshFolder(options);
  assert.equal(run.report.verified, 2, 'Unchanged historical RSD remains verifiable');
  assert.equal(run.report.updated, 0);
  assert.equal(run.report.pending.length, 0);
  const rsdBefore = pricing(run.document.offers[0]);
  const eurBefore = structuredClone(run.document.offers[1]);

  await sourceBook('6200 RSD', '92 EUR');
  run = await refreshFolder(options);
  const rsd = run.document.offers[0], eur = run.document.offers[1];
  assert.equal(run.report.updated, 1);
  assert.equal(run.report.verified, 1);
  assert.deepEqual(run.report.changes.map(change => change.offerId), ['native-eur']);
  assert.equal(run.report.pending.length, 1);
  assert.equal(run.report.pending[0].offerId, 'historical-rsd');
  assert.match(run.report.pending[0].reason, /EUR|evr|evro/i);
  assert.deepEqual(pricing(rsd), rsdBefore, 'Blocked RSD input cannot change any price or source proof');
  assert.equal(rsd.priceRefresh.status, 'pending');
  assert.equal(eur.price, 92);
  assert.equal(eur.sourceAmount, 92);
  assert.equal(eur.sourceCurrency, 'EUR');
  assert.equal(eur.priceEvidence.folderUpdate.previousAmount, 80.5);
  assert.equal(eur.image, eurBefore.image);
  assert.equal(eur.sourceDate, eurBefore.sourceDate);
  assert.equal(eur.circumference, eurBefore.circumference);
  assert.equal(await fs.readFile(path.join(repo, 'data/exchange-rates.json'), 'utf8'), rateText);

  await sourceBook('60 EUR', '92 EUR');
  run = await refreshFolder(options);
  const transitioned = run.document.offers[0];
  assert.equal(run.report.updated, 1);
  assert.equal(run.report.pending.length, 0);
  assert.equal(transitioned.price, 60);
  assert.equal(transitioned.sourceAmount, 60);
  assert.equal(transitioned.sourceCurrency, 'EUR');
  assert.equal(transitioned.currency, 'EUR');
  assert.equal(transitioned.priceConversion, undefined);
  assert.equal(transitioned.priceEvidence.currency, 'EUR');
  assert.equal(transitioned.priceEvidence.folderUpdate.previousAmount, 5800);
  assert.equal(transitioned.priceEvidence.folderUpdate.method, 'unchanged-identity-row-and-header');
  assert.equal(transitioned.image, 'preserved-photo.jpg');
  assert.equal(await fs.readFile(path.join(repo, 'data/exchange-rates.json'), 'utf8'), rateText);

  run = await refreshFolder(options);
  assert.equal(run.report.updated, 0, 'Repeated EUR refresh does not convert or update the source again');
  assert.equal(run.report.pending.length, 0);
  assert.equal(run.document.offers[0].price, 60);
});

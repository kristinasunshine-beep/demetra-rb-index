(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DemetraQuoteCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const STORAGE_KEY = 'demetra-rb-index:moja-ponuda:v1';
  const MAX_ITEMS = 4000;
  const COMPANY = Object.freeze({
    name: 'DEMETRA RB', registration: '06517293', taxId: '101713319',
    address: 'Zarija Vujoševića 80', city: '11070 Novi Beograd',
    phone: '+381 11 3112798', email: 'office@demetrarb.com',
    website: 'https://demetrarb.com/BG/',
    description: 'Pejzažna arhitektura, uređenje i održavanje zelenih površina.'
  });
  const text = (value, max = 16000) => String(value ?? '').slice(0, max);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function defaultMeta() {
    return { number: '', date: localDate(), preparedBy: '', preparedPhone: '',
      client: '', address: '', city: '', email: '', phone: '', taxId: '', registration: '',
      description: COMPANY.description, note: '' };
  }
  function normalizeMeta(value) {
    const result = defaultMeta();
    if (plain(value)) for (const key of Object.keys(result)) {
      if (typeof value[key] === 'string') result[key] = text(value[key], key === 'note' ? 4000 : 500);
    }
    return result;
  }
  function pairs(value) {
    if (!Array.isArray(value) || value.length > 150) throw new Error('Neispravni parametri stavke.');
    return value.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Neispravan parametar stavke.');
      return [text(pair[0], 200), typeof pair[1] === 'number' && Number.isFinite(pair[1]) ? pair[1] : text(pair[1])];
    });
  }
  function normalizeItem(value) {
    if (!plain(value) || !value.offerId || !value.plantId || !value.latinName) throw new Error('Neispravna stavka ponude.');
    const item = {
      offerId: text(value.offerId, 200), plantId: text(value.plantId, 200),
      nurseryId: text(value.nurseryId, 200), latinName: text(value.latinName, 500),
      commonName: text(value.commonName, 500), nursery: text(value.nursery, 500),
      country: text(value.country, 200), unit: text(value.unit || 'kom', 30),
      currency: text(value.currency || 'EUR', 10).toUpperCase(),
      sourcePriceCurrency: text(value.sourcePriceCurrency || value.currency || 'EUR', 10).toUpperCase(),
      sourcePrice: value.sourcePrice === null || value.sourcePrice === undefined ? null : Number(value.sourcePrice),
      parameters: pairs(value.parameters || []), details: pairs(value.details || []),
      quantity: text(value.quantity ?? '1', 40), price: text(value.price ?? value.sourcePrice ?? '', 40),
      note: text(value.note, 4000), priceEdited: value.priceEdited === true
    };
    if (!/^[A-Z]{3}$/.test(item.currency) || !/^[A-Z]{3}$/.test(item.sourcePriceCurrency)) throw new Error('Valuta stavke nije ispravna.');
    if (item.sourcePrice !== null && (!Number.isFinite(item.sourcePrice) || item.sourcePrice < 0)) {
      throw new Error('Neispravna kataloška cena.');
    }
    if (typeof value.priceEdited !== 'boolean') {
      const entered = parseDecimal(item.price);
      item.priceEdited = item.price.trim() !== '' && (!entered.valid || item.sourcePrice === null || entered.value !== item.sourcePrice);
    }
    return item;
  }
  function emptyQuote() { return { version: VERSION, meta: defaultMeta(), items: [] }; }
  function parseQuote(raw) {
    if (!raw) return emptyQuote();
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!plain(value) || value.version !== VERSION || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
      throw new Error('Sačuvana ponuda ima nepoznat oblik.');
    }
    const items = value.items.map(normalizeItem);
    if (new Set(items.map(item => item.offerId)).size !== items.length) throw new Error('Ponuda sadrži duplirane stavke.');
    return { version: VERSION, meta: normalizeMeta(value.meta), items };
  }
  function addItem(quote, snapshot) {
    const item = normalizeItem(snapshot);
    if (quote.items.some(row => row.offerId === item.offerId)) return false;
    if (quote.items.length >= MAX_ITEMS) throw new Error('Dostignut je maksimalan broj stavki u jednoj ponudi.');
    quote.items.push(item);
    return true;
  }
  function refreshCatalogPrices(quote, getItem) {
    let changed = false;
    for (const item of quote.items) {
      const snapshot = getItem(item.offerId);
      if (!snapshot) continue;
      const current = normalizeItem(snapshot);
      if (item.sourcePrice !== current.sourcePrice || item.sourcePriceCurrency !== current.sourcePriceCurrency) {
        item.sourcePrice = current.sourcePrice;
        item.sourcePriceCurrency = current.sourcePriceCurrency;
        changed = true;
      }
      if (!item.priceEdited && (item.price !== current.price || item.currency !== current.currency)) {
        item.price = current.price;
        item.currency = current.currency;
        changed = true;
      }
    }
    return changed;
  }
  function parseDecimal(raw, { decimals = 4, positive = false, max = 10000000 } = {}) {
    let value = String(raw ?? '').trim().replace(/[\s\u00a0\u202f]/g, '');
    if (!value) return { valid: false, value: null, reason: 'Unesite vrednost.' };
    if (value.includes(',') && value.includes('.')) {
      if (/^\d{1,3}(\.\d{3})+,\d+$/.test(value)) value = value.replaceAll('.', '').replace(',', '.');
      else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(value)) value = value.replaceAll(',', '');
      else return { valid: false, value: null, reason: 'Proverite zapis broja.' };
    } else value = value.replace(',', '.');
    if (!new RegExp('^\\d+(?:\\.\\d{1,' + decimals + '})?$').test(value)) {
      return { valid: false, value: null, reason: 'Unesite nenegativan broj sa najviše ' + decimals + ' decimale.' };
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number > max || (positive && number <= 0)) {
      return { valid: false, value: null, reason: positive ? 'Količina mora biti veća od nule i najviše 100.000.' : 'Cena mora biti između 0 i 10.000.000.' };
    }
    return { valid: true, value: number, reason: '' };
  }
  function lineResult(item) {
    const quantity = parseDecimal(item.quantity, { decimals: 3, positive: true, max: 100000 });
    const price = parseDecimal(item.price);
    if (!quantity.valid || !price.valid) return { valid: false, quantity, price, cents: null, amount: null };
    // Use integers so decimal-comma input and half-cent rounding agree with ROUND in Excel.
    const numerator = BigInt(Math.round(quantity.value * 1000)) * BigInt(Math.round(price.value * 10000));
    const cents = Number((numerator + 50000n) / 100000n);
    return { valid: true, quantity, price, cents, amount: cents / 100 };
  }
  function summarize(quote) {
    const rows = quote.items.map(lineResult);
    const buckets = new Map();
    rows.forEach((row,index)=>buckets.set(quote.items[index].currency,(buckets.get(quote.items[index].currency)||0)+(row.cents??0)));
    const totals = [...buckets].map(([currency,cents])=>({currency,cents,amount:cents/100}));
    const cents = totals.length > 1 ? null : totals[0]?.cents ?? 0;
    const invalidCount = rows.filter(row => !row.valid).length;
    const safe = totals.every(total=>Number.isSafeInteger(total.cents));
    return { rows, totals, cents, amount: cents === null ? null : cents / 100, invalidCount,
      ready: rows.length > 0 && !invalidCount && safe, safe };
  }
  function money(value, currency = 'EUR') { return new Intl.NumberFormat('sr-Latn-RS', { style: 'currency', currency }).format(value); }
  function compactParameters(item) {
    const tax = item.details.find(([label])=>label==='PDV')?.[1] || 'Nije navedeno u izvornoj ponudi';
    const available = item.parameters.filter(([, value]) => value !== '' && value !== null &&
      !/^nije navedeno|^nepoznat/i.test(String(value)));
    const lines = available.length ? available.map(([label,value]) => `${label}: ${value}`) :
      ['Parametri nisu navedeni u katalogu.'];
    lines.push('PDV: ' + tax);
    if (item.note) lines.push('Napomena: ' + item.note);
    return lines.join('\n');
  }
  const xmlEscape = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  function spreadsheetXml(xml) {
    const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    if (!xml.includes('xmlns:x="' + namespace + '"')) return xml;
    return xml.replace('xmlns:x="' + namespace + '"','xmlns="' + namespace + '"').replace(/<(\/?)x:/g,'<$1');
  }
  function cell(ref, value, style = '', formula = '') {
    const attrs = ` r="${ref}"${style ? ` s="${style}"` : ''}`;
    if (formula) return `<c${attrs}><f>${xmlEscape(formula)}</f><v>${value}</v></c>`;
    if (value === '' || value === null || value === undefined) return `<c${attrs}/>`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c${attrs}><v>${value}</v></c>`;
    return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }
  function rowStyles(xml, number, columns) {
    const row = xml.match(new RegExp('<row\\b[^>]*\\br="' + number + '"[^>]*>[\\s\\S]*?<\\/row>'))?.[0];
    if (!row) throw new Error('Nedostaje red Excel obrasca.');
    return columns.map(col => {
      const match = row.match(new RegExp('<c\\b(?=[^>]*\\br="' + col + number + '")[^>]*>'))?.[0];
      return match?.match(/\bs="(\d+)"/)?.[1] || '';
    });
  }
  function replaceCell(xml, ref, value) {
    const re = new RegExp('<c\\b(?=[^>]*\\br="' + ref + '")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)');
    const old = xml.match(re)?.[0];
    if (!old) throw new Error('Nedostaje polje Excel obrasca: ' + ref);
    return xml.replace(re, cell(ref, value, old.match(/\bs="(\d+)"/)?.[1] || ''));
  }
  function replaceRows(xml, first, generated, endColumn, last) {
    const original = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1];
    if (original === undefined) throw new Error('Neispravan Excel obrazac.');
    const keep = [...original.matchAll(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)]
      .filter(match => Number(match[0].match(/\br="(\d+)"/)?.[1]) < first).map(match => match[0]).join('');
    xml = xml.replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, '<sheetData>' + keep + generated + '</sheetData>');
    const dimension = `<dimension ref="A1:${endColumn}${last}"/>`;
    return /<dimension\b/.test(xml) ? xml.replace(/<dimension\b[^>]*\/>/, dimension) :
      xml.replace('<sheetViews',dimension+'<sheetViews');
  }
  // The source workbook contains an obsolete contact block in rows 16–19.
  // Keep the memorandum, logo/accreditation rows and the two active contact
  // columns (through row 15), then move the table title, optional note and
  // table header from rows 20–22 to rows 16–18. Plant data begins at row 19.
  function compactQuoteHeader(xml) {
    const match = xml.match(/<sheetData\\b[^>]*>([\\s\\S]*?)<\\/sheetData>/);
    if (!match) throw new Error('Nedostaje sadržaj Excel obrasca.');
    const rows = [...match[1].matchAll(/<row\\b[^>]*(?:\\/?>|>[\\s\\S]*?<\\/row>)/g)]
      .map(([source]) => ({ source, number: Number(source.match(/\\br="(\\d+)"/)?.[1]) }));
    const byNumber = new Map(rows.map(row => [row.number, row.source]));
    for (const number of [20, 21, 22]) if (!byNumber.has(number)) {
      throw new Error('Nedostaje naslov ili zaglavlje Excel tabele.');
    }
    const move = (source, from, to) => source
      .replace(new RegExp('(<row\\\\b[^>]*\\\\br=")' + from + '(")'), '$1' + to + '$2')
      .replace(new RegExp('(\\\\br=")([A-Z]{1,3})' + from + '(")', 'g'),
        (_, prefix, column, suffix) => prefix + column + to + suffix);
    const compact = rows.filter(row => row.number >= 1 && row.number <= 15)
      .map(row => row.source)
      .concat([move(byNumber.get(20), 20, 16), move(byNumber.get(21), 21, 17),
        move(byNumber.get(22), 22, 18)]).join('');
    xml = xml.replace(/<sheetData\\b[^>]*>[\\s\\S]*?<\\/sheetData>/,
      '<sheetData>' + compact + '</sheetData>');
    // Reposition the table's merged title/note/header cells, but discard
    // merges belonging to the deleted, duplicated contact-information block.
    return xml.replace(/<mergeCells\\b[^>]*>[\\s\\S]*?<\\/mergeCells>/, section => {
      const kept = [];
      for (const [tag] of section.matchAll(/<mergeCell\\b[^>]*\\bref="[^"]+"[^>]*\\/>/g)) {
        const ref = tag.match(/\\bref="([A-Z]+)(\\d+):([A-Z]+)(\\d+)"/);
        if (!ref) continue;
        const first = Number(ref[2]), last = Number(ref[4]);
        if (first <= 15 && last <= 15) kept.push(tag);
        else if (first >= 20 && last <= 22) {
          const relocate = number => number - 4;
          kept.push(tag.replace(ref[0], 'ref="' + ref[1] + relocate(first) +
            ':' + ref[3] + relocate(last) + '"'));
        }
      }
      return kept.length ? '<mergeCells count="' + kept.length + '">' +
        kept.join('') + '</mergeCells>' : '';
    });
  }

  // Make the "Jed." (unit) column wide enough for ordinary Serbian words.
  // Do not alter unit data, formulas, template colors or the other eight columns.
  // Split any template <col> group that spans E so no adjacent widths change.
  function setColumnWidth(xml, columnNumber, width) {
    const columnTag = /<col\b[^>]*\/>/g;
    const updateAttribute = (tag, name, value) => {
      const attribute = new RegExp('\\b' + name + '="[^"]*"');
      if (attribute.test(tag)) return tag.replace(attribute, name + '="' + value + '"');
      return tag.replace(/\s*\/>$/, ' ' + name + '="' + value + '"/>');
    };
    const segment = (tag, min, max, targetWidth = null) => {
      let revised = updateAttribute(updateAttribute(tag, 'min', min), 'max', max);
      if (targetWidth !== null) {
        revised = updateAttribute(revised, 'width', targetWidth);
        revised = updateAttribute(revised, 'customWidth', 1).replace(/\sbestFit="[^"]*"/, '');
      }
      return revised;
    };
    const custom = '<col min="' + columnNumber + '" max="' + columnNumber +
      '" width="' + width + '" customWidth="1"/>';
    const section = xml.match(/<cols\b[^>]*>[\s\S]*?<\/cols>/)?.[0];
    if (!section) {
      if (!/<sheetData\b/.test(xml)) throw new Error('Nedostaje tabela za Excel izvoz.');
      return xml.replace(/<sheetData\b/, '<cols>' + custom + '</cols><sheetData');
    }
    let changed = false;
    const revised = section.replace(columnTag, tag => {
      const min = Number(tag.match(/\bmin="(\d+)"/)?.[1]);
      const max = Number(tag.match(/\bmax="(\d+)"/)?.[1]);
      if (!Number.isInteger(min) || !Number.isInteger(max) || columnNumber < min || columnNumber > max) return tag;
      changed = true;
      return (min < columnNumber ? segment(tag, min, columnNumber - 1) : '') +
        segment(tag, columnNumber, columnNumber, width) +
        (max > columnNumber ? segment(tag, columnNumber + 1, max) : '');
    });
    return xml.replace(section, changed ? revised :
      revised.replace(/<\/cols>$/, custom + '</cols>'));
  }

  function lineHeight(values, widths, min = 30) {
    const lines = Math.max(...values.map((value, index) => String(value ?? '').split('\n')
      .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / widths[index])), 0)));
    return Math.min(400, Math.max(min, lines * 13 + 12));
  }
  function rowHeight(xml, number, height) {
    return xml.replace(new RegExp('<row\\b(?=[^>]*\\br="' + number + '")[^>]*>'),tag=>{
      tag=tag.replace(/\sht="[^"]*"/,'').replace(/\scustomHeight="[^"]*"/,'');
      return tag.slice(0,-1)+` ht="${height}" customHeight="1">`;
    });
  }
  async function buildXlsx(template, quoteValue, Zip) {
    const quote = parseQuote(quoteValue), total = summarize(quote);
    if (!validDate(quote.meta.date)) throw new Error('Unesite ispravan datum ponude.');
    if (!total.ready) throw new Error('Popunite ispravnu količinu i cenu za svaku stavku pre preuzimanja.');
    const zip = await Zip.loadAsync(template, { checkCRC32: true });
    let main = spreadsheetXml(await zip.file('xl/worksheets/sheet1.xml').async('string'));
    // The template's former 6-character unit column broke "jedinica iz
    // cenovnika" into fragments, sometimes leaving a single letter on a line.
    // A 16.5-character width wraps the original phrase in two natural lines.
    main = setColumnWidth(main, 5, 16.5);
    const meta = quote.meta;
    const offerDate = meta.date.split('-').reverse().join('.') + '.';
    const fields = {
      A4: meta.description, A5: meta.number ? 'Ponuda br. ' + meta.number : 'PONUDA',
      A9: 'Ponudu izradio/la: ' + meta.preparedBy, A11: 'Br. tel.: ' + meta.preparedPhone,
      A13: 'U Beogradu, ' + offerDate,
      G9: meta.client, G10: meta.address, G11: meta.city, G12: meta.email,
      G13: meta.phone, G14: meta.taxId, G15: meta.registration, A21: meta.note
    };
    for (const [ref, value] of Object.entries(fields)) main = replaceCell(main, ref, value);
    for (const [number, values, widths, minimum] of [
      [4, [meta.description], [95], 25], [9, [fields.A9, fields.G9], [95, 35], 34],
      [10, [meta.address], [35], 23], [11, [fields.A11, fields.G11], [95, 35], 23],
      [12, [meta.email], [35], 23], [13, [fields.A13, fields.G13], [95, 35], 23],
      [14, [meta.taxId], [35], 23], [15, [meta.registration], [35], 23],
      [21, [meta.note], [160], meta.note.trim() ? 24 : 8]
    ]) main = rowHeight(main, number, lineHeight(values, widths, minimum));
    const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const styles = rowStyles(main, 23, cols), sumStyles = rowStyles(main, 24, cols);
    main = compactQuoteHeader(main);
    let rows = '';
    quote.items.forEach((item, index) => {
      const number = index + 19, result = total.rows[index];
      const values = [index + 1, item.latinName, compactParameters(item), item.nursery, item.unit,
        result.quantity.value, result.price.value, result.amount, item.currency];
      const height = lineHeight(values, [5, 28, 45, 22, 16, 11, 14, 15, 7], 60);
      rows += `<row r="${number}" ht="${height}" customHeight="1">` + values.map((value, column) =>
        cell(cols[column] + number, value, styles[column], column === 7 ? `ROUND(F${number}*G${number},2)` : '')).join('') + '</row>';
    });
    const lastData = 18 + quote.items.length, lastRow = lastData + total.totals.length;
    total.totals.forEach((subtotal,index)=>{
      const sumRow = lastData + index + 1;
      const formula = total.totals.length === 1 ? `SUM(H19:H${lastData})` :
        `SUMIFS(H19:H${lastData},I19:I${lastData},"${subtotal.currency}")`;
      rows += `<row r="${sumRow}" ht="30" customHeight="1">` + cell('G' + sumRow, 'UKUPNO', sumStyles[6]) +
        cell('H' + sumRow, subtotal.amount, sumStyles[7], formula) + cell('I' + sumRow,subtotal.currency,sumStyles[8]) + '</row>';
    });
    main = replaceRows(main, 19, rows, 'I', lastRow);
    main = main.replace(/sqref="F23"/g, `sqref="F19:F${lastData}"`).replace(/sqref="G23"/g, `sqref="G19:G${lastData}"`);
    zip.file('xl/worksheets/sheet1.xml', main);
    let workbook = spreadsheetXml(await zip.file('xl/workbook.xml').async('string'));
    const calc = '<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/>';
    workbook = /<calcPr\b/.test(workbook) ? workbook.replace(/<calcPr\b[^>]*\/>/, calc) : workbook.replace('</workbook>', calc + '</workbook>');
    zip.file('xl/workbook.xml', workbook);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function filename(meta) {
    const suffix = text(meta.number || meta.date, 80).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'ponuda';
    return 'Demetra-RB-ponuda-' + suffix + '.xlsx';
  }
  return { VERSION, STORAGE_KEY, COMPANY, MAX_ITEMS, localDate, validDate, defaultMeta, normalizeMeta,
    emptyQuote, parseQuote, normalizeItem, addItem, refreshCatalogPrices, parseDecimal, lineResult, summarize, money,
    compactParameters, buildXlsx, filename, xmlEscape };
});

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
    const match = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
    if (!match) throw new Error('Nedostaje sadržaj Excel obrasca.');
    const rows = [...match[1].matchAll(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)]
      .map(([source]) => ({ source, number: Number(source.match(/\br="(\d+)"/)?.[1]) }));
    const byNumber = new Map(rows.map(row => [row.number, row.source]));
    for (const number of [20, 21, 22]) if (!byNumber.has(number)) {
      throw new Error('Nedostaje naslov ili zaglavlje Excel tabele.');
    }
    const move = (source, from, to) => source
      .replace(new RegExp('(<row\\b[^>]*\\br=")' + from + '(")'), '$1' + to + '$2')
      .replace(new RegExp('(\\br=")([A-Z]{1,3})' + from + '(")', 'g'),
        (_, prefix, column, suffix) => prefix + column + to + suffix);
    const compact = rows.filter(row => row.number >= 1 && row.number <= 15)
      .map(row => row.source)
      .concat([move(byNumber.get(20), 20, 16), move(byNumber.get(21), 21, 17),
        move(byNumber.get(22), 22, 18)]).join('');
    xml = xml.replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/,
      '<sheetData>' + compact + '</sheetData>');
    // Preserve only existing company and repositioned table merges.
    return xml.replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/, section => {
      const kept = [];
      for (const [tag] of section.matchAll(/<mergeCell\b[^>]*\bref="[^"]+"[^>]*\/>/g)) {
        const ref = tag.match(/\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/);
        if (!ref) continue;
        const first = Number(ref[2]), last = Number(ref[4]);
        if (first <= 15 && last <= 15) kept.push(tag);
        else if (first >= 20 && last <= 22) {
          kept.push(tag.replace(ref[0], 'ref="' + ref[1] + (first - 4) +
            ':' + ref[3] + (last - 4) + '"'));
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
  function readableChunks(value, width, maxLines) {
    const text = String(value), chunks = [];
    let start = 0, lines = 1, column = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\n') { lines++; column = 0; }
      else if (++column >= width) { lines++; column = 0; }
      if (lines > maxLines) {
        const space = text.lastIndexOf(' ', index);
        const cut = space > start && index - space < width ? space : index;
        chunks.push(text.slice(start,cut));
        start = cut; index = cut - 1; lines = 1; column = 0;
      }
    }
    chunks.push(text.slice(start));
    return chunks;
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
    // A–J uses the printable landscape width; keep the 10 pt body readable.
    const tableWidths = [4.5, 13, 13, 18, 18, 20, 14, 9, 14, 16];
    tableWidths.forEach((width, index) => {
      main = setColumnWidth(main, index + 1, width);
    });
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
      [4, [meta.description], [49], 25], [9, [fields.A9, fields.G9], [49, 26], 34],
      [10, [meta.address], [26], 23], [11, [fields.A11, fields.G11], [49, 26], 23],
      [12, [meta.email], [26], 23], [13, [fields.A13, fields.G13], [49, 26], 23],
      [14, [meta.taxId], [26], 23], [15, [meta.registration], [26], 23],
      [21, [meta.note], [95], meta.note.trim() ? 24 : 8]
    ]) main = rowHeight(main, number, lineHeight(values, widths, minimum));
    const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const allCols = cols.concat('I');
    const styles = rowStyles(main, 23, allCols), sumStyles = rowStyles(main, 24, allCols);
    const totalStyles = await currencyTotalStyles(zip, total.totals, sumStyles[7]);
    const headerStyles = rowStyles(main, 22, allCols);
    main = compactQuoteHeader(main);
    // Ten physical columns, eight semantic fields: name B:C, parameters D:E.
    const tableColumns = ['A', 'B', 'D', 'F', 'G', 'H', 'I', 'J'];
    const headers = ['R.br.', 'Biljka', 'Parametri sadnice', 'Rasadnik', 'Jed.', 'Količina', 'Cena', 'Iznos'];
    main = main.replace(/<row\b[^>]*\br="18"[^>]*>[\s\S]*?<\/row>/,
      '<row r="18" ht="30" customHeight="1">' + headers.map((value, index) =>
        cell(tableColumns[index] + '18', value, headerStyles[index])).join('') + '</row>');
    // Compact whitespace without reducing the original 10 pt body typography.
    for (const [row, height] of [[1,6],[2,26],[3,26],[4,lineHeight([meta.description],[46],24)],[5,lineHeight([fields.A5],[46],18)],[6,16],[7,16],[8,16],
      [9,lineHeight([fields.A9,fields.G9],[48,44],24)],[10,lineHeight([fields.G10],[43],20)],[11,lineHeight([fields.A11,fields.G11],[46,43],20)],[12,lineHeight([fields.G12],[43],20)],[13,lineHeight([fields.A13,fields.G13],[46,43],20)],[14,lineHeight([fields.G14],[43],18)],[15,lineHeight([fields.G15],[43],18)],[16,24],[17,meta.note.trim()?lineHeight([meta.note],[130],24):6]]) {
      main = rowHeight(main,row,height);
    }
    let rows = '', nextRow = 19;
    quote.items.forEach((item, index) => {
      const result = total.rows[index];
      // Excel caps a row at 409 pt. Continue long descriptions in visible
      // rows of the same table instead of clipping or shrinking the text.
      const chunks = readableChunks(compactParameters(item), 26, 24);
      chunks.forEach((description, part) => {
        const number = nextRow++;
        const values = part ? ['', '', description, '', '', '', '', ''] :
          [index + 1, item.latinName, description, item.nursery, item.unit,
            result.quantity.value, result.price.value, result.amount];
        const height = lineHeight(values, [4, 25, 33, 19, 13, 8, 13, 15], 40);
        rows += '<row r="'+number+'" ht="'+height+'" customHeight="1">' +
          values.map((value, column) => cell(tableColumns[column] + number, value, styles[column],
            !part && column === 7 ? 'ROUND(H'+number+'*I'+number+',2)' : '')).join('') +
          (!part ? cell('K'+number, item.currency, '4') : '') + '</row>';
      });
    });
    const lastData = nextRow - 1, lastRow = lastData + total.totals.length;
    total.totals.forEach((subtotal,index) => {
      const sumRow = lastData + index + 1;
      const formula = total.totals.length === 1 ? 'SUM(J19:J'+lastData+')' :
        'SUMIF(K19:K'+lastData+',"'+subtotal.currency+'",J19:J'+lastData+')';
      rows += '<row r="'+sumRow+'" ht="30" customHeight="1">' +
        cell('I'+sumRow, 'UKUPNO', sumStyles[6]) +
        cell('J'+sumRow, subtotal.amount, totalStyles[subtotal.currency], formula) + '</row>';
    });
    main = replaceRows(main, 19, rows, 'K', lastRow);
    main = main.replace(/sqref="F23"/g, 'sqref="H19:H'+lastData+'"')
      .replace(/sqref="G23"/g, 'sqref="I19:I'+lastData+'"');
    main = configureA4(main, lastRow);
    zip.file('xl/worksheets/sheet1.xml', main);
    let workbook = spreadsheetXml(await zip.file('xl/workbook.xml').async('string'));
    const calc = '<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/>';
    workbook = /<calcPr\b/.test(workbook) ? workbook.replace(/<calcPr\b[^>]*\/>/, calc) : workbook.replace('</workbook>', calc + '</workbook>');
    const printArea = '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'Moja ponuda\'!$A$1:$J$' + lastRow + '</definedName><definedName name="_xlnm.Print_Titles" localSheetId="0">\'Moja ponuda\'!$18:$18</definedName></definedNames>';
    workbook = workbook.replace(/<definedNames\b[^>]*>[\s\S]*?<\/definedNames>/, '')
      .replace('</sheets>', () => '</sheets>' + printArea);
    zip.file('xl/workbook.xml', workbook);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  // A4 landscape keeps ten columns legible at the original font size.
  function configureA4(xml, lastRow) {
    xml = xml.replace('</sheetPr>', '<pageSetUpPr fitToPage="1"/></sheetPr>');
    xml = xml.replace(/<pane\b[^>]*\/>/, '<pane ySplit="18" topLeftCell="A19" activePane="bottomLeft" state="frozen"/>');
    xml = xml.replace('</cols>', '<col min="11" max="11" width="2" hidden="1" customWidth="1"/></cols>');
    xml = xml.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/, (_, body) => {
      const original = [...body.matchAll(/<mergeCell\b[^>]*\bref="[^"]+"[^>]*\/>/g)].map(m=>m[0])
        .map(tag=>tag.replace(/:I(\d+)"/, ':J$1"'));
      const additions = [];
      for (let row=18; row<lastRow; row++) additions.push('B'+row+':C'+row,'D'+row+':E'+row);
      return '<mergeCells count="'+(original.length+additions.length)+'">'+original.join('')+
        additions.map(ref=>'<mergeCell ref="'+ref+'"/>').join('')+'</mergeCells>';
    });
    xml = xml.replace(/<pageMargins\b[^>]*\/>/, '<pageMargins left="0.25" right="0.25" top="0.3" bottom="0.3" header="0.15" footer="0.15"/>');
    xml = xml.replace(/<pageSetup\b[^>]*\/>/g, '');
    return xml.replace(/<drawing\b/, '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><drawing');
  }
  // Number format keeps the total as a recalculating number, with currency
  // displayed in that same cell, never as a separate visible table column.
  async function currencyTotalStyles(zip, totals, baseStyle) {
    let styles=spreadsheetXml(await zip.file('xl/styles.xml').async('string'));
    const fmtSection=styles.match(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/);
    const xfSection=styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (!fmtSection || !xfSection) throw new Error('Nedostaju Excel stilovi.');
    const originals=[...xfSection[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m=>m[0]);
    const id=Math.max(163,...[...fmtSection[1].matchAll(/\bnumFmtId="(\d+)"/g)].map(m=>Number(m[1])))+1;
    const formats=[], added=[], mapped={};
    for (const currency of [...new Set(totals.map(t=>t.currency))]) {
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Nepoznata valuta u ponudi.');
      const formatId=id+formats.length;
      formats.push('<numFmt numFmtId="'+formatId+'" formatCode="#,##0.00 &quot;'+currency+'&quot;"/>');
      const base=originals[Number(baseStyle)];
      if (!base) throw new Error('Nedostaje stil ukupnog zbira.');
      const updated=base.replace(/\bnumFmtId="\d+"/,'numFmtId="'+formatId+'"')
        .replace(/\bapplyNumberFormat="\d+"/,'applyNumberFormat="1"');
      mapped[currency]=originals.length+added.length;
      added.push(updated);
    }
    styles=styles.replace(fmtSection[0],'<numFmts count="'+(Number(fmtSection[0].match(/\bcount="(\d+)"/)?.[1]||0)+formats.length)+'">'+fmtSection[1]+formats.join('')+'</numFmts>');
    styles=styles.replace(xfSection[0],'<cellXfs count="'+(originals.length+added.length)+'">'+xfSection[1]+added.join('')+'</cellXfs>');
    zip.file('xl/styles.xml',styles);
    return mapped;
  }
  function filename(meta, exportedAt = new Date()) {
    const number = text(meta.number, 80).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    return 'Demetra-RB-ponuda-' + localDate(exportedAt) + (number ? '-' + number : '') + '.xlsx';
  }
  return { VERSION, STORAGE_KEY, COMPANY, MAX_ITEMS, localDate, validDate, defaultMeta, normalizeMeta,
    emptyQuote, parseQuote, normalizeItem, addItem, refreshCatalogPrices, parseDecimal, lineResult, summarize, money,
    compactParameters, buildXlsx, filename, xmlEscape };
});

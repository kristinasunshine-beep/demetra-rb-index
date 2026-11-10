#!/usr/bin/env python3
"""Recover explicit EUR price cells from the original Mauritz ODS quotation.

Only a matching single source row without a supplier amendment is handled here.
Amended names and sizes require a separate reviewed offered-variant record.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

from materialize_source_rows import same_requested_name

MEMBER = 'Rasadnici ponude/Holandija/Combinatie Mauritz/ponuda Marina Dorćol.ods'
EXPECTED_SHA = '8caa2e41d8d2cb80c9e6d364ce301c11f7c50efe4d7e4a2ebdcae922efd0ac02'
NS = {'t': 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
      'o': 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
      'x': 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'}


def original_rows(archive):
    content = archive.read(MEMBER)
    if hashlib.sha256(content).hexdigest() != EXPECTED_SHA:
        raise ValueError('Original ODS hash differs; review the new source before importing.')
    with zipfile.ZipFile(io.BytesIO(content)) as ods:
        tree = ET.fromstring(ods.read('content.xml'))
    sheet = next(t for t in tree.findall('.//t:table', NS)
                 if t.get('{'+NS['t']+'}name') == 'Blad1')
    rows = {}
    number = 1
    for element in sheet.findall('t:table-row', NS):
        cells = {}
        column = 0
        for cell in element:
            if cell.tag not in ('{'+NS['t']+'}table-cell', '{'+NS['t']+'}covered-table-cell'):
                continue
            repeated = int(cell.get('{'+NS['t']+'}number-columns-repeated', '1'))
            text = ' '.join(''.join(p.itertext()) for p in cell.findall('x:p', NS)).strip()
            value = cell.get('{'+NS['o']+'}value')
            kind = cell.get('{'+NS['o']+'}value-type')
            currency = cell.get('{'+NS['o']+'}currency', '')
            if text or value:
                for offset in range(min(repeated, max(0, 8-column))):
                    cells[chr(65+column+offset)] = {
                        'value': float(value) if value is not None and kind in ('float', 'currency') else text,
                        'display': text, 'type': kind, 'currency': currency}
            column += repeated
        row_repeat = int(element.get('{'+NS['t']+'}number-rows-repeated', '1'))
        if cells:
            if row_repeat > 1000:
                raise ValueError('Unexpected repeated populated source rows.')
            for offset in range(row_repeat):
                rows[number+offset] = copy.deepcopy(cells)
        number += row_repeat
    assert {key: rows[1][key]['value'] for key in 'BCDEFGH'} == {
        'B': 'Plants', 'C': 'Height', 'D': 'Circums.', 'E': 'Pcs',
        'F': 'br/cont/rb', 'G': 'Price', 'H': 'Comments'}
    return rows


def recover(document, plants, rows):
    result = copy.deepcopy(document)
    plant_map = {p['id']: p for p in plants['plants']}
    report = {'sourceFile': MEMBER, 'sourceSha256': EXPECTED_SHA, 'sheet': 'Blad1',
              'changes': [], 'skippedAmendments': [], 'conflicts': []}
    for offer in result['offers']:
        source = offer.get('sourceEvidence') or {}
        if offer.get('recordStatus') in {'superseded', 'needs_review'}:
            continue
        if source.get('sourceSha256') != EXPECTED_SHA or source.get('sheet') != 'Blad1':
            continue
        row = source.get('row')
        if row not in rows or source.get('multipleVariants') or len(source.get('sourceSpecifications', [])) > 1:
            continue
        cells = rows[row]
        price = cells.get('G', {})
        if not isinstance(price.get('value'), (int, float)):
            continue
        if cells.get('H', {}).get('value'):
            report['skippedAmendments'].append({'offerId': offer['id'], 'row': row,
                                               'comment': cells['H']['value']})
            continue
        if not same_requested_name(plant_map[offer['plantId']], {'rawName': cells.get('B', {}).get('value')}):
            report['conflicts'].append({'offerId': offer['id'], 'row': row, 'reason': 'source_taxon_mismatch'})
            continue
        if price.get('currency') != 'EUR' and '€' not in price.get('display', ''):
            report['conflicts'].append({'offerId': offer['id'], 'row': row, 'reason': 'currency_not_explicit'})
            continue
        if offer.get('price') is not None:
            if offer['price'] != price['value'] or offer.get('currency') != 'EUR':
                report['conflicts'].append({'offerId': offer['id'], 'row': row, 'reason': 'existing_price_differs'})
            continue
        amount = price['value']
        assert amount >= 0
        offer.update(price=amount, currency='EUR', currencyStatus='stated', priceKind='historical',
                     priceNote='Cena je preneta iz originalne arhivirane ponude rasadnika.', unit='kom',
                     availability='Arhivirana ponuda — aktuelna dostupnost nije potvrđena.')
        offer['priceEvidence'] = {
            'kind': 'historical_supplier_offer', 'method': 'original_ods_xml_exact_source_row',
            'sourceFile': Path(MEMBER).name, 'archivePath': MEMBER, 'sourceSha256': EXPECTED_SHA,
            'sourceId': source.get('sourceId', 'src-d05715e3aec018'),
            'sheet': 'Blad1', 'row': row, 'priceCell': 'G'+str(row),
            'amount': amount, 'rawAmount': price['display'], 'currency': 'EUR',
            'currencyEvidence': 'Izričit znak € u originalnoj ćeliji G'+str(row),
            'rawName': cells['B']['value'], 'offeredName': cells['B']['value'],
            'sourceRole': 'archive_variant', 'archiveVerified': True,
            'quantity': cells.get('E', {}).get('value'), 'quantityCell': 'E'+str(row),
            'columnHeaders': {'G1': 'Price', 'E1': 'Pcs'}}
        report['changes'].append({'offerId': offer['id'], 'row': row,
                                  'priceCell': 'G'+str(row), 'price': amount, 'currency': 'EUR'})
    if report['conflicts']:
        raise ValueError(json.dumps(report['conflicts'], ensure_ascii=False))
    if report['changes']:
        result['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    report['recoveredPrices'] = len(report['changes'])
    return result, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    with zipfile.ZipFile(args.archive) as archive:
        rows = original_rows(archive)
    document = json.loads((args.root/'data/kataloske-stavke.json').read_text())
    plants = json.loads((args.root/'data/biljke.json').read_text())
    result, report = recover(document, plants, rows)
    for path, value in ((args.output, result), (args.report, report)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'recoveredPrices': report['recoveredPrices'],
                      'amendedRowsRequireSeparateProof': len(report['skippedAmendments'])}))


if __name__ == '__main__':
    main()

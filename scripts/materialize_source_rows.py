#!/usr/bin/env python3
"""Materialize separate source rows before mapping their card parameters.

Offline repair. Requires the original archive and verifies its member hashes.
Existing source-row records (including verified prices) are reused. A requested
plant and its supplier replacement never share a price or an unnamed measure.
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
import unicodedata
import zipfile

from classify_offer_traits import classify_offer

INACTIVE = {'superseded', 'needs_review'}
PARAMETERS = ('seedlingType', 'seedlingTypeCode', 'circumference', 'height',
              'crownWidth', 'rootBall', 'potSize', 'rootType', 'transplantNote')


def normalized(value):
    value = unicodedata.normalize('NFKD', str(value or '')).casefold()
    value = ''.join(c for c in value if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', value).strip()


def same_requested_name(plant, row):
    names = [plant['latinName'], *plant.get('synonyms', []), *plant.get('searchAliases', [])]
    raw = normalized(row.get('rawName'))
    for name in {normalized(name) for name in names if name}:
        if raw == name:
            return True
        # Some Product cells include the plant name and its size in one cell.
        # Allow only a measurement/form suffix, never an extra cultivar name.
        if raw.startswith(name) and re.match(
                r'^\s*(?:\d|h\s*\d|height\b|c\s*\d|clt\s*\d|std\b|multistem\b|circums\b)',
                raw[len(name):]):
            return True
    return False


def locator(evidence, row=None):
    row = row or evidence
    sha = row.get('sourceSha256') or evidence.get('sourceSha256') or evidence.get('sha256')
    sheet = row.get('sheet', evidence.get('sheet', ''))
    number = row.get('row', evidence.get('row'))
    return (sha, sheet, str(number)) if sha and sheet and number is not None else None


def materialize(document, plants, archive, root):
    output = copy.deepcopy(document)
    plant_map = {plant['id']: plant for plant in plants['plants']}
    by_id = {offer['id']: offer for offer in output['offers']}
    originals = list(output['offers'])
    report = {'operation': 'one-source-row-per-panel', 'changes': [], 'verifiedFiles': {},
              'newOffers': [], 'reusedOffers': [], 'pending': []}

    def verify(evidence, row=None):
        row = row or {}
        member = row.get('sourceFile') if row.get('sourceSha256') else None
        member = member or evidence.get('archivePath') or evidence.get('sourcePath')
        expected = row.get('sourceSha256') or evidence.get('sourceSha256')
        if not member or not expected:
            raise ValueError('Source member and SHA-256 are required.')
        if member not in report['verifiedFiles']:
            report['verifiedFiles'][member] = hashlib.sha256(archive.read(member)).hexdigest()
        if report['verifiedFiles'][member] != expected:
            raise ValueError('Source archive checksum mismatch: ' + member)
        return member, expected

    aggregate_ids = {o['id'] for o in originals if o.get('recordStatus') not in INACTIVE and
                     (o.get('sourceEvidence', {}).get('multipleVariants') or
                      len(o.get('sourceEvidence', {}).get('sourceSpecifications', [])) > 1)}
    rows = {}
    for offer in originals:
        if offer['id'] in aggregate_ids or offer.get('recordStatus') in INACTIVE:
            continue
        for evidence in (offer.get('sourceEvidence') or {}, offer.get('priceEvidence') or {}):
            locations = [locator(evidence)] + [locator(evidence, row) for row in
                [*evidence.get('sourceSpecifications', []), *evidence.get('additionalSourceSpecifications', [])]]
            for location in set(item for item in locations if item):
                bucket = rows.setdefault((offer['plantId'], offer['nurseryId'], *location), [])
                if offer not in bucket:
                    bucket.append(offer)

    def existing(parent, evidence, row):
        where = locator(evidence, row)
        candidates = rows.get((parent['plantId'], parent['nurseryId'], *where), []) if where else []
        if len(candidates) == 1:
            return candidates[0]
        priced = [offer for offer in candidates if offer.get('price') is not None]
        return priced[0] if len(priced) == 1 else None

    def make_child(parent, row):
        evidence = parent['sourceEvidence']
        member, sha = verify(evidence, row)
        photo = row.get('recordRole') == 'photo_attachment_description'
        requested = row.get('recordRole') == 'requested_with_supplier_note'
        if requested and not same_requested_name(plant_map[parent['plantId']], row):
            raise ValueError('Replacement target needs its own offered-row evidence: ' + parent['id'])
        if row.get('recordRole') == 'offered_alternative':
            raise ValueError('Offered alternative must be materialized from audited reply cells: ' + parent['id'])
        child = copy.deepcopy(parent)
        for key in ('recordStatus', 'replacedByOfferIds', 'priceEvidence', 'panelParameterEvidence',
                    'traitsEvidence', 'additionalParameters', 'reviewNote', 'transplantCount',
                    'transplantCodes', 'supersededByOfferIds'):
            child.pop(key, None)
        descriptor = row.get('requestedDescription') if requested else row.get('specification')
        child['specification'] = descriptor
        identity = '|'.join((parent['id'], sha, str(row.get('sheet', '')), str(row.get('row', '')),
                             descriptor, row.get('supplierNote', '')))
        child['id'] = 'record-source-' + hashlib.sha256(identity.encode()).hexdigest()[:18]
        child['legacyAggregateId'] = parent['id']
        child['splitFromOfferId'] = parent['id']
        child.update({field: '' for field in PARAMETERS})
        child.update(price=None, currency='', currencyStatus='not_stated', priceKind='unpublished',
                     priceNote='Jedinična cena za ovu varijantu nije potvrđena u izvornom redu.',
                     taxStatus='PDV nije naveden', measurementNote='')
        source_row = copy.deepcopy(row)
        source = copy.deepcopy(evidence)
        for key in ('additionalSourceSpecifications', 'originalExtractionNote'):
            source.pop(key, None)
        source.update(archive='Rasadnici ponude.zip', archivePath=member,
                      sourceFile=Path(member).name, sourceSha256=sha, archiveVerified=True,
                      multipleVariants=False, sourceSpecifications=[source_row],
                      parentAggregateId=parent['id'], rawDescription=descriptor)
        for key in ('sheet', 'row', 'measurementSourceCells'):
            if key in row:
                source[key] = copy.deepcopy(row[key])
        source['recordRole'] = row.get('recordRole', 'archive_variant')
        if requested:
            source['parameterRole'] = 'requested'
            source['note'] = 'Jedan zahtevani red ponude; odgovor rasadnika sačuvan je odvojeno od njegovih mera.'
            child['availability'] = 'Specifikacija upita — rasadnik je naveo izmenu ili zamenu.'
            child['priceNote'] = 'Cena ponuđene zamene nije pripisana traženoj biljci.'
            if row.get('supplierNote'):
                child['additionalParameters'] = [{
                    'label': 'Odgovor rasadnika', 'value': row['supplierNote'],
                    'sources': [{'sourceSha256': sha, 'sheet': row['sheet'], 'row': row['row'],
                                 'cell': row.get('supplierNoteCell', '')}]}]
        elif photo:
            source.pop('parameterRole', None)
            source['note'] = 'Zaseban fotografski prilog iz arhive rasadnika. Dimenzije pripadaju nazivu ovog priloga; fotografija ne potvrđuje sadašnji lager.'
            child['availability'] = 'Fotografski prilog rasadnika — aktuelna dostupnost nije potvrđena.'
            child['priceNote'] = 'Fotografski prilog ne sadrži cenu.'
            # Keep each photographic variant with its own source photograph.
            from PIL import Image, ImageOps
            image = Image.open(io.BytesIO(archive.read(member)))
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((1200, 1200))
            jpeg = io.BytesIO(); image.save(jpeg, format='JPEG', quality=88, optimize=True)
            relative = 'assets/biljke/archive-' + sha[:24] + '.jpg'
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(jpeg.getvalue())
            child.update(image=relative, imageSourceUrl='', imageKind='Fotografija iz materijala rasadnika')
        else:
            source.pop('parameterRole', None)
            source['note'] = 'Jedan izvorni red ponude; mere nisu spojene sa drugom varijantom.'
            child['availability'] = 'Varijanta iz arhivirane ponude — aktuelna dostupnost nije potvrđena.'
        child['sourceEvidence'] = source
        child['archiveSourceNote'] = source['note']
        child['source'] = parent['source'].split(' · red ')[0] + (
            ' · ' + row['sheet'] + ', red ' + str(row['row']) if not photo else ' · zaseban fotografski prilog')
        child.update(classify_offer(child, source))
        return child

    for parent in originals:
        if parent['id'] not in aggregate_ids:
            continue
        if parent.get('price') is not None:
            raise ValueError('A priced aggregate must be resolved explicitly: ' + parent['id'])
        evidence = parent['sourceEvidence']
        specs = evidence.get('sourceSpecifications') or []
        children = []
        for row in specs:
            verify(evidence, row)
            found = existing(parent, evidence, row)
            if found:
                children.append(found['id'])
                report['reusedOffers'].append({'aggregateId': parent['id'], 'offerId': found['id'],
                                              'sheet': row.get('sheet'), 'row': row.get('row')})
                continue
            try:
                child = make_child(parent, row)
            except ValueError as error:
                report['pending'].append({'aggregateId': parent['id'], 'sheet': row.get('sheet'),
                                          'row': row.get('row'), 'reason': str(error)})
                continue
            if child['id'] not in by_id:
                output['offers'].append(child)
                by_id[child['id']] = child
                report['newOffers'].append(child['id'])
            children.append(child['id'])
        if len(children) != len(specs):
            continue
        parent.update(recordStatus='superseded', replacedByOfferIds=list(dict.fromkeys(children)),
                      dataAccuracyNote='Zbirni zapis zamenjen je zasebnim izvornim redovima.',
                      archiveSourceNote='Svaka varijanta prikazuje sopstvene mere i proverenu cenu, kada je navedena.')
        report['changes'].append({'offerId': parent['id'], 'replacedByOfferIds': parent['replacedByOfferIds']})

    # Already individual request rows receive the same explicit source role.
    for offer in output['offers']:
        if offer.get('recordStatus') in INACTIVE or offer.get('price') is not None:
            continue
        source = offer.get('sourceEvidence') or {}
        specs = source.get('sourceSpecifications') or []
        if source.get('multipleVariants') or len(specs) != 1:
            continue
        row = specs[0]
        if row.get('recordRole') != 'requested_with_supplier_note':
            continue
        if not same_requested_name(plant_map[offer['plantId']], row):
            report['pending'].append({'offerId': offer['id'], 'reason': 'Single replacement target needs offered-row evidence.'})
            continue
        verify(source, row)
        if not row.get('requestedDescription'):
            report['pending'].append({'offerId': offer['id'], 'reason': 'Explicit requestedDescription is missing.'})
            continue
        source.update(parameterRole='requested', multipleVariants=False,
                      note='Jedan zahtevani red ponude; odgovor rasadnika sačuvan je odvojeno od njegovih mera.')
        offer['specification'] = row['requestedDescription']
        offer['availability'] = 'Specifikacija upita — rasadnik je naveo izmenu ili zamenu.'
        if row.get('supplierNote'):
            extra = [item for item in offer.get('additionalParameters', []) if item['label'] != 'Odgovor rasadnika']
            extra.append({'label': 'Odgovor rasadnika', 'value': row['supplierNote'],
                          'sources': [{'sourceSha256': source['sourceSha256'], 'sheet': row['sheet'],
                                       'row': row['row'], 'cell': row.get('supplierNoteCell', '')}]})
            offer['additionalParameters'] = extra
        offer.update(classify_offer(offer, source))
    if report['pending']:
        # Never publish a half-split aggregate next to its own children.
        raise ValueError(json.dumps({'unresolvedSourceRoles': report['pending']}, ensure_ascii=False))
    output['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    report['summary'] = {'aggregatesSplit': len(report['changes']), 'newRows': len(report['newOffers']),
                         'reusedRows': len(report['reusedOffers']), 'sourceFilesVerified': len(report['verifiedFiles']),
                         'activeAggregatesRemaining': sum(o.get('recordStatus') not in INACTIVE and
                            (o.get('sourceEvidence', {}).get('multipleVariants') or
                             len(o.get('sourceEvidence', {}).get('sourceSpecifications', [])) > 1)
                            for o in output['offers'])}
    return output, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads((args.root / 'data/kataloske-stavke.json').read_text())
    plants = json.loads((args.root / 'data/biljke.json').read_text())
    with zipfile.ZipFile(args.archive) as archive:
        result, report = materialize(data, plants, archive, args.root)
    for path, value in ((args.output, result), (args.report, report)):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Classify nursery-offer markings offline, without altering prices or measures.

Public API: classify_offer(offer, source=None) -> a dict containing only the
new type/note/evidence fields.  Source measurements retain their meaning:
STD does not turn a girth class into a height, and MULTISTEM does not turn a
height into a girth.  No network requests or default 'standard' inference.

CLI writes a guarded row-level patch; it never rewrites the catalogue.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from zipfile import ZipFile

STANDARD = re.compile(r'(?<!\w)(?:STD|standard)(?!\w)', re.I)
MULTISTEM = re.compile(r'(?<!\w)(?:multi[\s-]*stem(?:med|s)?|mstem|mehrst\.?|mehrst[aä]mmig)(?!\w)', re.I)
UNRESOLVED_TYPE_CODES = re.compile(r'(?<![A-Za-z])(?:HS|HST|FTH|SOL|Schirm|Naturschirm|Hochst\.)(?![A-Za-z])', re.I)
XV = re.compile(r'(?<![\w.])(?P<number>[1-9]\d?)\s*[x×]\s*v(?=$|[\s,.;:)])', re.I)
# Lorenz von Ehren quotation 42418134, page 2 positions 10-25 uses 4xtr,
# 5xtr and 6xtr inside the plant specification, separately from Quantity.
XTR = re.compile(r'(?<![\w.])(?P<number>[1-9]\d?)\s*[x×]\s*tr(?=$|[\s,.;:)])', re.I)
LABELLED_TRANSPLANT = re.compile(
    r'(?i)(?:broj\s+presa(?:đ|dj)ivanja|br\.?\s+presa(?:đ|dj)ivanja|'
    r'broj\s+presadivanja|transplant(?:ing)?\s+count|number\s+of\s+transplants)'
    r'\s*[:=]?\s*(?P<value>(?:[IVX]+|\d{1,2})(?:\s*[/–-]\s*(?:[IVX]+|\d{1,2}))?)(?!\w)')
SPELLED_TRANSPLANT = re.compile(
    r'(?i)(?<!\w)(?P<number>[1-9]\d?)\s*(?:[x×]|times?\s*)?\s*'
    r'(?:transplanted|verpflanzt|verplant|versetzt|presa(?:đ|dj)ivanj[ae]|puta\s+presa(?:đ|dj)en[ao]?)(?!\w)')
ROMAN = {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
         'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10}
TRAIT_FIELDS = ('seedlingType', 'seedlingTypeCode', 'transplantNote', 'dataAccuracyNote', 'traitsEvidence')


def clean(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())


def unique(values):
    return list(dict.fromkeys(values))


def row_text(offer):
    """Use the offered row only; never inspect requested/alternative neighbours."""
    evidence = offer.get('priceEvidence') or {}
    source = offer.get('sourceEvidence') or {}
    specification = clean(offer.get('specification'))
    # Existing specifications were already transcribed per offered variant.
    # Only fallback to that same row's evidence if its specification is blank.
    if specification:
        return specification
    for container, fields in [
        (source, ('rawDescription', 'rawText', 'description', 'specification')),
        (evidence, ('rawDescription', 'description', 'specification', 'pdfSize', 'rawName')),
    ]:
        for field in fields:
            if container.get(field):
                return clean(container[field])
    return ''


def type_markings(text, nursery_id=''):
    standards = [m.group() for m in STANDARD.finditer(text)]
    multis = [m.group() for m in MULTISTEM.finditer(text)]
    # Explicit negation of a form is not a positive type declaration.
    def positive(pattern):
        values = []
        for match in pattern.finditer(text):
            prefix = text[max(0, match.start()-28):match.start()]
            if re.search(r'(?:\bnot|\bno|\bwithout|\bnije|\bbez)\s*$', prefix, re.I):
                continue
            values.append(match.group())
        return unique(values)
    standards, multis = positive(STANDARD), positive(MULTISTEM)
    # Codes are scoped to the suppliers whose source grammar uses them.  Ho
    # is Dutch hoogstam; HS is the standard-tree form in Volentis size rows.
    # H is NOT a form globally: for other suppliers H introduces height.
    if nursery_id in ('combinatie-mauritz', 'volentis'):
        standards += positive(re.compile(r'(?<![A-Za-z])(?:HO|HS|HST|hoogstam)(?![A-Za-z])', re.I))
        multis += positive(re.compile(r'(?<![A-Za-z])(?:MS|MRSTAM|meerstammig|meerstam)(?![A-Za-z])', re.I))
    if nursery_id == 'lorberg':
        standards += positive(re.compile(r'(?<!\w)(?:H(?=\s+\d+xv)|Hochst\.?|Hochstamm|Sol\s+(?:Baum|Tree))(?![A-Za-z])', re.I))
    if nursery_id in ('innocenti-mangoni', 'vannucci-piante'):
        standards += positive(re.compile(r'(?<!\w)(?:ALTO\s+FUSTO|A\.F\.)(?![A-Za-z])', re.I))
        multis += positive(re.compile(r'(?<!\w)MULTITRONCO(?!\w)', re.I))
    standards, multis = unique(standards), unique(multis)
    if standards and multis:
        return '', unique(standards + multis), 'conflicting_type_markings'
    if multis:
        return 'multistem', multis, 'explicit_multistem_marking'
    if standards:
        return 'standard', standards, 'explicit_standard_marking'
    unresolved = unique(m.group() for m in UNRESOLVED_TYPE_CODES.finditer(text))
    return '', unresolved, 'unresolved_supplier_code' if unresolved else 'type_not_stated'


def roman_or_integer(value):
    value = value.strip().upper()
    if value in ROMAN:
        return ROMAN[value]
    if value.isdigit() and 0 < int(value) <= 99:
        return int(value)
    return None


def transplant_markings(text):
    observations = []
    for match in XV.finditer(text):
        observations.append({'raw': match.group(), 'values': [int(match['number'])], 'rule': 'explicit_Nxv'})
    for match in XTR.finditer(text):
        observations.append({'raw': match.group(), 'values': [int(match['number'])], 'rule': 'explicit_Nxtr'})
    for match in LABELLED_TRANSPLANT.finditer(text):
        values = [roman_or_integer(v) for v in re.split(r'\s*[/–-]\s*', match['value'])]
        if all(v is not None for v in values):
            observations.append({'raw': clean(match['value']), 'values': values, 'rule': 'explicit_transplant_label'})
    for match in SPELLED_TRANSPLANT.finditer(text):
        observations.append({'raw': clean(match.group()), 'values': [int(match['number'])], 'rule': 'spelled_transplant_count'})
    observations = list({(o['raw'], tuple(o['values']), o['rule']): o for o in observations}.values())
    all_values = unique(v for o in observations for v in o['values'])
    raw = unique(o['raw'] for o in observations)
    if not observations:
        return '', {'status': 'not_stated', 'count': None, 'raw': [], 'observations': []}
    if len(all_values) == 1:
        count = all_values[0]
        return (f'Broj presađivanja: {count} (oznaka u ponudi: {", ".join(raw)}).',
                {'status': 'exact', 'count': count, 'raw': raw, 'observations': observations})
    if len(observations) == 1 and len(observations[0]['values']) == 2:
        return (f'Broj presađivanja: {raw[0]} prema ponudi; izvor ne navodi jedan tačan broj.',
                {'status': 'range', 'count': None, 'range': observations[0]['values'], 'raw': raw, 'observations': observations})
    return (f'Broj presađivanja nije jednoznačan; izvor sadrži oznake {", ".join(raw)}.',
            {'status': 'conflicting', 'count': None, 'raw': raw, 'observations': observations})


def source_reference(offer, source=None):
    refs = [source or {}, offer.get('sourceEvidence') or {}, offer.get('priceEvidence') or {}, offer.get('measurementEvidence') or {}]
    aliases = {
        'sourceFile': ('sourceFile', 'filename', 'file', 'sourcePath', 'archivePath', 'path'),
        'sourceSha256': ('sourceSha256', 'sha256'),
        'sourceId': ('sourceId',), 'page': ('page', 'pdfPage'),
        'sheet': ('sheet',), 'row': ('row',), 'productCell': ('productCell',),
        'pdfSha256': ('pdfSha256',), 'pdfSourceId': ('pdfSourceId',),
    }
    result = {}
    for key, candidates in aliases.items():
        for ref in refs:
            match = next((ref[c] for c in candidates if ref.get(c) is not None), None)
            if match is not None:
                result[key] = match
                break
    if not result:
        result['catalogueSourceLabel'] = offer.get('source', '')
    if source and 'archiveVerified' in source:
        result['archiveVerified'] = bool(source['archiveVerified'])
    return result


def classify_offer(offer, source=None):
    """Return new metadata only; do not mutate offer or manufacture dimensions."""
    if not isinstance(offer, dict):
        raise ValueError('Expected one offer object.')
    if offer.get('priceKind') == 'public':
        raise ValueError('Public catalogue rows are not archive inputs.')
    text = row_text(offer)
    form, codes, reason = type_markings(text, offer.get('nurseryId', ''))
    transplant_note, transplant = transplant_markings(text)
    source_evidence = offer.get('sourceEvidence') or {}
    multiple_variants = bool(source_evidence.get('multipleVariants'))
    requested_with_alternative = any(
        isinstance(row, dict) and row.get('recordRole') == 'requested_with_supplier_note'
        for row in source_evidence.get('sourceSpecifications', [])
    )
    if multiple_variants:
        # A legacy aggregate can contain STD beside an unmarked form, not just
        # both explicit types.  Never silently assign one row's type to all.
        form, reason = '', 'multiple_source_variants'
        if transplant['status'] != 'not_stated':
            transplant = {**transplant, 'status': 'by_variant', 'count': None}
            transplant_note = ('Broj presađivanja je naveden po varijantama; izvorne oznake: '
                               + ', '.join(transplant['raw']) + '. Jedan broj nije dodeljen zbirnom zapisu.')
    elif requested_with_alternative:
        # A combined request/supplier annotation can name a different taxon or
        # size.  Retain its text but do not turn alternative marks into traits.
        form, reason = '', 'requested_with_supplier_alternative'
        transplant_note = ''
        transplant = {**transplant, 'status': 'unresolved_source_role', 'count': None}
    notes = []
    if reason == 'multiple_source_variants':
        notes.append('Zapis objedinjuje više izvornih varijanti; jedan tip i jedan skup mera nisu izabrani proizvoljno.')
    elif reason == 'requested_with_supplier_alternative':
        notes.append('Opis sadrži traženu biljku i napomenu o alternativi; tip i broj presađivanja alternative nisu pripisani traženoj biljci.')
    elif reason == 'conflicting_type_markings':
        notes.append('Izvorni red sadrži oznake za standard i multistem; tip zahteva proveru.')
    elif reason == 'unresolved_supplier_code':
        notes.append('Oznaka ' + ', '.join(codes) + ' je sačuvana iz ponude; bez legende nije pretvorena u standard ili multistem.')
    elif not form:
        notes.append('Tip sadnice nije izričito označen u ovom redu ponude; nije pretpostavljen.')
    if form == 'standard' and not offer.get('height'):
        notes.append('Visina sadnice nije posebno navedena u ponudi.')
        if offer.get('circumference'):
            notes.append('Navedeni obim nije korišćen kao visina sadnice.')
    elif form == 'multistem' and not offer.get('circumference'):
        notes.append('Obim sadnice nije posebno naveden u ponudi.')
        if offer.get('height'):
            notes.append('Navedena visina nije korišćena kao obim sadnice.')
    if not text:
        notes.append('Za ovaj zapis još nije izdvojen jednoznačan opis ponuđene varijante.')
    if transplant['status'] in ('range', 'conflicting'):
        notes.append('Broj presađivanja prenet je u napomenu sa izvornom neodređenošću.')
    if not notes:
        notes.append('Tip i upisane mere pripadaju istom izvornom redu ponude.')
    # These are curated archive notes, not web content.  Preserve them when
    # the root reclassifies all records after adding source-only evidence.
    for note in (source_evidence.get('note'), offer.get('reviewNote')):
        note = clean(note)
        if note and note not in notes:
            notes.append(note)
    return {
        'seedlingType': form, 'seedlingTypeCode': ', '.join(codes),
        'transplantNote': transplant_note, 'dataAccuracyNote': ' '.join(notes),
        'traitsEvidence': {
            'origin': 'Rasadnici ponude.zip',
            'source': source_reference(offer, source),
            'rawSpecification': text,
            'seedlingType': {'value': form, 'rawCodes': codes, 'rule': reason},
            'transplants': transplant,
            'measurementPolicy': 'Stored height and circumference are never relabelled or converted by type classification.',
        },
    }


def build_patch(document, source_index=None, verified_hashes=None):
    if document.get('schemaVersion') != 1 or not isinstance(document.get('offers'), list):
        raise ValueError('Expected a schemaVersion 1 offer catalogue.')
    sources = (source_index or {}).get('sources', []) if isinstance(source_index, dict) else source_index or []
    by_sha = {r['sha256']: r for r in sources if r.get('sha256')}
    by_id = {r['sourceId']: r for r in sources if r.get('sourceId')}
    updates, counts = [], Counter()
    source_counts = Counter()
    for offer in document['offers']:
        if offer.get('priceKind') == 'public':
            counts['publicRowsSkipped'] += 1
            continue
        reference = source_reference(offer)
        src = by_sha.get(reference.get('sourceSha256')) or by_id.get(reference.get('sourceId'))
        if src is None:
            match = re.search(r'prilog ([0-9a-f]{6})', offer.get('source', ''))
            matches = {r['sha256']: r for r in sources if match and r.get('sourceId', '') and r['sourceId'][4:].startswith(match[1])}
            src = next(iter(matches.values())) if len(matches) == 1 else None
        source = None
        if src:
            source = {'sourceFile': src['path'], 'sourceSha256': src['sha256'], 'sourceId': src.get('sourceId')}
            if verified_hashes is not None:
                source['archiveVerified'] = src['sha256'] in verified_hashes
            source_counts[src['sha256']] += 1
        fields = classify_offer(offer, source)
        updates.append({'id': offer['id'],
                        'expected': {'plantId': offer['plantId'], 'nurseryId': offer['nurseryId']},
                        'set': fields})
        counts['records'] += 1
        counts[fields['seedlingType'] or 'not_stated_or_unresolved'] += 1
        transplant = fields['traitsEvidence']['transplants']
        counts['transplants_' + transplant['status']] += 1
        counts['with_transplant_note'] += bool(fields['transplantNote'])
        counts['source_resolved'] += bool(src)
    return {'schemaVersion': 1, 'operation': 'classify_archive_seedling_traits',
            'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'summary': dict(counts), 'sourceRecords': dict(source_counts), 'updates': updates,
            'preservedFields': 'Every field other than seedlingType, seedlingTypeCode, transplantNote, dataAccuracyNote and traitsEvidence is unchanged.',
            'rules': ['No web data or requests.', 'STD and literal standard are standard.',
                      'MULTISTEM, MULTI-STEM, MSTEM and mehrst. are multistem.',
                      'Supplier-scoped Ho/HS/HST and Lorberg H/Sol Baum identify standard; MS and Multitronco identify multistem. FTH/SOL/STR retain their own form and never default to standard.',
                      'Nxv, Nxtr and explicitly labelled Roman/Arabic counts are notes; plain quantities and dimension products are ignored.',
                      'No numeric measure is assigned to a different measurement field.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', default='data/kataloske-stavke.json')
    parser.add_argument('--source-index', type=Path)
    parser.add_argument('--archive', type=Path, help='Optional original ZIP, used only to verify source hashes.')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    source_index = json.loads(args.source_index.read_text()) if args.source_index else None
    verified_hashes = None
    if args.archive:
        verified_hashes = set()
        with ZipFile(args.archive) as archive:
            for info in archive.infolist():
                if not info.is_dir():
                    verified_hashes.add(hashlib.sha256(archive.read(info)).hexdigest())
    before = Path(args.data).read_bytes()
    patch = build_patch(json.loads(before), source_index, verified_hashes)
    assert Path(args.data).read_bytes() == before, 'The catalogue changed while preparing the patch.'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(patch, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(patch['summary'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

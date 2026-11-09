#!/usr/bin/env python3
"""Extract explicitly labelled nursery parameters from verified archive rows.

Public API: extract_offer_parameters(offer) -> {set, evidence, unresolved}.
Only the six card-parameter fields can be returned in ``set``. Existing
different values are preserved. No internet, financial, photo or type changes.
CLI emits a guarded review patch, never edits the input catalogue.
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

FIELDS = ('circumference', 'height', 'crownWidth', 'rootBall', 'potSize', 'rootType')
MISSING = {'', '-', '—', '–', 'n/a', 'na', 'none', 'null', 'unknown',
           'nije navedeno', 'nije naveden', 'nije uneto', 'nije dostupno',
           'not stated', 'not specified', 'not available'}
NUMBER = r'\d+(?:[.,]\d+)?'
SIZE_RANGE = rf'{NUMBER}(?:\s*[-–—/]\s*{NUMBER})?'
RANGE = rf'{SIZE_RANGE}\s*\+?'
MEASURE = rf'(?P<value>(?:min\.?\s*)?{RANGE})(?:\s*(?P<unit>mm|cm|m)\b)?'
END = r'(?=$|[\s,;:.)/]|[xX](?=[lL]\d))'
FLAGS = re.I

PATTERNS = {
    'height': [
        ('explicit_height_label', re.compile(rf'(?<!\w)(?:height|visina(?:\s+sadnice)?|висина(?:\s+саднице)?)\s*(?:\[(?:cm|m|mm)\])?\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
        ('explicit_H_label', re.compile(rf'(?<![\w])H\s*[=:]?\s*{MEASURE}{END}', FLAGS)),
    ],
    'circumference': [
        ('explicit_circumference_label', re.compile(rf'(?<!\w)(?:circumference|circums\.?|circum\.?|circ\.?|cir\.?|girth|obim(?:\s+(?:sadnice|stabla))?|обим(?:\s+(?:саднице|стабла))?)\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
        ('explicit_O_equals_label', re.compile(rf'(?<!\w)O\s*[=:]\s*{MEASURE}{END}', FLAGS)),
    ],
    'crownWidth': [
        ('explicit_crown_width_label', re.compile(rf'(?<!\w)(?:crown\s*width|canopy\s*width|širina\s+krošnje|sirina\s+krosnje|ширина\s+крошње)\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
    ],
    'rootBall': [
        ('explicit_rootball_dimension', re.compile(rf'(?<!\w)(?:(?:root\s*ball|rootball)(?:\s*(?:diameter|size))?|(?:veličina\s+|velicina\s+|prečnik\s+|precnik\s+)?busen(?:a)?|бусен(?:а)?)\s*[:=]?\s*[Øø⌀]?\s*{MEASURE}{END}', FLAGS)),
    ],
}
PACKAGING_LABEL = re.compile(r'(?<!\w)br\s*/\s*cont\s*/\s*rb\s*:\s*(?P<value>[^;|]+)', FLAGS)
ROOT_CODES = re.compile(r'(?<![A-Za-z])(?P<code>WRB|RB|BR|CLT|CONT)(?![A-Za-z])', FLAGS)
C_POT = re.compile(rf'(?<![\w])(?P<code>C)\s*(?P<size>{SIZE_RANGE})(?P<unit>\s*L)?(?![\w.,])', FLAGS)
CLT_POT = re.compile(rf'(?<![\w])CLT\s*\.?\s*(?P<size>{SIZE_RANGE})(?P<unit>\s*L)?(?![\w.,])', FLAGS)
CLT_SIZE_COLUMN = re.compile(rf'\bType\s*:?\s*(?:NEW\s+)?CLT\s*;\s*Size\s*:?\s*(?P<size>{SIZE_RANGE})(?P<unit>\s*L)?(?!\w)', FLAGS)
LITRE_POT = re.compile(rf'(?<![\w.,–—/\-])(?P<size>{SIZE_RANGE})\s*(?:L|lit(?:er|re|ar)?[sa]?)(?![A-Za-z])', FLAGS)
ROOT_NAMES = {'RB': 'Busen (RB)', 'WRB': 'Busen u žičanoj korpi (WRB)',
              'BR': 'Goli koren (BR)', 'CLT': 'Kontejner (CLT)', 'CONT': 'Kontejner (cont)'}
UNKNOWN_CODES = re.compile(r'(?<![A-Za-z])(?:CG|KL|DRKL|mDb|w\.b\.)(?![A-Za-z])', FLAGS)


def clean(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())


def is_blank(value):
    return clean(value).casefold().strip(' .') in MISSING


def normalized_measure(value):
    # Normalize typography only. Do not convert m/cm, infer absent units,
    # convert pot codes to litres, or exchange height and girth.
    value = clean(value).split('(')[0].casefold()
    value = re.sub(r'\s*[-–—/]\s*', '–', value)
    value = re.sub(r'(?<=\d),(?=\d)', '.', value)
    return re.sub(r'\s+', '', value).rstrip('.')


def format_measure(match):
    value = re.sub(r'\s*[-–—/]\s*', '–', clean(match['value']))
    value = re.sub(r'(?i)\bmin\.?\s*', 'min. ', value)
    return value + (' ' + match['unit'].lower() if match['unit'] else '')


def format_size(value):
    return re.sub(r'\s*[-–—/]\s*', '–', clean(value))


def parameter_equivalent(field, a, b):
    a, b = normalized_measure(a), normalized_measure(b)
    if field == 'potSize':
        # Explicit C2L and 2L carry the same volume, while bare C2 or CLT2
        # must never be assumed to mean two litres.
        a = re.sub(r'^(?:c|cont\.?)(?=\d.*l(?:$|/))', '', a)
        b = re.sub(r'^(?:c|cont\.?)(?=\d.*l(?:$|/))', '', b)
        a = re.sub(r'^clt\.', 'clt', a)
        b = re.sub(r'^clt\.', 'clt', b)
        if b.endswith('l') and a.startswith(b + '–p'):
            return True
    return a == b


def source_reference(offer):
    result = {}
    for src in (offer.get('sourceEvidence') or {}, offer.get('priceEvidence') or {},
                offer.get('measurementEvidence') or {}):
        for key, names in {'sourceSha256': ('sourceSha256', 'sha256'),
                           'sourceFile': ('sourceFile', 'sourcePath', 'archivePath', 'file', 'filename'),
                           'sourceId': ('sourceId',), 'page': ('page', 'pdfPage'),
                           'sheet': ('sheet',), 'row': ('row',), 'position': ('position',)}.items():
            if key not in result:
                for name in names:
                    if src.get(name) is not None:
                        result[key] = src[name]
                        break
    return result


def guard_reason(offer, text):
    src = offer.get('sourceEvidence') or {}
    specs = src.get('sourceSpecifications') or []
    if offer.get('priceKind') == 'public':
        return 'not_archive_source', 'Javni internet zapis nije izvor za parametre.'
    verified = src.get('archiveVerified') or (offer.get('traitsEvidence') or {}).get('source', {}).get('archiveVerified')
    if not verified:
        return 'source_not_verified', 'Arhivski izvor nije označen kao proveren.'
    if offer.get('recordStatus') in ('needs_review', 'superseded'):
        return 'record_not_active', 'Zapis zahteva proveru ili je zamenjen preciznijim zapisom.'
    if src.get('multipleVariants') or ' | ' in text:
        return 'multiple_variants', 'Parametri više varijanti ne prenose se u jedan zajednički panel.'
    if any(s.get('recordRole') == 'requested_with_supplier_note' for s in specs if isinstance(s, dict)):
        return 'requested_with_supplier_alternative', 'Mere tražene biljke nisu potvrđene za ponuđenu alternativu.'
    if src.get('recordRole') in ('requested_replaced', 'unresolved_taxon_mapping', 'ambiguous_replacement'):
        return 'unresolved_source_role', 'Opis sadrži zamenu ili nepotvrđenu vezu vrste.'
    price_ev = offer.get('priceEvidence') or {}
    supplier_note = clean(price_ev.get('supplierNotes') or price_ev.get('supplierNote'))
    if supplier_note and price_ev.get('requestedDescription') and not price_ev.get('replacementApplied'):
        # A packaging-only reply applies to the named row. A new numeric size,
        # stem dimension, name, or alternative does not confirm requested sizes.
        if not re.fullmatch(r'(?:RB|WRB|BR|CLT|CONT|CG|KL|mDb|w\.b\.)[ .]*', supplier_note, FLAGS):
            return 'requested_with_supplier_alternative', 'Napomena ponuđača menja ili dopunjuje traženu varijantu; njene tražene mere nisu automatski potvrđene.'
    if re.search(r'(?<!\w)(?:alt\.?|alternative|zamena)\s+', text, FLAGS):
        # Paired PDF extraction has already separated these actual offered rows.
        if not price_ev.get('unitPriceVerifiedAgainstPDF') and not price_ev.get('alternative'):
            return 'unseparated_alternative', 'Opis sadrži nerazdvojenu alternativu; parametri nisu spojeni.'
    if re.search(r'\bC\s*\d+(?:[.,]\d+)?\s+ili\s+C\s*\d+', text, FLAGS):
        return 'unseparated_container_alternatives', 'Izvor navodi alternativne saksije povezane rečju ili; nije izabrana jedna veličina.'
    return None


def offered_text(offer):
    src = offer.get('sourceEvidence') or {}
    price = offer.get('priceEvidence') or {}
    for text in (offer.get('specification'), src.get('rawDescription'), src.get('rawSpecification'),
                 price.get('rawDescription'), price.get('specification'), price.get('pdfSize')):
        if not is_blank(text):
            return clean(text)
    return ''


def root_equivalent(a, b):
    def category(value):
        v = clean(value).casefold()
        if re.fullmatch(r'(?:rb|busen(?:\s*\(rb\))?)', v): return 'rb'
        if re.fullmatch(r'(?:wrb|busen u žičanoj korpi(?:\s*\(wrb\))?)', v): return 'wrb'
        if re.fullmatch(r'(?:br|goli koren(?:\s*\(br\))?)', v): return 'br'
        if re.fullmatch(r'(?:(?:new\s+)?clt|cont|kontejner(?:\s*\((?:clt|cont|c)\))?)', v): return 'container'
        return v
    return category(a) == category(b)


def extract_offer_parameters(offer):
    """Return deterministic, guarded changes; never mutate the supplied row."""
    if not isinstance(offer, dict):
        raise ValueError('Expected one offer object.')
    result = {'set': {}, 'evidence': {}, 'unresolved': []}
    text = offered_text(offer)
    reason = guard_reason(offer, text)
    if reason:
        result['unresolved'].append({'reason': reason[0], 'message': reason[1]})
        return result
    source = source_reference(offer)
    candidates = {field: [] for field in FIELDS}
    claimed_spans = []

    def candidate(field, value, raw, rule, **details):
        candidates[field].append({'value': value, 'raw': raw, 'rule': rule,
                                  'source': source, **details})

    # Parse only the value, never the three alternatives in this column name.
    labelled_package = list(PACKAGING_LABEL.finditer(text))
    for m in labelled_package:
        value = clean(m['value'])
        if re.fullmatch(r'RB|WRB|BR|CLT|CONT', value, FLAGS):
            code = value.upper()
            candidate('rootType', ROOT_NAMES[code], value, 'packaging_column_value', code=code)
    text_no_packaging_header = PACKAGING_LABEL.sub(lambda m: ' ' + m['value'] + ' ', text)
    scan = re.split(r';\s*NEW INPOT\s*:', text_no_packaging_header, flags=FLAGS)[0]

    for field, patterns in PATTERNS.items():
        for rule, pattern in patterns:
            for m in pattern.finditer(scan):
                prefix = scan[max(0, m.start()-28):m.start()]
                if re.search(r'(?:\bnot|\bno|\bbez|\bnema|\bnije)\s*$', prefix, FLAGS):
                    continue
                if field == 'rootBall' and re.search(r'(?:sumnjiv|nečitljiv|necitljiv|nije\s+pren[eio]t|unverified)',
                                                     scan[max(0, m.start()-50):m.end()+140], FLAGS):
                    result['unresolved'].append({'field': field, 'reason': 'source_flags_uncertain_value',
                                                 'raw': m.group(),
                                                 'message': 'Izvorni prepis izričito označava ovu vrednost kao sumnjivu ili namerno nepreuzetu; polje nije automatski popunjeno.'})
                    continue
                if field == 'height':
                    # A crown panel or clear-stem dimension is not overall height.
                    if re.search(r'(?:trunk|stem|clear|mature|max\.?|maximum|crown|canopy|stablo|deblo)\s*$', prefix, FLAGS):
                        result['unresolved'].append({'field': field, 'reason': 'different_height_kind', 'raw': m.group(),
                                                     'message': 'Ovo je posebna visina stabla, krošnje ili odrasle biljke; nije visina cele sadnice.'})
                        continue
                    if rule == 'explicit_H_label' and re.search(r'\b(?:PLEACHED|ROOF|ARCH)\b', scan, FLAGS):
                        result['unresolved'].append({'field': field, 'reason': 'shaped_plant_height_context', 'raw': m.group(),
                                                     'message': 'Kod oblikovane sadnice H može opisivati oblik ili panel; nije potvrđena ukupna visina sadnice.'})
                        continue
                candidate(field, format_measure(m), m.group(), rule,
                          unitStatus='stated' if m['unit'] else 'not_stated')
                claimed_spans.append(m.span())

    # Verified Arbor product grammar (e.g. the original stocklist B147:
    # Acer Pacific Sunset MULTISTEM 350-400 C230L). This interpretation is
    # intentionally limited to that supplier, one large range after the form,
    # and the immediately following container/root-ball code. No unit is added.
    if offer.get('nurseryId') == 'arbor' and not candidates['height']:
        large = re.search(r'\b(?:MULTISTEM|MULTI-STEM|MSTEM)\s+(?P<a>\d{3,4})\s*[-–—/]\s*(?P<b>\d{3,4})\s+(?=C\s*\d|WRB\b|RB\b)', scan, FLAGS)
        ranges = list(re.finditer(r'(?<![\w])\d+(?:[.,]\d+)?\s*[-–—/]\s*\d+(?:[.,]\d+)?', scan))
        labelled_other_measure = re.search(r'\b(?:height|visina|crown|canopy|width|širina|sirina|H\s*\d|STEM\s*\d)\b', scan, FLAGS)
        if large and len(ranges) == 1 and not labelled_other_measure and 150 <= int(large['a']) < int(large['b']) and int(large['b']) >= 200:
            candidate('height', large['a'] + '–' + large['b'], large.group().strip(),
                      'arbor_single_large_range_after_multistem_before_packaging', unitStatus='not_stated',
                      interpretation='Jedini veći raspon iza MULTISTEM i ispred oznake pakovanja tumačen je kao trgovačka visina sadnice u izvornom Arbor redu. Jedinica nije dodata.')

    pot_matches = []
    for m in C_POT.finditer(scan):
        if re.search(r'[-–—/]', m['size']) and re.match(r'\s*(?:kom|pcs\.?|pieces)\b', scan[m.end():], FLAGS):
            result['unresolved'].append({'field': 'potSize', 'reason': 'container_code_adjacent_quantity',
                                         'raw': m.group() + scan[m.end():m.end()+12],
                                         'message': 'Broj uz komade nije preuzet kao druga granica veličine saksije.'})
            continue
        size = format_size(m['size'])
        raw_code = 'C' + size + ('L' if m['unit'] else '')
        value = size + ' L' if m['unit'] else 'C' + size
        candidate('potSize', value, m.group(), 'explicit_C_pot_code',
                  unitStatus='stated' if m['unit'] else 'not_stated', code=raw_code)
        pot_matches.append((m.span(), raw_code))
    for pattern, rule in ((CLT_POT, 'explicit_CLT_pot_code'), (CLT_SIZE_COLUMN, 'CLT_type_and_size_columns')):
        for m in pattern.finditer(scan):
            size = format_size(m['size'])
            code = 'CLT ' + size + ('L' if m['unit'] else '')
            value = size + ' L' if m['unit'] else 'CLT ' + size
            candidate('potSize', value, m.group(), rule,
                      unitStatus='stated' if m['unit'] else 'not_stated', code=code)
            pot_matches.append((m.span(), code))
    for m in LITRE_POT.finditer(scan):
        if any(start <= m.start() < end for (start, end), _ in pot_matches):
            continue
        prefix = scan[max(0, m.start()-20):m.start()]
        if re.search(r'(?:voda|water|fertili[sz]er|đubrivo)\s*[:=]?\s*$', prefix, FLAGS):
            continue
        size = format_size(m['size'])
        candidate('potSize', size + ' L', m.group(), 'explicit_litre_container_volume', unitStatus='stated')
        pot_matches.append((m.span(), size + 'L'))

    # Root-ball code describes packaging, never its diameter or volume.
    codes = []
    for m in ROOT_CODES.finditer(scan):
        prefix = scan[max(0, m.start()-20):m.start()]
        if re.search(r'(?:\bnot|\bno|\bwithout|\bbez|\bnema)\s*$', prefix, FLAGS):
            continue
        code = m['code'].upper()
        if code == 'BR' and scan[m.end():].startswith('.'):
            continue
        if code == 'BR' and re.match(r'\s*\d', scan[m.end():]) and (
                offer.get('nurseryId') == 'lorberg' or re.search(r'\b(?:mDb|Schirm|Naturschirm|Sth)\b', scan, FLAGS)):
            continue
        if code not in codes: codes.append(code)
    container_codes = [raw for _, raw in pot_matches]
    container_codes = list(dict.fromkeys(container_codes))
    has_container = bool(container_codes or any(c in ('CLT', 'CONT') for c in codes))
    noncontainer = [c for c in codes if c in ('RB', 'WRB', 'BR')]
    if noncontainer and (has_container or len(noncontainer) > 1):
        raw_codes = noncontainer + (container_codes or [c for c in codes if c in ('CLT', 'CONT')])
        raw_codes = list(dict.fromkeys(raw_codes))
        candidates['rootType'] = []
        candidate('rootType', ' / '.join(raw_codes) + ' (oznake u ponudi)', ' / '.join(raw_codes),
                  'multiple_packaging_codes_preserved',
                  note='Izvor navodi više oznaka pakovanja u istom redu; sačuvane su sve oznake bez izbora jedne mogućnosti.')
    elif noncontainer:
        code = noncontainer[0]
        candidate('rootType', ROOT_NAMES[code], code, 'explicit_packaging_code', code=code)
    elif has_container:
        if 'CLT' in codes:
            candidate('rootType', ROOT_NAMES['CLT'], 'CLT', 'explicit_container_code', code='CLT')
        elif 'CONT' in codes:
            candidate('rootType', ROOT_NAMES['CONT'], 'cont', 'explicit_container_code', code='CONT')
        else:
            candidate('rootType', 'Kontejner', ' / '.join(container_codes), 'container_size_code_or_volume')
    elif is_blank(offer.get('rootType')) and re.search(r'\b(?:goli koren|bare root)\b', scan, FLAGS):
        candidate('rootType', 'Goli koren', 'goli koren / bare root', 'explicit_packaging_words')
    elif is_blank(offer.get('rootType')) and (candidates['rootBall'] or re.search(r'\b(?:rootball|root ball|busen)\b', scan, FLAGS)):
        candidate('rootType', 'Busen', 'busen / rootball', 'explicit_packaging_words')

    for field, values in candidates.items():
        if not values:
            continue
        distinct = {}
        for value in values:
            key = normalized_measure(value['value'])
            distinct.setdefault(key, value)
        if len(distinct)>1 and field == 'rootType':
            first = next(iter(distinct.values()))
            if all(root_equivalent(first['value'], v['value']) for v in distinct.values()):
                distinct = {normalized_measure(first['value']): first}
        if len(distinct) > 1:
            result['unresolved'].append({'field': field, 'reason': 'multiple_parameter_values',
                                         'candidates': list(distinct.values()),
                                         'message': 'Izvor navodi više vrednosti za isto polje; nijedna nije izabrana proizvoljno.'})
            continue
        evidence = next(iter(distinct.values()))
        current = offer.get(field)
        if is_blank(current):
            result['set'][field] = evidence['value']
            evidence = {**evidence, 'operation': 'fill_blank'}
        elif field == 'rootType' and clean(current).upper() in ROOT_NAMES and root_equivalent(current, evidence['value']):
            normalized = ROOT_NAMES[clean(current).upper()]
            result['set'][field] = normalized
            evidence = {**evidence, 'value': normalized, 'previousValue': current,
                        'operation': 'normalize_equivalent_code'}
        elif (root_equivalent(current, evidence['value']) if field == 'rootType'
              else parameter_equivalent(field, current, evidence['value'])):
            evidence = {**evidence, 'operation': 'already_present'}
        else:
            evidence = {**evidence, 'operation': 'existing_value_preserved', 'existingValue': current}
            result['unresolved'].append({'field': field, 'reason': 'existing_value_conflict',
                                         'existingValue': current, 'sourceValue': evidence['value'], 'raw': evidence['raw'],
                                         'message': 'Postojeća vrednost je sačuvana; razlikuje se od izdvojene izvorne oznake i zahteva proveru.'})
        result['evidence'][field] = evidence

    # Existing raw packaging codes can be normalized even if a shortened
    # specification omitted the code. The existing source is still verified.
    current_root = clean(offer.get('rootType'))
    code = current_root.upper()
    if code in ROOT_NAMES and 'rootType' not in result['evidence']:
        result['set']['rootType'] = ROOT_NAMES[code]
        result['evidence']['rootType'] = {'value': ROOT_NAMES[code], 'raw': current_root,
                                          'rule': 'normalize_existing_verified_source_code',
                                          'operation': 'normalize_equivalent_code', 'source': source}
    for code in dict.fromkeys(m.group() for m in UNKNOWN_CODES.finditer(scan)):
        result['unresolved'].append({'field': 'rootType', 'reason': 'unexplained_supplier_code', 'raw': code,
                                     'message': 'Izvorni kod je sačuvan; bez legende nije preveden u drugi način isporuke.'})
    assert set(result['set']) <= set(FIELDS)
    return result


def build_patch(document):
    updates, unresolved, counts = [], [], Counter()
    for offer in document['offers']:
        parsed = extract_offer_parameters(offer)
        counts['recordsExamined'] += 1
        if parsed['set']:
            updates.append({'id': offer['id'], 'expected': {'plantId': offer['plantId'], 'nurseryId': offer['nurseryId'],
                            **{k: offer.get(k, '') for k in parsed['set']}},
                            'set': parsed['set'], 'evidence': parsed['evidence']})
            counts['recordsUpdated'] += 1
            for field in parsed['set']:
                counts['field_' + field] += 1
                counts[parsed['evidence'][field]['operation']] += 1
        if parsed['unresolved']:
            unresolved.append({'id': offer['id'], 'items': parsed['unresolved']})
            for item in parsed['unresolved']:
                counts['unresolved_' + item['reason']] += 1
    return {'schemaVersion': 1, 'operation': 'extract_explicit_archive_parameters',
            'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'summary': dict(counts), 'updates': updates, 'unresolved': unresolved,
            'rules': ['Original archive must be verified.',
                      'Only explicit labels and established packaging/pot codes are read.',
                      'No bare numeric range becomes height or circumference.',
                      'RB describes a root ball, not its dimension.',
                      'Aggregates, unresolved alternatives and review rows are not merged.',
                      'Different existing values, price, currency, photograph and plant type are preserved.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path('data/kataloske-stavke.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    original = args.data.read_bytes()
    patch = build_patch(json.loads(original))
    patch['baselineSha256'] = hashlib.sha256(original).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(patch, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(patch['summary'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

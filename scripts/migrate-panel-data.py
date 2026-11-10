#!/usr/bin/env python3
"""Move verified archived offer specifications into every plant-card panel.

Offline and idempotent. Values remain tied to their own archived offer row.
This does not fetch data, change prices/photos, or add plants or nurseries.
"""
import argparse
import copy
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from classify_offer_traits import classify_offer
from extract_offer_parameters import extract_offer_parameters, reviewed_accuracy_note

FIELDS = ('seedlingType', 'circumference', 'height', 'crownWidth',
          'rootBall', 'potSize', 'rootType')
PROTECTED = ('price', 'currency', 'priceKind', 'priceNote', 'priceEvidence',
             'taxStatus', 'image', 'imageSourceUrl', 'plantId', 'nurseryId',
             'sourceDate', 'sourceUrl', 'specification', 'recordStatus')
INACTIVE = {'superseded', 'needs_review'}
OLD_NOTE_SENTENCES = (
    'Neoznačena dimenzija preneta je u izvornu specifikaciju; bez izričitog naziva mere nije proglašena obimom ili visinom.',
    'Mere u zasebnim poljima prenete su iz ove varijante i njihovih izričitih oznaka.',
    'Neoznačene mere ostaju u specifikaciji dok njihov tip nije potvrđen.',
)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write(path, document):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def clean_note(value):
    value = str(value or '')
    for sentence in OLD_NOTE_SENTENCES:
        value = value.replace(sentence, '')
    value = value.replace('Broj presađivanja prenet je u napomenu sa izvornom neodređenošću.',
                          'Broj presađivanja prikazan je u glavnom panelu sa izvornom neodređenošću.')
    value = value.replace('kodovi HS, MSTEM, SOL, WRB, CG i KL nisu pretvarani u druge mere.',
                          'izvorne oznake ostaju vidljive uz izdvojene parametre.')
    return ' '.join(value.split())


def merge_parameters(existing, extracted):
    """One readable field per label; retain all distinct source evidence."""
    grouped = {}
    for item in [*existing, *extracted]:
        label = item.get('label', '').strip()
        value = str(item.get('value', '')).strip()
        if not label or not value:
            continue
        if label == 'Nerazvrstana mera iz ponude':
            label = 'Dimenzija iz ponude'
        group = grouped.setdefault(label, {'label': label, 'values': [], 'sources': []})
        for part in re.split(r';\s+', value):
            if part not in group['values']:
                group['values'].append(part)
        refs = item.get('sources') or ([item['source']] if item.get('source') else [])
        for ref in refs:
            if ref not in group['sources']:
                group['sources'].append(copy.deepcopy(ref))
    result = []
    for group in grouped.values():
        item = {'label': group['label'], 'value': '; '.join(group['values'])}
        if group['sources']:
            item['sources'] = group['sources']
        assert len(item['value']) <= 600, item
        result.append(item)
    return result


def remove_reviewed_parameters(parameters, retired):
    """Retire only reviewed label/value pairs, preserving other source facts."""
    def key(value):
        return re.sub(r'\s+', '', str(value or '')).casefold().replace('–', '-').replace('—', '-')

    output = []
    for parameter in parameters:
        values = {key(item['value']) for item in retired if item['label'] == parameter['label']}
        if key(parameter['value']) in values:
            continue
        parts = [part.strip() for part in re.split(r';\s+', parameter['value'])
                 if key(part) not in values]
        if parts:
            output.append({**parameter, 'value': '; '.join(parts)})
    return output


def remove_mapped_generic_dimensions(parameters, offer, retired=()):
    """Retire the old fallback after its source value has a proper field.

    This changes the data too, so downstream exports do not carry the same
    size twice. Distinct units and genuinely unclassified values are retained.
    """
    def measure(value):
        value = re.sub(r'\s+', '', str(value or '').lower())
        value = re.sub(r'(?<=\d),(?=\d)', '.', value)
        value = re.sub(r'[-–—/]', '–', value)
        match = re.fullmatch(r'(\d+(?:\.\d+)?(?:–\d+(?:\.\d+)?)?\+?)(mm|cm|m)?', value)
        return (match[1], match[2] or '') if match else None

    typed = [measure(offer.get(field)) for field in
             ('circumference', 'height', 'crownWidth', 'rootBall')]
    typed = [value for value in typed if value]
    def retired_key(value):
        return re.sub(r'\s+', '', str(value or '')).casefold().replace('–', '-').replace('—', '-')
    retired_keys = {retired_key(value) for value in retired}
    output = []
    for parameter in parameters:
        if parameter['label'] not in ('Dimenzija iz ponude', 'Nerazvrstana mera iz ponude'):
            output.append(parameter)
            continue
        if retired_key(parameter['value']) in retired_keys:
            continue
        remaining = []
        for part in re.split(r'[;·]', parameter['value']):
            part = part.strip()
            if retired_key(part) in retired_keys:
                continue
            candidate = measure(part)
            if candidate and any(candidate[0] == known[0] and
                                 (not candidate[1] or not known[1] or candidate[1] == known[1])
                                 for known in typed):
                continue
            if part and part not in remaining:
                remaining.append(part)
        if remaining:
            output.append({**parameter, 'value': '; '.join(remaining)})
    return output


def migrate(document):
    assert document.get('sourcePolicy') == {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']}
    result = copy.deepcopy(document)
    report = {'operation': 'archive-specification-to-all-main-panels',
              'changes': [], 'unresolved': [], 'sourcePolicy': result['sourcePolicy']}
    for before, offer in zip(document['offers'], result['offers']):
        if offer.get('recordStatus') in INACTIVE:
            continue
        assert offer.get('sourceEvidence', {}).get('archiveVerified'), offer['id']
        parsed = extract_offer_parameters(offer)
        assert set(parsed['set']) <= set(FIELDS) - {'seedlingType'}
        offer.update(parsed['set'])
        previous_parameters = offer.get('additionalParameters', [])
        additional = remove_mapped_generic_dimensions(
            remove_reviewed_parameters(
                merge_parameters(previous_parameters, parsed.get('additionalParameters', [])),
                parsed.get('retireParameters', [])),
            offer, parsed.get('retireGenericDimensions', []))
        if additional:
            offer['additionalParameters'] = additional
        else:
            offer.pop('additionalParameters', None)
        source = offer.get('sourceEvidence', {})
        if source.get('note'):
            cleaned = clean_note(source['note'])
            if cleaned != source['note']:
                source.setdefault('originalExtractionNote', source['note'])
                source['note'] = cleaned
        if offer.get('measurementNote'):
            offer['measurementNote'] = clean_note(offer['measurementNote'])
        offer.update(classify_offer(offer, source))
        offer['dataAccuracyNote'] = clean_note(offer['dataAccuracyNote'])
        if any(e.get('unitStatus') == 'not_stated' for field, e in parsed['evidence'].items()
               if field in ('height', 'circumference', 'crownWidth', 'rootBall')):
            note = 'Jedinica dužine nije navedena uz ovu meru u izvoru.'
            if note not in offer.get('measurementNote', ''):
                offer['measurementNote'] = (offer.get('measurementNote', '') + ' ' + note).strip()
        for field, correction in parsed.get('displayNoteCorrections', {}).items():
            if before.get(field, '') in (correction['expectedValue'], correction['value']):
                value = (reviewed_accuracy_note(offer, correction['value'])
                         if field == 'dataAccuracyNote' else correction['value'])
                if value:
                    offer[field] = value
                else:
                    offer.pop(field, None)
        assert len(offer.get('measurementNote', '')) <= 300, offer['id']
        assert offer.get('dataAccuracyNote'), offer['id']
        assert len(offer.get('dataAccuracyNote', '')) <= 1600, offer['id']
        changes = {field: {'from': before.get(field, ''), 'to': offer.get(field, '')}
                   for field in FIELDS if before.get(field, '') != offer.get(field, '')}
        if changes:
            # Preserve existing evidence and attach the exact newly used rules.
            evidence = offer.setdefault('panelParameterEvidence', {'origin': 'Rasadnici ponude.zip'})
            rules = evidence.setdefault('rules', {})
            for field in changes:
                if field in parsed['evidence']:
                    rules[field] = copy.deepcopy(parsed['evidence'][field])
            report['changes'].append({'offerId': offer['id'], 'fields': changes,
                                      'source': {k: source[k] for k in
                                                 ('sourceFile', 'sourceSha256', 'sheet', 'row') if k in source}})
        if parsed['unresolved']:
            report['unresolved'].append({'offerId': offer['id'], 'items': parsed['unresolved']})
        for field in PROTECTED:
            assert offer.get(field) == before.get(field), (offer['id'], field)
    active = [o for o in result['offers'] if o.get('recordStatus') not in INACTIVE]
    prior_active = [o for o in document['offers'] if o.get('recordStatus') not in INACTIVE]
    report['summary'] = {
        'records': len(result['offers']), 'activeRecords': len(active),
        'recordsWithStructuredFieldChanges': len(report['changes']),
        'changedFields': dict(Counter(field for item in report['changes'] for field in item['fields'])),
        'activeParameters': {field: sum(bool(o.get(field)) for o in active) for field in FIELDS},
        'emptyOriginalPanelsBefore': sum(not any(o.get(field) for field in FIELDS) for o in prior_active),
        'emptyOriginalPanelsAfter': sum(not any(o.get(field) for field in FIELDS) for o in active),
        'additionalParameters': sum(len(o.get('additionalParameters', [])) for o in active),
        'recordsWithAdditionalParameters': sum(bool(o.get('additionalParameters')) for o in active),
        'transplantsInMainPanel': sum(bool(o.get('transplantNote')) for o in active),
        'sourceSpecificationsPreservedInData': sum(bool(o.get('specification')) for o in active),
        'rawSpecificationsShownInPanel': False,
        'pricesPreserved': sum(o.get('price') is not None for o in result['offers']),
        'existingPricesPhotosAndSpeciesUnchanged': True,
        'onlinePriceOrParameterRequests': 0,
    }
    if result != document:
        result['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    report['updatedAt'] = result['updatedAt']
    return result, report


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=root / 'data/kataloske-stavke.json')
    parser.add_argument('--output', type=Path, help='Omit to inspect without writing catalogue data.')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    before = read(args.input)
    after, report = migrate(before)
    report['inputSha256'] = hashlib.sha256(args.input.read_bytes()).hexdigest()
    if args.output:
        write(args.output, after)
        report['outputSha256'] = hashlib.sha256(args.output.read_bytes()).hexdigest()
    if args.report:
        write(args.report, report)
    print(json.dumps(report['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

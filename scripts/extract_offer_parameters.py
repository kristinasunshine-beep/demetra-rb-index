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
from functools import lru_cache
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
        ('explicit_height_label', re.compile(rf'(?<!\w)(?:height|hoogte|höhe|hoehe|visina(?:\s+sadnice)?|висина(?:\s+саднице)?)\s*(?:\[(?:cm|m|mm)\])?\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
        ('explicit_H_label', re.compile(rf'(?<![\w])H\s*[=:]?\s*{MEASURE}{END}', FLAGS)),
    ],
    'circumference': [
        ('explicit_circumference_label', re.compile(rf'(?<!\w)(?:circumference|circums\.?|circum\.?|circ\.?|cir\.?|girth|obim(?:\s+(?:sadnice|stabla))?|обим(?:\s+(?:саднице|стабла))?)\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
        ('explicit_O_equals_label', re.compile(rf'(?<!\w)O\s*[=:]\s*{MEASURE}{END}', FLAGS)),
    ],
    'crownWidth': [
        ('explicit_crown_width_label', re.compile(rf'(?<!\w)(?:crown\s*width|canopy\s*width|širina\s+krošnje|sirina\s+krosnje|ширина\s+крошње)\s*[:=]?\s*{MEASURE}{END}', FLAGS)),
        ('explicit_W_width_label', re.compile(rf'(?<!\w)W\s*[=:]?\s*{MEASURE}{END}', FLAGS)),
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
LORBERG_LEGEND = 'https://www.lorberg.com/en-gb/list-of-abbreviations'
DUTCH_LEGEND = 'https://www.boomkwekerij-bogaert.be/malus-toringo-brouwers-beauty-10-12-hoogstam-wortelgoed'
CONTAINER_LEGEND = 'https://www.wykehammatureplants.co.uk/help-advice/caring-for-your-plants/root-condition-explained/'
ARBOR_LEGEND = 'https://www.arbor.be/faq'
TREE_SIZE_LEGEND = 'https://www.boomkwekerij-debruyn.com/en/advies/boomvormen/'
# These taxonomic groups are used only together with a verified nursery row,
# a single size expression and the supplier's plant-form/packing grammar.
# Spreading/topiary/grafted forms are excluded below: their size can mean
# crown width or clear-stem height instead of the whole plant's height.
UPRIGHT_CONIFER_GENERA = {'abies', 'cedrus', 'chamaecyparis', 'cryptomeria',
    'cupressus', 'cupressocyparis', 'larix', 'metasequoia', 'picea', 'pinus',
    'pseudotsuga', 'sequoiadendron', 'taxodium', 'taxus', 'thuja'}
SHRUB_GENERA = {'abelia', 'berberis', 'buddleia', 'buddleja', 'callicarpa',
    'caryopteris', 'chimonanthus', 'cotinus', 'deutzia', 'elaeagnus', 'fargesia',
    'hamamelis', 'hammamelis', 'heptacodium', 'hibiscus', 'hydrangea', 'hypericum',
    'kolkwitzia', 'lavandula', 'ligustrum', 'lonicera', 'osmanthus', 'perovskia',
    'philadelphus', 'phyllostachys', 'photinia', 'physocarpus', 'pleioblastus',
    'potentilla', 'punica', 'ribes', 'sarcococca', 'spiraea', 'syringa', 'viburnum',
    'weigela'}
SPECIAL_FORM = re.compile(r'\b(?:STD|HO|HS|HST|standard|hoogstam|STEM|STH|STAM|'
    r'BALL|PALLA|GLOBE|GÖMB|CUBE|BOX|CONE|SPIRAL|PYRAMID|BEEHIVE|BONSAI|BONZAI|'
    r'NIWAKI|UMBRELLA|SCHIRM|NATURSCHIRM|ROOF|PLEACHED|SCREEN|ARCH|CLOUD|'
    r'diameter|prečnik|precnik|StU|STAMMUMFANG)(?=\b|\d)', FLAGS)
SPREADING_TAXON = re.compile(r'\b(?:mugo|watereri|brepo|breppo|nana|danica|'
    r'globosa|globe|horizontalis|repens|prostrata|kelsey|nikko|maigrün|maigrun|'
    r'compacta|compactum|compactus|coral beauty|parkteppich|eichholz|skogholm)\b', FLAGS)
# These rules interpret the markings in the archived row. They do not fetch
# dimensions, approximate sizes, current availability or prices from the web.
SUPPLIER_ROOT_CODES = {
    'combinatie-mauritz': {'KL': 'Busen (KL)', 'DRKL': 'Busen u žičanoj korpi (DRKL)'},
    'volentis': {'KL': 'Busen (KL)', 'DRKL': 'Busen u žičanoj korpi (DRKL)', 'CG': 'Kontejner (CG)'},
    'lorberg': {'MDB': 'Busen u žičanoj korpi (mDb)', 'MB': 'Busen (mB)', 'OB': 'Goli koren (oB)'},
    'vannucci-piante': {'ZOLLA': 'Busen (ZOLLA)'},
    'innocenti-mangoni': {'W.B.': 'Busen u žičanoj korpi (w.b.)'},
    'arbor': {'WOODBOX': 'Drvena kutija (WOODBOX)', 'AIRPOT': 'Air-Pot kontejner (AIRPOT)'},
}
REVIEWED_AXES_PATH = Path(__file__).with_name('archive-measurement-axes.json')


def clean(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())


def is_blank(value):
    return clean(value).casefold().strip(' .') in MISSING


def reviewed_accuracy_note(offer, value):
    """The required accuracy field stays truthful after obsolete prose retires."""
    if clean(value):
        return clean(value)
    if is_blank(offer.get('seedlingType')):
        return 'Tip sadnice nije izričito označen u ovom redu ponude; nije pretpostavljen.'
    return 'Podaci se odnose na ovu izvornu varijantu ponude.'


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


@lru_cache(maxsize=1)
def reviewed_axis_records():
    """Read reviewed archive rows, never a global numeric-size heuristic.

    The registry records the original source hash, exact row specification,
    identity, and reviewed old field values. It never updates prices or photos.
    """
    document = json.loads(REVIEWED_AXES_PATH.read_text(encoding='utf-8'))
    if document.get('schemaVersion') != 1:
        raise ValueError('Unsupported reviewed measurement-axis registry.')
    records = document['records']
    if len({item['id'] for item in records}) != len(records):
        raise ValueError('Duplicate reviewed measurement-axis record.')
    for item in records:
        if set(item.get('fields', {})) - set(FIELDS):
            raise ValueError('Reviewed measurements may only change card parameter fields.')
    return {item['id']: item for item in records}


def reviewed_axis_record(offer):
    """An archive review is valid only for that exact source row and plant."""
    item = reviewed_axis_records().get(offer.get('id'))
    if not item:
        return None
    src = offer.get('sourceEvidence') or {}
    if not src.get('archiveVerified') or offer.get('recordStatus') in ('needs_review', 'superseded'):
        return None
    expected = item['expected']
    if any(offer.get(key) != expected[key] for key in ('plantId', 'nurseryId', 'specification')):
        return None
    actual_source = source_reference(offer)
    if any(actual_source.get(key) != value for key, value in expected['source'].items()):
        return None
    return item


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
    price_ev = offer.get('priceEvidence') or {}
    # The migration can explicitly keep a request as its own unpriced row.
    # It must match the archived request exactly; this never lends requested
    # measurements to a priced supplier alternative.
    sole_spec = specs[0] if len(specs) == 1 and isinstance(specs[0], dict) else {}
    requested_description = clean(price_ev.get('requestedDescription') or
                                  src.get('requestedDescription') or sole_spec.get('requestedDescription'))
    requested_only = (src.get('parameterRole') == 'requested' and
                      src.get('archiveVerified') is True and len(specs) <= 1 and
                      offer.get('price') is None and
                      bool(requested_description) and text == requested_description)
    if requested_only and re.search(r'\bAcer\s+\w+.*\bAcer\s+\w+', text, FLAGS):
        return 'unresolved_source_role', 'Izvorni zahtev sadrži dva naziva Acer; mere nisu dodeljene jednoj biljci bez potvrde zamene.'
    if not requested_only and any(s.get('recordRole') == 'requested_with_supplier_note' for s in specs if isinstance(s, dict)):
        return 'requested_with_supplier_alternative', 'Mere tražene biljke nisu potvrđene za ponuđenu alternativu.'
    if not requested_only and src.get('recordRole') in ('requested_replaced', 'unresolved_taxon_mapping', 'ambiguous_replacement'):
        return 'unresolved_source_role', 'Opis sadrži zamenu ili nepotvrđenu vezu vrste.'
    supplier_note = clean(price_ev.get('supplierNotes') or price_ev.get('supplierNote'))
    if not requested_only and supplier_note and price_ev.get('requestedDescription') and not price_ev.get('replacementApplied'):
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
        v = re.sub(r'\s*\(oznaka izvora\)$', '', v)
        for mapping in SUPPLIER_ROOT_CODES.values():
            for code, label in mapping.items():
                if v in (code.casefold(), label.casefold()):
                    return label.casefold()
        if re.fullmatch(r'(?:rb|busen(?:\s*\(rb\))?)', v): return 'rb'
        if re.fullmatch(r'(?:wrb|busen u žičanoj korpi(?:\s*\(wrb\))?)', v): return 'wrb'
        if re.fullmatch(r'(?:br|goli koren(?:\s*\(br\))?)', v): return 'br'
        if re.fullmatch(r'(?:(?:new\s+)?clt|c|cont|kontejner(?:\s*\((?:clt|cont|c)\))?)', v): return 'container'
        return v
    return category(a) == category(b)


def archived_taxon(offer, text):
    """Prefer a taxon actually printed in this source, never a search alias."""
    src, price = offer.get('sourceEvidence') or {}, offer.get('priceEvidence') or {}
    for value in (offer.get('sourceLatinName'), price.get('offeredName'),
                  src.get('sourceLatinName'), price.get('rawName'), src.get('rawName'),
                  text):
        value = clean(value)
        value = re.sub(r'^(?:Product|PONUĐENO|Requested|Offered)\s*:\s*', '', value, flags=FLAGS)
        if re.match(r'^[A-Za-zÀ-ž]+\s+[A-Za-zÀ-ž\'"‘’]', value):
            return re.split(r';|\b(?:Size|Height|Circums)\s*:', value, maxsplit=1, flags=FLAGS)[0].strip()
    return ''


def semantic_dimensions(offer, text, candidate, candidates, additional):
    """Map single nursery size classes with form/taxon/source evidence.

    A plain range in an unknown supplier remains unclassified. Each rule
    below combines the verified archived row with a particular supplier's
    size-column/product grammar. Numeric size alone never selects an axis.
    """
    nursery = offer.get('nurseryId', '')
    source = source_reference(offer)
    filename = source.get('sourceFile', '')
    taxon = archived_taxon(offer, text)
    genus = taxon.split()[0].casefold() if taxon else ''
    range_only = rf'{NUMBER}\s*[-–—/]\s*{NUMBER}'
    expression = rf'(?:{range_only}\s*\+?|{NUMBER}\s*\+|{NUMBER}\s*(?:mm|cm|m))(?:\s*(?:mm|cm|m))?'
    found = list(re.finditer(rf'(?<![\w.,])(?P<size>{expression})(?![\w])', text, FLAGS))
    known = [normalized_measure(v['value']) for vs in candidates.values() for v in vs]
    known += [normalized_measure(offer.get(f)) for f in FIELDS if not is_blank(offer.get(f))]
    known += [normalized_measure(v['value']) for v in additional]
    remaining = [m for m in found if not any(normalized_measure(m['size']) in v for v in known)]
    # Requested-and-offered text is handled by the source-role migration.
    # Merely recognizing a form in its reply must not promote the request's
    # old size to a parameter of the supplier's replacement.
    if re.search(r';\s*PONUĐENO\s*:', text, FLAGS):
        return
    has_multiple_axes = bool(re.search(r'\d\s*[x×]\s*\d', text, FLAGS))

    def add(field, match, rule, why, legend=TREE_SIZE_LEGEND, value=None):
        value = format_size(value if value is not None else match['size'])
        candidate(field, value, match.group(), rule,
                  unitStatus='stated' if re.search(r'(?:mm|cm|m)$', value, FLAGS) else 'not_stated',
                  interpretation=why, interpretationSource=legend,
                  sourceTaxon=taxon, sourceGrammar=filename)

    # The Serbian tender prints the tree's girth first, then Hxxx and/or
    # "standard". The source scan was checked; a slash is not a height/width
    # separator in these rows. Girth remains independent of overall height.
    if nursery == 'rasadnik-zica' and filename == 'Demetra za tender cene.pdf':
        if len(remaining) == 1 and (re.search(r'\bstandard\b', text, FLAGS) or candidates['height']):
            m = remaining[0]
            if re.fullmatch(range_only + r'(?:\s*cm)?', m['size'], FLAGS):
                add('circumference', m, 'zica_tender_girth_before_height_or_standard',
                    'Obim je prva mera u izvornom opisu standardnog stabla; ukupna visina je zasebno označena sa H.')
        return

    # Directly labelled plant forms determine the axis, without a numeric
    # threshold. Only one otherwise unclaimed size can be promoted this way.
    if len(remaining) == 1 and nursery in ('arbor', 'combinatie-mauritz', 'volentis',
                                          'lorberg', 'innocenti-mangoni'):
        m = remaining[0]
        form_text = re.sub(r"'[^']*'|\"[^\"]*\"", '', text)
        form = re.search(r'\b(?:MULTI[ -]*ST(?:EM|EAM)(?:MED)?|MSTEM|MEERSTAMMIG|BUSH|STR|SPECIMEN|SOLITAIRE|SOLITAIR)\b', form_text, FLAGS)
        if form and not SPECIAL_FORM.search(form_text) and not has_multiple_axes:
            if not candidates['height'] and is_blank(offer.get('height')):
                add('height', m, 'single_size_of_explicit_shrub_multistem_or_specimen',
                    'Jedina neoznačena veličina pripada izričito navedenoj žbunastoj, višestablastoj ili soliternoj formi.')
                return

    # Exclude crown shapes, clear stem dimensions, spread-prone taxa and
    # multi-axis descriptions before interpreting a natural plant's size.
    if (not taxon or len(remaining) != 1 or SPECIAL_FORM.search(text) or
            SPREADING_TAXON.search(taxon) or re.search(r'\b(?:FTHD?|feathered|Bev\.?)\b', text, FLAGS) or
            has_multiple_axes):
        return
    m = remaining[0]
    if candidates['height'] or not is_blank(offer.get('height')):
        return
    is_conifer = genus in UPRIGHT_CONIFER_GENERA
    is_shrub = (genus in SHRUB_GENERA or
                bool(re.match(r'(?:Cornus\s+(?:alba|sanguinea|stolonifera|kousa|florida)|'
                              r'Euonymus\s+(?:alatus|japonicus)|Prunus\s+(?:laurocerasus|lusitanica)|'
                              r'Acer\s+(?:palmatum|japonicum))\b', taxon, FLAGS)))
    packing = bool(re.search(r'\b(?:WRB|RB|BR|KL|DRKL|CG|CONT|WOODBOX|AIRPOT|'
                             r'(?:CLT\s*\.?|C|P)\s*\d+(?:[.,]\d+)?L?)\b', text, FLAGS))
    if nursery == 'volentis' and (is_conifer or is_shrub) and packing:
        # Volentis's PDF Size column distinguishes HS/FTH tree grades from
        # the natural shrub/conifer height followed by its root condition.
        add('height', m, 'volentis_natural_conifer_or_shrub_size_column',
            'Izvorna Volentis Size kolona za prirodnu formu četinara/žbuna daje visinsku klasu uz pakovanje; HS/FTH i oblikovane forme su isključene.', DUTCH_LEGEND)
    elif nursery == 'arbor' and (is_conifer or is_shrub) and packing:
        add('height', m, 'arbor_natural_conifer_or_shrub_before_packaging',
            'Jedina mera prirodne forme četinara/žbuna u Arbor Product redu je visinska klasa; saksija je zasebno kodirana, bez STD i oblikovane forme.', ARBOR_LEGEND)
    elif nursery == 'combinatie-mauritz' and (is_conifer or is_shrub):
        source_context = filename in ('1. Offer for trees.xlsx', 'Kopie van Shrubs perrenials.xlsx',
                                     'special stocklist Demetra.xlsx')
        source_context |= bool(re.search(r'(?:Izvorna oznaka|Suggested size|Size)\s*:', text, FLAGS))
        if source_context or packing:
            add('height', m, 'mauritz_natural_conifer_or_shrub_size_column',
                'Veličina prirodnog četinara/žbuna izdvojena je iz Size/specifikacije arhivskog reda; poseban obim i oblikovane forme nisu pretpostavljeni.', DUTCH_LEGEND)
    elif nursery == 'lorberg' and is_shrub and filename == 'CENOVNIK-LORBERG.xlsx':
        add('height', m, 'lorberg_natural_shrub_single_dimension',
            'Jednostruka veličina prirodnog žbuna/četinara u koloni DIMENZIJE tumači se po Lorberg visinskoj klasi; složene i oblikovane dimenzije su isključene.', LORBERG_LEGEND)
    elif nursery in ('innocenti-mangoni', 'vannucci-piante') and is_shrub and packing:
        add('height', m, 'italian_natural_shrub_size_with_container',
            'Jedina mera prirodnog žbuna u arhivskoj ponudi stoji uz odvojenu oznaku kontejnera/busena; oblikovane forme su isključene.')
    elif nursery == 'willaert' and filename == 'Kopie van Offer inquiry 110925.xlsx':
        if re.search(r'\d\s*(?:L|GAL)\s+' + re.escape(m.group()) + r'\s*$', text, FLAGS) and re.search(r'mm$', m['size'], FLAGS):
            add('height', m, 'willaert_project_plant_size_after_container_volume',
                'U izvornom projektnom redu Willaert posle zasebne zapremine saksije sledi visina sadnice izražena u mm; izvorna jedinica ostaje ista.')


def supplier_parameters(offer, text, candidate, additional, unresolved):
    """Read supplier grammar and retain dimensions of specialised forms.

    Numeric magnitude alone is never enough to assign a measurement field.
    A form code, explicit label or source-specific position is required.
    """
    nursery = offer.get('nurseryId', '')
    source = source_reference(offer)
    range_only = rf'{NUMBER}\s*[-–—/]\s*{NUMBER}'
    measure = rf'(?:{range_only}|{NUMBER}\s*\+)'

    def add(field, value, raw, rule, legend=None):
        details = {'unitStatus': 'stated' if re.search(r'\b(?:mm|cm|m)\b', value) else 'not_stated',
                   'interpretation': 'Tip mere određen je oznakom forme ili rasporedom parametara u izvornom redu.'}
        if legend:
            details['interpretationSource'] = legend
        candidate(field, format_size(value), raw, rule, **details)

    def extra(label, value, raw, rule):
        item = {'label': label, 'value': clean(value), 'source': {**source, 'raw': raw, 'rule': rule}}
        if not any(x['label'] == label and x['value'] == item['value'] for x in additional):
            additional.append(item)

    # Dutch form markers identify the measurement, including glued 25-30HS.
    if nursery in ('combinatie-mauritz', 'volentis'):
        for m in re.finditer(rf'(?<![\w])(?P<size>{range_only})\s*(?:HO|HS|HST|STD|standard|hoogstam)(?![A-Za-z])', text, FLAGS):
            add('circumference', m['size'], m.group(), 'dutch_standard_girth_class', DUTCH_LEGEND)
        for m in re.finditer(rf'(?<!\w)(?:MULTI[ -]*STEM(?:MED)?|MSTEM|MS|MEERSTAMMIG)\s+(?P<size>{measure})(?:\s*(?P<unit>cm|m))?(?![\w])', text, FLAGS):
            add('height', m['size'] + (' ' + m['unit'] if m['unit'] else ''), m.group(), 'dutch_multistem_height_class', DUTCH_LEGEND)
        for m in re.finditer(rf'(?<!\w)(?P<size>{measure})\s+(?:MSTEM|MS|MULTI[ -]*STEM(?:MED)?|SOL)(?![A-Za-z])', text, FLAGS):
            add('height', m['size'], m.group(), 'dutch_multistem_or_solitary_height_class', DUTCH_LEGEND)
        # A Size column bearing a sole packaging code and no tree form remains
        # undecided unless its meaning is explicitly described in the archive.
        for m in re.finditer(rf'(?<![\w])(?P<size>{range_only})\s+FTH(?:D)?(?![A-Za-z])', text, FLAGS):
            extra('Obim / visina iz ponude', format_size(m['size']) + ' (FTH)', m.group(), 'feathered_size_retained_without_type_guess')
        if re.search(r'\bMULTI[ -]*STEM\b', text, FLAGS):
            m = re.search(rf'(?:Suggested size|Size|Izvorna oznaka)\s*:\s*(?P<size>{measure})', text, FLAGS)
            if m:
                add('height', m['size'], m.group(), 'dutch_labelled_multistem_size', DUTCH_LEGEND)

    # Lorberg publishes the meanings H, Sol, Sol Baum, StU and mDb. The
    # trailing standard size is girth; H 3xv never means a height of 3.
    if nursery == 'lorberg':
        m = re.search(rf'\bH\s+\d+xv\s+(?:mDb|mB|oB)\s+(?P<size>{range_only})(?:\s*cm)?(?:\s|$)', text, FLAGS)
        if m:
            add('circumference', m['size'], m.group(), 'lorberg_H_standard_girth', LORBERG_LEGEND)
        for m in re.finditer(rf'(?<!\w)(?:StU|Stammumfang)\s*\.?\s*(?P<size>{range_only})(?:\s*(?P<unit>cm))?', text, FLAGS):
            add('circumference', m['size'] + (' cm' if m['unit'] else ''), m.group(), 'lorberg_explicit_girth', LORBERG_LEGEND)
        for m in re.finditer(rf'(?<!\w)(?:br\.?|breit|Breite)\s*(?P<size>{range_only})(?:\s*(?P<unit>cm|m))?', text, FLAGS):
            add('crownWidth', m['size'] + (' ' + m['unit'] if m['unit'] else ''), m.group(), 'lorberg_explicit_width')
        # 'Sol Baum ... width x height girth' is preserved as a combined
        # dimension until an archive header proves the width/height order.
        m = re.search(rf'\bSol\s+(?:Baum|Tree)\b.*?(?P<dims>{range_only}\s*[x×]\s*{range_only})\s+(?P<girth>{range_only})\s*$', text, FLAGS)
        if m:
            add('circumference', m['girth'], m.group(), 'lorberg_sol_baum_girth_after_dimensions', LORBERG_LEGEND)
            extra('Dimenzije sadnice iz ponude', format_size(m['dims']), m['dims'], 'lorberg_combined_dimensions')
        elif re.search(r'\b(?:Sol|Schirm|Naturschirm)\b', text, FLAGS):
            # Do not confuse Sth/KA/width numbers with the final total size.
            m = re.search(rf'(?<![\w])(?P<size>{range_only})\s*$', text)
            if m:
                before = text[:m.start()]
                if not re.search(r'(?:br\.?|Sth\.?|KA|[x×])\s*$', before, FLAGS):
                    src = offer.get('sourceEvidence') or {}
                    photo_attachment = (src.get('extraction') == 'archive_filename' or
                                        src.get('recordRole') == 'photo_attachment_description' or
                                        bool(re.search(r'\.(?:jpe?g|png|webp|tiff?)$', source.get('sourceFile', ''), FLAGS)))
                    if photo_attachment and re.search(r'\b(?:Schirm|Naturschirm)\b', text, FLAGS):
                        # A photo filename gives the canopy form, but does
                        # not establish whether its bare size is height or
                        # width. Explicit H/height labels are parsed above.
                        if not any(pattern.search(text) for _, pattern in PATTERNS['height']):
                            extra('Dimenzije oblikovane forme', format_size(m['size']), m.group(),
                                  'lorberg_shaped_photo_size_without_axis')
                    else:
                        add('height', m['size'], m.group(), 'lorberg_solitary_final_height', LORBERG_LEGEND)

    # Arbor's explicit STD and MULTISTEM grammar; special topiary dimensions
    # are not mislabelled as the whole plant's height.
    if nursery == 'arbor':
        for m in re.finditer(rf'(?<![\w])(?P<size>{measure})\s+(?:1/2\s+)?STD\b', text, FLAGS):
            if not re.fullmatch(r'1\s*/\s*2', m['size']):
                add('circumference', m['size'], m.group(), 'arbor_STD_girth_class')
        for m in re.finditer(r'\b1/2\s+STD\b', text, FLAGS):
            extra('Forma sadnice', 'Polustandard (1/2 STD)', m.group(), 'half_standard_form_not_girth')
        m = re.search(rf'\bMULTI[ -]*STEM\s+(?P<size>{measure})\s+(?=C\s*\d|RB\b|WRB\b|WOODBOX\b|AIRPOT\b)', text, FLAGS)
        if m and len(re.findall(range_only, text)) == 1:
            add('height', m['size'], m.group(), 'arbor_multistem_height_before_packaging')
        # BOTH measures in the feathered tree row are retained separately.
        for pattern in [
            rf'(?<![\w])(?P<girth>{range_only})\s+(?P<height>\d{{3,4}}\s*[-–—/]\s*\d{{3,4}}|\d{{3,4}}\s*\+)\s*FTH\b',
            rf'(?<![\w])(?P<girth>{range_only})\s+(?:STD\s+)?FTH\s*(?P<height>\d{{3,4}}\s*[-–—/]\s*\d{{3,4}}|\d{{3,4}}\s*\+)',
        ]:
            m = re.search(pattern, text, FLAGS)
            if m:
                add('circumference', m['girth'], m.group(), 'arbor_feathered_separate_girth')
                add('height', m['height'], m.group(), 'arbor_feathered_separate_height')
        # A single multistem range is a height even for short plants; the form
        # supplies that meaning, not the magnitude of the numeric range.
        for m in re.finditer(rf'\b(?:BALL|BOX|CONE|SPIRAL|PYRAMID|BEEHIVE|BONSAI|BONZAI|UMBRELLA|ROOF|PLEACHED|SCREEN)\b\s*(?P<size>{NUMBER}(?:\s*[-–—/xX×]\s*{NUMBER})*\s*\+?)', text, FLAGS):
            extra('Dimenzija oblikovane forme', format_size(m.group()), m.group(), 'arbor_topiary_dimension_preserved')

    if nursery == 'innocenti-mangoni':
        for m in re.finditer(rf'(?<![\w])(?P<size>{range_only})\s+A\.F\.(?![A-Za-z])', text, FLAGS):
            add('circumference', m['size'], m.group(), 'italian_alto_fusto_girth_before_AF')

    # Purely labelled measurements, stem heights, plant forms and additional
    # characteristics are kept separate from the seven standard parameters.
    for pattern in [rf'\b(?:STEM|Sth\.?|STH|stamhoogte)\s*(?P<size>{SIZE_RANGE})(?:\s*(?P<unit>cm|m))?',
                    rf'(?P<size>{SIZE_RANGE})\s*(?P<unit>cm|m)\s*(?:stem|stam)\b']:
        for m in re.finditer(pattern, text, FLAGS):
            extra('Visina čistog debla', format_size(m['size']) + (' ' + m['unit'] if m['unit'] else ''), m.group(), 'explicit_clear_stem_height')
    if re.search(r'\b(?:PLEACHED|ROOF|ARCH|SCREEN|BOX)\b', text, FLAGS):
        for m in re.finditer(r'(?<!\w)H\s*\d+(?:[.,]\d+)?(?:\s*[xX.]?\s*L\s*\d+(?:[.,]\d+)?)(?!\d)', text, FLAGS):
            extra('Dimenzije oblikovane krošnje', clean(m.group()), m.group(), 'explicit_topiary_H_L_dimensions')
    for m in re.finditer(r'(?<!\w)(?P<count>\d+)\s*ET\b', text, FLAGS):
        extra('Broj etaža', m['count'], m.group(), 'explicit_ET_count')
    for m in re.finditer(r'(?P<count>\d+(?:\s*[-–—/]\s*\d+)?)\s*(?:osnovna?\s+izbojk[ae]|grana|stems?)(?!\w)', text, FLAGS):
        extra('Broj grana / izbojaka', format_size(m['count']), m.group(), 'explicit_branches_count')
    form_patterns = [
        (r'\b(?:FTHD?|feathered(?:\s+to\s+the\s+bottom)?|razgranat\s+od\s+zemlje)\b', 'Razgranata od osnove'),
        (r'\b(?:SOL|solitaire|solitair|specimen)\b', 'Soliter'),
        (r'\b(?:STR|struik|BUSH)\b', 'Žbunasta forma'),
        (r'\b(?:Schirm|Naturschirm|UMBRELLA)(?:\s+(?:SHAPE|FORM))?\b', 'Kišobranasta forma'),
        (r'\b(?:PLEACHED|LEI)\b', 'Špalirna forma'),
        (r'\b(?:BALL|PALLA)\b', 'Kuglasta forma'),
        (r'\b(?:BONSAI|BONZAI)\b', 'Bonsai forma'),
        (r'\b(?:ROOF)\b', 'Krovna forma'),
        (r'\b(?:RAMIFICATO)\b', 'Razgranata forma'),
        (r'\b(?:whip)\b', 'Prutasta sadnica'),
    ]
    # Quoted cultivar names (White Ball, Gum Ball, Marie Ballard) are names,
    # not commercial forms. Read these form codes only in supplier grammar.
    code_text = re.sub(r"'[^']*'|\"[^\"]*\"", '', text)
    for pattern, label in form_patterns:
        m = re.search(pattern, code_text, FLAGS)
        if m and nursery == 'arbor' and label == 'Kuglasta forma' and m.group() != m.group().upper():
            continue  # e.g. the cultivar Gum Ball is not an uppercase BALL form.
        if m and (nursery != 'combinatie-mauritz' or label not in ('Kuglasta forma',)):
            extra('Forma sadnice', label + ' (' + m.group() + ')', m.group(), 'explicit_supplier_form')
    for m in re.finditer(r'(?<!\w)(?:Htot/Diam\.)\s*(?P<size>[^;]+)', text, FLAGS):
        # The combined Italian heading does not decide height versus diameter.
        extra('Visina / prečnik iz ponude', clean(m['size']), m.group(), 'combined_height_diameter_column')

    # Additional source codes are readable without inventing missing sizes.
    mapping = SUPPLIER_ROOT_CODES.get(nursery, {})
    for code, label in mapping.items():
        m = re.search(r'(?<![A-Za-z])' + re.escape(code) + r'(?![A-Za-z])', text, FLAGS)
        if m:
            candidate('rootType', label, m.group(), 'supplier_root_condition_code', code=code,
                      interpretationSource=LORBERG_LEGEND if nursery == 'lorberg' else CONTAINER_LEGEND if code == 'CG' else DUTCH_LEGEND)

    for m in re.finditer(r'(?<![\w])(?P<code>CS|P)\s*(?P<size>\d+(?:[.,]\d+)?)(?:\s*cm)?(?![\w])', text, FLAGS):
        raw = m['code'].upper() + m['size']
        candidate('potSize', raw, m.group(), 'explicit_pot_trade_code', unitStatus='not_stated')
        candidate('rootType', 'Kontejner', m.group(), 'explicit_pot_trade_code')


def extract_offer_parameters(offer):
    """Return deterministic, guarded changes; never mutate the supplied row."""
    if not isinstance(offer, dict):
        raise ValueError('Expected one offer object.')
    result = {'set': {}, 'evidence': {}, 'unresolved': [], 'additionalParameters': []}
    text = offered_text(offer)
    reviewed = reviewed_axis_record(offer)
    if reviewed:
        # These exact old fallback values may have come from a request column,
        # a form code, or a now-identified axis. Keep the source specification.
        if not reviewed.get('fields'):
            result['retireGenericDimensions'] = reviewed.get('retireGenericDimensions', [])
            result['retireParameters'] = reviewed.get('retireParameters', [])
            result['displayNoteCorrections'] = reviewed.get('displayNoteCorrections', {})
        result['additionalParameters'].extend(reviewed.get('additionalParameters', []))
    reason = guard_reason(offer, text)
    if reason:
        result['unresolved'].append({'reason': reason[0], 'message': reason[1]})
        return result
    source = source_reference(offer)
    candidates = {field: [] for field in FIELDS}
    claimed_spans = []
    # This archive's Trees/Suggested size column mixes bare tree-grade
    # numbers with height classes. A shrub genus or multistem word does not
    # establish that its unlabelled 25/30 is height.
    ambiguous_suggested_size = None
    if (source.get('sourceFile') == 'Kopie van Trees (002).xlsx' and
            source.get('sheet') == 'Trees'):
        ambiguous_suggested_size = re.search(
            r'\bSuggested size\s*:\s*(?P<size>\d{1,2}\s*[-–—/]\s*\d{1,2}(?:\s*cm)?)(?![\w.,])', text, FLAGS)

    def candidate(field, value, raw, rule, **details):
        if (field == 'height' and ambiguous_suggested_size and not rule.startswith('explicit_') and
                normalized_measure(value) == normalized_measure(ambiguous_suggested_size['size'])):
            return
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
    if offer.get('nurseryId') == 'arbor':
        # Literal stocklist example: ROOF20-25 STEM220C130L. A missing space
        # must not hide the independently labelled container or stem height.
        scan = re.sub(r'(\bSTEM\s*\d+(?:[.,]\d+)?)(?=C\d)', r'\1 ', scan, flags=FLAGS)
        scan = re.sub(r'\b(ROOF|PLEACHED|BALL|BOX|UMBRELLA)(?=\d)', r'\1 ', scan, flags=FLAGS)

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

    supplier_parameters(offer, scan, candidate, result['additionalParameters'], result['unresolved'])
    semantic_dimensions(offer, scan, candidate, candidates, result['additionalParameters'])

    if reviewed:
        # A reviewed source row can resolve an axis the general grammar could
        # not establish, including a documented earlier axis misassignment.
        # Other current values still produce a conflict instead of overwrite.
        for field, correction in reviewed.get('fields', {}).items():
            evidence = correction['evidence']
            candidates[field] = [{**evidence, 'value': correction['value'],
                                  'raw': evidence.get('raw', text), 'source': source,
                                  'unitStatus': evidence.get('unitStatus', 'stated' if re.search(
                                      r'\b(?:mm|cm|m)\b', correction['value'], FLAGS) else 'not_stated'),
                                  'reviewedExpectedValue': correction['expectedValue'],
                                  'sourceReview': 'archive-measurement-axes.json'}]

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
        # A source can give both pot volume and rim size (0.55L/P9cm).
        # An existing literal that contains both already records both values.
        if len(distinct) > 1 and field == 'potSize':
            current_size = normalized_measure(offer.get('potSize'))
            if current_size and all(normalized_measure(v['value']) in current_size for v in distinct.values()):
                result['evidence'][field] = {'value': offer['potSize'], 'raw': clean(offer['potSize']),
                                             'rule': 'compound_container_size_preserved',
                                             'operation': 'already_present', 'source': source}
                continue
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
        elif ('reviewedExpectedValue' in evidence and current == evidence['reviewedExpectedValue']
              and not parameter_equivalent(field, current, evidence['value'])):
            result['set'][field] = evidence['value']
            evidence = {**evidence, 'previousValue': current, 'operation': 'correct_reviewed_source_axis'}
        elif field == 'rootType' and root_equivalent(current, evidence['value']) and clean(current) != evidence['value']:
            normalized = evidence['value']
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

    if reviewed and reviewed.get('fields'):
        confirmed = all(parameter_equivalent(field, result['set'].get(field, offer.get(field)), correction['value'])
                        for field, correction in reviewed['fields'].items())
        if confirmed:
            result['retireGenericDimensions'] = reviewed.get('retireGenericDimensions', [])
            result['retireParameters'] = reviewed.get('retireParameters', [])
            result['displayNoteCorrections'] = reviewed.get('displayNoteCorrections', {})

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
        if code.upper() not in SUPPLIER_ROOT_CODES.get(offer.get('nurseryId'), {}):
            result['unresolved'].append({'field': 'rootType', 'reason': 'unexplained_supplier_code', 'raw': code,
                                         'message': 'Izvorni kod je sačuvan u glavnom panelu kao izvorna oznaka.'})
    # Coverage is measured against the original specification, not merely
    # against fields the former parser happened to populate. Never drop a
    # genuine unclassified source size behind a generic 'not stated' label.
    known_values = [normalized_measure(x.get('value')) for values in candidates.values() for x in values]
    known_values += [normalized_measure(offer.get(field)) for field in FIELDS if not is_blank(offer.get(field))]
    known_values += [normalized_measure(x['value']) for x in result['additionalParameters']]
    known_values += [normalized_measure(value) for value in result.get('retireGenericDimensions', [])]
    unclassified = []
    unclassified_pattern = rf'(?<![\w.])(?:{NUMBER}\s*[-–—/]\s*{NUMBER}(?:\s*[x×]\s*{NUMBER}\s*[-–—/]\s*{NUMBER})?(?:\s*\+)?(?:\s*(?:cm|mm|m))?|{NUMBER}\s*\+(?:\s*(?:cm|mm|m))?|{NUMBER}\s*(?:cm|mm|m))(?![\w])'
    for m in re.finditer(unclassified_pattern, scan, FLAGS):
        if re.fullmatch(r'1\s*/\s*2', m.group()) and re.match(r'\s*STD\b', scan[m.end():], FLAGS):
            continue  # 1/2 STD is a form, never an unclassified 1–2 size.
        value = normalized_measure(m.group())
        if any(value and value in known for known in known_values):
            continue
        if any(x.get('raw') == m.group() for x in result['unresolved']):
            continue
        raw = clean(m.group())
        if raw not in unclassified:
            unclassified.append(raw)
            result['unresolved'].append({'field': 'sourceSize', 'reason': 'unclassified_source_measure', 'raw': raw,
                                         'message': 'Veličina je prikazana u glavnom panelu kao izvorna mera; bez oznake nije preimenovana u visinu ili obim.'})
    if unclassified:
        result['additionalParameters'].append({'label': 'Dimenzija iz ponude',
                                               'value': ' · '.join(unclassified),
                                               'source': {**source, 'rule': 'preserve_unclassified_source_measure'}})
    assert set(result['set']) <= set(FIELDS)
    return result


def build_patch(document):
    updates, unresolved, counts = [], [], Counter()
    for offer in document['offers']:
        parsed = extract_offer_parameters(offer)
        counts['recordsExamined'] += 1
        if (parsed['set'] or parsed['additionalParameters'] or parsed.get('retireGenericDimensions')
                or parsed.get('retireParameters') or parsed.get('displayNoteCorrections')):
            updates.append({'id': offer['id'], 'expected': {'plantId': offer['plantId'], 'nurseryId': offer['nurseryId'],
                            **{k: offer.get(k, '') for k in parsed['set']}},
                            'set': parsed['set'], 'evidence': parsed['evidence'],
                            'additionalParameters': parsed['additionalParameters'],
                            **{key: parsed[key] for key in ('retireGenericDimensions', 'retireParameters',
                                                            'displayNoteCorrections') if parsed.get(key)}})
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
                      'Explicit labels and documented supplier/form/taxon size grammar are read.',
                      'A bare numeric range without verified source and semantic context never selects height or circumference.',
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

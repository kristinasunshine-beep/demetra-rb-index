"""Read exact plant/image bindings from Vannucci's public online catalogue.

The official website links this catalogue. Its public app reads the JSON
endpoints below. Prices and specifications are deliberately never returned.
"""
from __future__ import annotations
import json
import re
import threading
import weakref
import unicodedata
from urllib.parse import quote
from urllib.robotparser import RobotFileParser

from update_photos import PhotoError, check_url, fetch_resource, identity_matches, identity_forms

BASE = 'https://catalogue.vannuccipiante.it'
INDEX = BASE + '/data/species/plants-index.json'
PAGE_HOSTS = {'catalogue.vannuccipiante.it'}
IMAGE_HOSTS = PAGE_HOSTS
IMAGE_PREFIXES = {'catalogue.vannuccipiante.it': ['/images/']}
_CACHE = weakref.WeakKeyDictionary()
_LOCK = threading.Lock()


def search_url(name):
    return INDEX


def _robots(url, rules):
    if rules is not None:
        robot = RobotFileParser()
        robot.parse(rules.splitlines() if isinstance(rules, str) else rules)
        if not robot.can_fetch('DemetraPhotoBot', url):
            raise PhotoError('robots_disallowed', 'Vannucci catalogue path is disallowed by robots.txt.')


def _json(url, fetcher, rules, timeout):
    _robots(url, rules)
    response = fetcher(url, hosts=PAGE_HOSTS, max_bytes=4_000_000, timeout=timeout, kind='page')
    check_url(response.url, PAGE_HOSTS)
    # A redirect to a different product must never provide an identity proof.
    if response.url != url:
        raise PhotoError('page_identity_mismatch', 'Vannucci JSON redirected to a different resource.')
    try:
        return json.loads(response.body)
    except (ValueError, UnicodeError) as exc:
        raise PhotoError('invalid_json', 'Vannucci did not return catalogue JSON.') from exc


def _name(row, detail=False):
    fields = ('genreName', 'speciesName', 'speciesVariety') if detail else ('gen', 'n', 'v')
    if not isinstance(row, dict) or any(not isinstance(row.get(k, ''), str) for k in fields):
        return ''
    return ' '.join(row.get(k, '').strip() for k in fields if row.get(k, '').strip())


def _index(fetcher, rules, timeout):
    key = getattr(fetcher, '__self__', None) or fetcher
    with _LOCK:
        try:
            if key in _CACHE:
                return _CACHE[key]
        except TypeError:
            pass
        rows = _json(INDEX, fetcher, rules, timeout)
        if not isinstance(rows, list) or len(rows) > 50_000 or any(not isinstance(r, dict) for r in rows):
            raise PhotoError('invalid_json', 'Unexpected Vannucci plant index.')
        try:
            _CACHE[key] = rows
        except TypeError:
            pass
        return rows


def filename_supports_identity(filename, name):
    """Reject a named cultivar/composite hidden behind a generic JSON record.

    Vannucci's catalogue contains such records. A conservative filename check
    deliberately leaves uninformative filenames for manual source review.
    """
    def words(value):
        value = ''.join(c for c in unicodedata.normalize('NFKD', value).casefold()
                        if not unicodedata.combining(c))
        return re.findall(r'[a-z0-9]+', value)
    file_words = words(filename.rsplit('.', 1)[0])
    for form in identity_forms(name):
        expected = words(' '.join(x for x in form if x != 'x'))
        if file_words[:len(expected)] != expected:
            continue
        tail = file_words[len(expected):]
        if all(re.fullmatch(r'\d+|avx[0-9a-f]+|r\d+|clt\d*|t\d+|es|num|copia|copy', token)
               for token in tail):
            return True
    return False


def candidates(latin_name, *, fetcher=fetch_resource, robots_rules=None, timeout=20):
    _robots(INDEX, robots_rules)
    rows = _index(fetcher, robots_rules, timeout)
    matches = [r for r in rows if identity_matches(_name(r), latin_name)]
    result = []
    for row in matches[:3]:
        identifier = row.get('id')
        if type(identifier) is not int or not 0 < identifier < 1_000_000_000:
            continue
        detail_url = BASE + '/data/species/' + str(identifier) + '.json'
        detail = _json(detail_url, fetcher, robots_rules, timeout)
        if not isinstance(detail, dict) or detail.get('id') != identifier or not identity_matches(_name(detail, True), latin_name):
            raise PhotoError('plant_identity_mismatch', 'Vannucci detail identity differs from the exact requested plant.')
        images = detail.get('images', [])
        if not isinstance(images, list):
            continue
        for filename in images[:12]:
            if (not isinstance(filename, str) or not filename or len(filename) > 240 or
                    re.search(r'[/\\\x00-\x1f]|placeholder|logo|no.?image', filename, re.I) or
                    not re.search(r'\.(?:jpg|jpeg|png|webp)$', filename, re.I)):
                continue
            # Some catalogue rows reuse a species photograph for named cultivars.
            # Reject an image explicitly indexed under another full identity.
            if any(r.get('img') == filename and not identity_matches(_name(r), latin_name) for r in rows):
                continue
            if not filename_supports_identity(filename, _name(detail, True)):
                continue
            image_url = BASE + '/images/' + quote(filename, safe='')
            _robots(image_url, robots_rules)
            check_url(image_url, IMAGE_HOSTS, IMAGE_PREFIXES)
            result.append({'nurseryId': 'vannucci-piante', 'provider': 'nursery',
                'matchedName': latin_name, 'sourceUrl': detail_url, 'imageUrl': image_url,
                'resolver': 'vannucci_public_catalogue', 'identityEvidence': {
                    'kind': 'exact_public_catalogue_record', 'name': _name(detail, True),
                    'catalogueId': identifier, 'indexUrl': INDEX, 'detailUrl': detail_url,
                    'imageUrl': image_url}})
    return result

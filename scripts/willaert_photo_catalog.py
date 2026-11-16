#!/usr/bin/env python3
"""Exact photographs from Willaert's public plant guide, without login.

The guide's observed AJAX endpoint returns XML containing named plant cards.
Only a photograph paired with one exact full botanical name is returned.
"""
from __future__ import annotations
import re
import threading
import weakref
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

from update_photos import Document, PhotoError, check_url, fetch_resource, identity_matches
from volentis_photo_catalog import descendants

BASE = 'https://www.willaert.be'
GUIDE = BASE + '/nl/plantengids'
PAGE_HOSTS = {'www.willaert.be'}
IMAGE_HOSTS = PAGE_HOSTS
IMAGE_PREFIXES = {'www.willaert.be': ['/websites/1/uploads/image/PRODUCTIMAGES/']}
_FORMATTING_CACHE = weakref.WeakKeyDictionary()
_FORMATTING_LOCK = threading.Lock()


def search_url(name):
    return GUIDE + '?' + urlencode({'ajax': '1', 'action': 'getMorePlants', 'pageIndex': 0, 'search': name})


def _check_robots(url, rules):
    if rules is None:
        return
    parser = RobotFileParser()
    parser.parse(rules.splitlines() if isinstance(rules, str) else rules)
    if not parser.can_fetch('DemetraPhotoBot', url):
        raise PhotoError('robots_disallowed', 'Willaert plant guide is disallowed by robots.txt.')


def parse_cards(body, page_url, latin_name):
    check_url(page_url, PAGE_HOSTS)
    text = body.decode('utf-8', 'replace') if isinstance(body, bytes) else body
    if re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        raise PhotoError('unsafe_xml', 'External or expanding XML entities are not accepted.')
    try:
        tree = ET.fromstring(text)
    except ET.ParseError as exc:
        raise PhotoError('invalid_xml', 'Willaert plant search did not return its XML card format.') from exc
    if tree.tag != 'xmlresponse':
        raise PhotoError('invalid_xml', 'Unexpected Willaert search response.')
    document = Document(tree.findtext('plants', ''))
    results, seen = [], set()
    for card in document.nodes:
        if 'item' not in card.attrs.get('class', '').split():
            continue
        nodes = list(descendants(card))
        names = [n.text() for n in nodes if 'naam' in n.attrs.get('class', '').split()]
        if len(names) != 1 or not identity_matches(names[0], latin_name):
            continue
        href = card.attrs.get('href', '')
        if not href:
            continue
        detail = urljoin(page_url, href)
        try:
            check_url(detail, PAGE_HOSTS)
        except PhotoError:
            continue
        if not urlsplit(detail).path.startswith('/nl/plant/'):
            continue
        images = set()
        for node in nodes:
            if node.tag != 'img':
                continue
            image = urljoin(page_url, node.attrs.get('src', ''))
            try:
                check_url(image, IMAGE_HOSTS, IMAGE_PREFIXES)
            except PhotoError:
                continue
            if not re.search(r'placeholder|no[_-]?(?:photo|image)|default|logo', image, re.I):
                images.add(image)
        if len(images) != 1:
            continue
        image = images.pop()
        if (detail, image) in seen:
            continue
        seen.add((detail, image))
        results.append({'nurseryId': 'willaert', 'provider': 'nursery', 'matchedName': latin_name,
                        'sourceUrl': detail, 'imageUrl': image, 'resolver': 'willaert_catalog_card',
                        'identityEvidence': {'kind': 'exact_named_catalog_card', 'name': names[0],
                                             'pageUrl': page_url, 'detailUrl': detail, 'imageUrl': image}})
    return results


def parse_autocomplete(source):
    """Read literal strings only, never execute the nursery's JavaScript."""
    match = re.search(r'var\s+availableTags\s*=\s*\[(.*?)\];', source, re.S)
    if not match:
        return []
    literals = re.findall(r"'(?:\\.|[^'\\])*'", match.group(1))
    return list(dict.fromkeys(re.sub(r"\\(['\\])", r'\1', item[1:-1]) for item in literals))


def _autocomplete(fetcher, timeout, robots_rules):
    key = getattr(fetcher, '__self__', None) or fetcher
    with _FORMATTING_LOCK:
        try:
            if key in _FORMATTING_CACHE:
                return _FORMATTING_CACHE[key]
        except TypeError:
            pass
        _check_robots(GUIDE, robots_rules)
        response = fetcher(GUIDE, hosts=PAGE_HOSTS, max_bytes=3_000_000, timeout=timeout, kind='page')
        check_url(response.url, PAGE_HOSTS)
        names = parse_autocomplete(response.body.decode('utf-8', 'replace'))
        try:
            _FORMATTING_CACHE[key] = names
        except TypeError:
            pass
        return names


def candidates(latin_name, *, fetcher=fetch_resource, robots_rules=None, timeout=20,
               autocomplete_names=None):
    def search(name):
        url = search_url(name)
        _check_robots(url, robots_rules)
        response = fetcher(url, hosts=PAGE_HOSTS, max_bytes=3_000_000, timeout=timeout, kind='page')
        check_url(response.url, PAGE_HOSTS)
        return parse_cards(response.body, response.url, latin_name)
    rows = search(latin_name)
    if rows:
        return rows
    names = autocomplete_names if autocomplete_names is not None else _autocomplete(fetcher, timeout, robots_rules)
    # The source's search backend treats repeated spaces/apostrophes literally.
    # A formatting retry requires an observed name with identical full tokens.
    variants = [name for name in names if name != latin_name and identity_matches(name, latin_name)]
    for variant in variants[:2]:
        rows = search(variant)
        if rows:
            return rows
    return []

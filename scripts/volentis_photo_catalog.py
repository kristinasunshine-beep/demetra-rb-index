#!/usr/bin/env python3
"""Discover exact named photographs in the public Volentis offer catalogue.

This module only returns candidates; it never modifies plant data or downloads
images. Search card headings and photographs must belong to the same card.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from update_photos import Document, PhotoError, check_url, fetch_resource, identity_matches

PAGE_HOSTS = {'portal.volentis.com'}
IMAGE_HOSTS = {'cdn.volentis.com'}
IMAGE_PREFIXES = {'cdn.volentis.com': ['/d/']}
BASE = 'https://portal.volentis.com'
PLACEHOLDER = re.compile(r'placeholder|no[-_ ]?image|default|/logos?/', re.I)
BACKGROUND = re.compile(r'background-image\s*:\s*url\(\s*([\"\']?)(.*?)\1\s*\)', re.I)


def search_url(latin_name):
    return BASE + '/en/offers/1?' + urlencode({'SearchText': latin_name})


def descendants(node):
    stack = list(reversed(node.children))
    while stack:
        child = stack.pop()
        if isinstance(child, str):
            continue
        yield child
        stack.extend(reversed(child.children))


def parse_cards(source, page_url, latin_names):
    """Return only exact full-name matches with unique paired /d/ photographs."""
    check_url(page_url, PAGE_HOSTS)
    expected = [latin_names] if isinstance(latin_names, str) else list(latin_names)
    document = Document(source)
    result, seen = [], set()
    for card in document.nodes:
        if card.tag != 'figure' or 'card-product' not in card.attrs.get('class', '').split():
            continue
        nodes = list(descendants(card))
        names = [n.text() for n in nodes if 'title' in n.attrs.get('class', '').split()]
        if len(names) != 1 or not any(identity_matches(names[0], name) for name in expected):
            continue
        href = card.attrs.get('data-link', '')
        if not href:
            continue
        detail = urljoin(page_url, href)
        try:
            check_url(detail, PAGE_HOSTS)
        except PhotoError:
            continue
        if not urlsplit(detail).path.startswith('/en/offers/details/'):
            continue
        images = []
        for node in nodes:
            classes = node.attrs.get('class', '').split()
            if 'zoom-image' not in classes or 'default' in classes:
                continue
            for _, raw in BACKGROUND.findall(node.attrs.get('style', '')):
                image = urljoin(page_url, raw)
                try:
                    check_url(image, IMAGE_HOSTS, IMAGE_PREFIXES)
                except PhotoError:
                    continue
                if not PLACEHOLDER.search(image) and image not in images:
                    images.append(image)
        if len(images) != 1 or (detail, images[0]) in seen:
            continue
        seen.add((detail, images[0]))
        canonical = next(name for name in expected if identity_matches(names[0], name))
        result.append({'nurseryId': 'volentis', 'provider': 'nursery',
                       'matchedName': canonical, 'sourceUrl': detail,
                       'imageUrl': images[0], 'identityEvidence': {
                           'kind': 'exact_named_offer_card', 'name': names[0],
                           'pageUrl': page_url, 'detailUrl': detail,
                           'imageUrl': images[0]},
                       'resolver': 'volentis_offer_card'})
    return result


def candidates(latin_name, *, fetcher=fetch_resource, timeout=20, robots_rules=None):
    url = search_url(latin_name)
    if robots_rules is not None:
        robots = RobotFileParser()
        robots.parse(robots_rules.splitlines() if isinstance(robots_rules, str) else robots_rules)
        if not robots.can_fetch('DemetraPhotoBot', url):
            raise PhotoError('robots_disallowed', 'Public catalogue search is disallowed by robots.txt.')
    response = fetcher(url, hosts=PAGE_HOSTS, max_bytes=3_000_000,
                       timeout=timeout, kind='page')
    check_url(response.url, PAGE_HOSTS)
    if response.content_type not in ('text/html', 'application/xhtml+xml'):
        raise PhotoError('wrong_content_type', 'Volentis search did not return HTML.')
    return parse_cards(response.body.decode('utf-8', 'replace'), response.url, latin_name)


def discover(plants, *, fetcher=fetch_resource, max_seconds=900, request_budget=300,
             workers=2, cache_dir=None):
    """Bounded read-only first search page per plant, at most two in flight."""
    if not 1 <= workers <= 2 or not 1 <= request_budget <= 300 or not 1 <= max_seconds <= 900:
        raise ValueError('Invalid discovery limits')
    stop = threading.Event()
    lock = threading.Lock()
    deadline = time.monotonic() + max_seconds
    requests = 0
    cache_dir = Path(cache_dir) if cache_dir else None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
    def get(url, **kwargs):
        nonlocal requests
        with lock:
            if stop.is_set() or requests >= request_budget or time.monotonic() >= deadline:
                raise PhotoError('budget_exhausted', 'Discovery budget completed.')
            requests += 1
        time.sleep(0.2)
        kwargs['timeout'] = min(kwargs['timeout'], max(1, int(deadline-time.monotonic())))
        try:
            response = fetcher(url, **kwargs)
        except PhotoError as exc:
            if re.search(r'HTTP (?:403|429)', str(exc)):
                stop.set()
            raise
        if cache_dir:
            path = cache_dir / (hashlib.sha256(url.encode()).hexdigest()[:16] + '.html')
            path.write_bytes(response.body)
        return response
    def one(plant):
        row = {'plantId': plant.get('plantId', plant.get('id')), 'latinName': plant['latinName']}
        try:
            found = candidates(plant['latinName'], fetcher=get)
            row['candidates'] = [{**c, **row} for c in found]
            row['status'] = 'found' if found else 'no_exact_photograph'
        except PhotoError as exc:
            row['status'] = exc.code
            row['reason'] = str(exc)
            row['candidates'] = []
        return row
    with ThreadPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(one, plants))
    return {'checkedAt': datetime.now(timezone.utc).isoformat(), 'nurseryId': 'volentis',
            'requests': requests, 'plantsChecked': len(rows),
            'candidates': [c for row in rows for c in row['candidates']], 'results': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coverage', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--max-seconds', type=int, default=900)
    parser.add_argument('--request-budget', type=int, default=300)
    args = parser.parse_args()
    plants = json.loads(args.coverage.read_text(encoding='utf-8'))['plantsWithoutPhoto']
    report = discover(plants, max_seconds=args.max_seconds, request_budget=args.request_budget,
                      cache_dir=args.cache_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: report[k] for k in ('requests', 'plantsChecked')} |
                     {'candidatePlants': len({c['plantId'] for c in report['candidates']}),
                      'candidates': len(report['candidates'])}))


if __name__ == '__main__':
    main()

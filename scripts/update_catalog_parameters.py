#!/usr/bin/env python3
"""Enrich existing linked catalogue rows without changing sale measurements.

Innocenti: explicitly labelled mature dimensions, from existing product URLs.
Vannucci: distinct literal CLT codes from the already stored Measures section.
Python 3.11+ standard library only; no discovery, new plants or price updates.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

INNOCENTI = 'innocenti-mangoni'
VANNUCCI = 'vannucci-piante'
HOSTS = {
    INNOCENTI: {'innocentiemangonipiante.it', 'www.innocentiemangonipiante.it'},
    VANNUCCI: {'webshop.vannuccipiante.it'},
}
LABELS = {
    'max height': 'matureHeight',
    'maximum height': 'matureHeight',
    'max width': 'matureCrownWidth',
    'maximum width': 'matureCrownWidth',
    'spread': 'matureCrownWidth',
    'max spread': 'matureCrownWidth',
    'maximum spread': 'matureCrownWidth',
    'crown width': 'matureCrownWidth',
    'max crown width': 'matureCrownWidth',
}
MEASUREMENT_NOTE = (
    'Dostupne kataloške varijante; pune kombinacije mera navedene su u specifikaciji izvora.'
)
MAX_HTML_BYTES = 5_000_000
CACHE_MAX_AGE_SECONDS = 24 * 60 * 60
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class ParameterError(Exception):
    def __init__(self, code, detail):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def require(condition, code, detail):
    if not condition:
        raise ParameterError(code, detail)


def clean(value):
    return ' '.join(html.unescape(str(value)).split())


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def checked_url(value, nursery):
    require(isinstance(value, str) and len(value) < 2048, 'invalid_url', 'Expected an existing product URL.')
    url = urlsplit(value)
    require(url.scheme == 'https' and url.hostname in HOSTS[nursery], 'source_host', 'Product URL must belong to the linked nursery.')
    require(not url.username and not url.password and url.port in (None, 443), 'source_host', 'Credentials or alternate ports are not allowed.')
    require(not url.query and not url.fragment, 'source_url', 'Only the already linked product page is supported.')
    prefix = '/en/' if nursery == INNOCENTI else '/product/'
    tail = url.path.removeprefix(prefix).strip('/')
    require(url.path.startswith(prefix) and bool(tail) and '/' not in tail and '..' not in tail,
            'not_product_page', 'Expected a single existing product-page slug.')
    host = url.hostname.removeprefix('www.')
    return urlunsplit(('https', host, url.path.rstrip('/') + '/', '', ''))


class ProductRedirectHandler(HTTPRedirectHandler):
    max_redirections = 3

    def __init__(self, requested):
        super().__init__()
        self.requested = checked_url(requested, INNOCENTI)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(checked_url(newurl, INNOCENTI) == self.requested,
                'redirect_identity_changed', 'Redirect changed the linked product page; old data retained.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix='.' + path.name + '.', suffix='.tmp', delete=False) as out:
            name = out.name
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        name = None
    finally:
        if name:
            Path(name).unlink(missing_ok=True)


def fetch_page(url, cache_dir=None, timeout=20):
    canonical = checked_url(url, INNOCENTI)
    cache_path = Path(cache_dir) / (digest(url) + '.json') if cache_dir else None
    if cache_path and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding='utf-8'))
            fetched = datetime.fromisoformat(cached['fetchedAt'].replace('Z', '+00:00'))
            age = (datetime.now(timezone.utc) - fetched).total_seconds()
            if (cached.get('url') == url and checked_url(cached['finalUrl'], INNOCENTI) == canonical
                    and 0 <= age <= CACHE_MAX_AGE_SECONDS and isinstance(cached.get('html'), str)
                    and len(cached['html'].encode()) <= MAX_HTML_BYTES and digest(cached['html']) == cached.get('sha256')):
                return {**cached, 'cacheHit': True}
        except (ValueError, TypeError, KeyError, OSError, ParameterError):
            pass
    opener = build_opener(ProductRedirectHandler(url))
    request = Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; DemetraCatalogReader/1.0)',
        'Accept': 'text/html',
    })
    with opener.open(request, timeout=timeout) as response:
        require(response.status == 200, 'source_status', 'The product page did not return HTTP 200.')
        require(checked_url(response.geturl(), INNOCENTI) == canonical, 'source_identity', 'Final URL changed the product identity.')
        mime = response.headers.get_content_type()
        require(mime in ('text/html', 'application/xhtml+xml'), 'source_type', 'Expected a catalogue HTML page.')
        content = response.read(MAX_HTML_BYTES + 1)
        require(len(content) <= MAX_HTML_BYTES, 'source_too_large', 'Product page exceeds the configured size limit.')
        text = content.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
        record = {
            'schemaVersion': 1, 'url': url, 'finalUrl': response.geturl(),
            'fetchedAt': now_iso(), 'contentType': mime,
            'sha256': digest(text), 'html': text,
        }
    if cache_path:
        atomic_json(cache_path, record)
    # Four workers at most; no retry loop or catalogue discovery.
    time.sleep(0.15)
    return {**record, 'cacheHit': False}


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: 'Node | None' = field(default=None, repr=False)

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()

    def walk(self):
        stack = [self]
        while stack:
            node = stack.pop()
            yield node
            stack.extend(reversed([child for child in node.children if isinstance(child, Node)]))

    def text(self):
        out, stack = [], list(reversed(self.children))
        while stack:
            node = stack.pop()
            if isinstance(node, str):
                out.append(node)
            elif node.tag not in ('script', 'style', 'noscript'):
                stack.extend(reversed(node.children))
        return ''.join(out)


class Document(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root = Node('document')
        self.stack = [self.root]
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), parent=self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def number_text(value):
    try:
        number = Decimal(value.replace(',', '.'))
    except InvalidOperation as error:
        raise ParameterError('dimension_format', 'Invalid explicit dimension.') from error
    require(number.is_finite(), 'dimension_format', 'Non-finite dimension.')
    return format(number.normalize(), 'f'), number


def normalize_dimension(raw):
    text = clean(raw)
    number = r'\d{1,4}(?:[.,]\d{1,3})?'
    match = re.fullmatch(
        rf'({number})\s*(?:[-–—]\s*({number}))?\s*(m|meters?|metres?|cm|centimeters?|centimetres?|mm|millimeters?|millimetres?)',
        text, re.IGNORECASE,
    )
    require(match is not None, 'dimension_format', 'Only an explicitly stated number/range and length unit can be copied.')
    first, low = number_text(match[1])
    last, high = number_text(match[2]) if match[2] is not None else (first, low)
    require(0 <= low <= high and high > 0, 'dimension_range', 'Dimension range is empty, negative or reversed.')
    unit = match[3].lower()
    if unit.startswith('centi'):
        unit = 'cm'
    elif unit.startswith('milli'):
        unit = 'mm'
    elif unit not in ('cm', 'mm'):
        unit = 'm'
    return (first + '–' + last if match[2] is not None else first) + ' ' + unit


def innocenti_parameters(text, url):
    """Read only the labelled primary dimension row, never general page text."""
    expected = checked_url(url, INNOCENTI)
    document = Document(text)
    nodes = list(document.root.walk())
    headings = [clean(n.text()) for n in nodes if n.tag == 'h1' and clean(n.text())]
    require(len(set(headings)) == 1, 'product_heading', 'Expected one primary product heading.')
    canonicals = [n.attrs.get('href', '') for n in nodes if n.tag == 'link' and 'canonical' in n.attrs.get('rel', '').split()]
    if canonicals:
        require(len(set(canonicals)) == 1 and checked_url(canonicals[0], INNOCENTI) == expected,
                'canonical_identity_changed', 'The page canonical URL differs from the existing linked product.')
    values = {}
    for label in nodes:
        if label.tag not in ('h2', 'h3', 'h4', 'dt', 'th'):
            continue
        label_text = clean(label.text()).rstrip(':').lower()
        if label_text not in LABELS:
            continue
        field_name = LABELS[label_text]
        row = label.parent
        while row is not None:
            if row.tag == 'tr' or (row.has_class('uk-grid') and row.has_class('uk-grid-collapse') and row.has_class('uk-margin')):
                break
            row = row.parent
        require(row is not None, 'parameter_layout_changed', 'Explicit dimension label has no recognized catalogue row.')
        content_nodes = [n for n in row.walk() if n.has_class('el-content') and clean(n.text())]
        if row.tag == 'tr':
            content_nodes = [n for n in row.children if isinstance(n, Node) and n.tag == 'td' and clean(n.text())]
        require(len(content_nodes) == 1, 'parameter_layout_changed', 'Dimension value is absent or ambiguous in its own row.')
        raw = clean(content_nodes[0].text())
        value = normalize_dimension(raw)
        if field_name in values:
            require(values[field_name]['value'] == value, 'conflicting_dimension', 'The same explicit dimension has conflicting values.')
        values[field_name] = {'label': clean(label.text()), 'raw': raw, 'value': value}
    return {'heading': headings[0], 'fields': values}


def vannucci_container_codes(specification):
    """Return only distinct literal CLT codes; never interpret variant suffixes."""
    if not isinstance(specification, str):
        return None
    sections = re.findall(r'(?:^|;\s*)Measures\s*:\s*(.*?)(?=;\s*[A-Za-z][A-Za-z ]*\s*:|$)', specification, flags=re.IGNORECASE)
    if not sections:
        return None
    amounts = {}
    for section in sections:
        for raw in re.findall(r'\bCLT\.?\s*(\d+(?:[.,]\d+)?)', section, flags=re.IGNORECASE):
            display, number = number_text(raw)
            amounts[number] = display
    if not amounts:
        return None
    return {
        'value': 'CLT ' + ', '.join(amounts[n] for n in sorted(amounts)),
        'raw': '; '.join(section.strip() for section in sections),
        'label': 'Measures: CLT container codes',
    }


def update_document(document, *, nursery='all', limit=None, workers=4, cache_dir=None, timeout=20, fetcher=None, now=None, dry_run=False):
    require(isinstance(document, dict) and document.get('schemaVersion') == 1 and isinstance(document.get('offers'), list),
            'data_invalid', 'Expected an existing schemaVersion 1 catalogue.')
    if isinstance(document.get('sourcePolicy'), dict) and document['sourcePolicy'].get('nonPhoto') == 'rasadnici-ponude-zip':
        return copy.deepcopy(document), {
            'schemaVersion': 1, 'startedAt': now or now_iso(), 'dryRun': bool(dry_run),
            'status': 'disabled_by_source_policy', 'nursery': nursery,
            'reason': 'Svi nefoto podaci poticu iz Rasadnici ponude ZIP-a. Online dopuna mera je iskljucena.',
            'eligibleOffers': 0, 'productPages': 0, 'requests': 0, 'cacheHits': 0,
            'checked': 0, 'updated': 0, 'verifiedUnchanged': 0, 'failed': 0,
            'skipped': len(document['offers']), 'sourceFailures': 0,
            'matureHeightAddedOrChanged': 0, 'matureCrownWidthAddedOrChanged': 0,
            'potSizeAddedOrChanged': 0, 'potSizeOver100Characters': [],
            'sources': [], 'changes': [], 'dataChanged': False,
        }
    require(type(workers) is int and 1 <= workers <= 4, 'worker_limit', 'Use between one and four workers.')
    require(limit is None or type(limit) is int and limit > 0, 'limit_invalid', 'Limit must be a positive product-page count.')
    wanted = {INNOCENTI, VANNUCCI} if nursery == 'all' else {nursery}
    require(wanted <= {INNOCENTI, VANNUCCI}, 'nursery_invalid', 'Unsupported nursery.')
    rows = document['offers']
    require(all(isinstance(r, dict) and isinstance(r.get('id'), str) for r in rows), 'data_invalid', 'Every offer requires an ID.')
    require(len({r['id'] for r in rows}) == len(rows), 'data_invalid', 'Duplicate offer IDs prevent a safe update.')
    result = copy.deepcopy(document)
    by_id = {r['id']: r for r in result['offers']}
    now = now or now_iso()
    report = {
        'schemaVersion': 1, 'startedAt': now, 'dryRun': bool(dry_run), 'status': 'completed',
        'nursery': nursery, 'eligibleOffers': 0, 'productPages': 0,
        'requests': 0, 'cacheHits': 0, 'checked': 0, 'updated': 0,
        'verifiedUnchanged': 0, 'failed': 0, 'skipped': 0, 'sourceFailures': 0,
        'matureHeightAddedOrChanged': 0, 'matureCrownWidthAddedOrChanged': 0,
        'potSizeAddedOrChanged': 0, 'potSizeOver100Characters': [],
        'sources': [], 'changes': [],
    }
    groups = {}
    for row in rows:
        if row.get('recordStatus') in {'needs_review', 'superseded'}:
            report['skipped'] += 1
            continue
        if row.get('nurseryId') not in wanted:
            continue
        source_url = row.get('sourceUrl')
        if not source_url:
            report['skipped'] += 1
            continue
        try:
            checked_url(source_url, row['nurseryId'])
        except (ParameterError, ValueError):
            report['skipped'] += 1
            report['sources'].append({'offerId': row['id'], 'status': 'skipped', 'reason': 'not_supported_existing_product_url'})
            continue
        groups.setdefault((row['nurseryId'], source_url), []).append(row)
    selected = list(groups.items())
    if limit is not None:
        for _, unselected in selected[limit:]:
            report['skipped'] += len(unselected)
        selected = selected[:limit]
    report['eligibleOffers'] = sum(len(group) for _, group in selected)
    report['productPages'] = len(selected)
    page_results = {}
    innocenti_urls = [url for (nid, url), _ in selected if nid == INNOCENTI]
    fetch = fetcher or (lambda url: fetch_page(url, cache_dir, timeout))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {pool.submit(fetch, url): url for url in innocenti_urls}
        for future in as_completed(pending):
            url = pending[future]
            counted = False
            try:
                page = future.result()
                if isinstance(page, str):
                    page = {'html': page, 'fetchedAt': now, 'cacheHit': False, 'sha256': digest(page)}
                if page.get('cacheHit'):
                    report['cacheHits'] += 1
                else:
                    report['requests'] += 1
                counted = True
                parsed = innocenti_parameters(page['html'], url)
                page_results[url] = (page, parsed)
            except Exception as error:
                # A source error must preserve all prior fields of that source.
                if not counted:
                    report['requests'] += 1
                page_results[url] = error
                report['sourceFailures'] += 1
    for (nid, url), original_group in selected:
        source_report = {'nurseryId': nid, 'url': url, 'offerIds': [r['id'] for r in original_group]}
        source_result = page_results.get(url) if nid == INNOCENTI else None
        if isinstance(source_result, Exception):
            report['failed'] += len(original_group)
            source_report.update(status='failed', reason=getattr(source_result, 'code', type(source_result).__name__), previousDataPreserved=True)
            report['sources'].append(source_report)
            continue
        source_updates = 0
        for original in original_group:
            offer = by_id[original['id']]
            changes = {}
            raw_fields = {}
            method = 'existing_source_specification' if nid == VANNUCCI else 'explicit_mature_dimension_label'
            if nid == INNOCENTI:
                page, parsed = source_result
                for field_name, observed in parsed['fields'].items():
                    if offer.get(field_name) != observed['value']:
                        changes[field_name] = observed['value']
                        raw_fields[field_name] = observed
                no_fields = not parsed['fields']
            else:
                observed = vannucci_container_codes(offer.get('specification'))
                no_fields = observed is None
                if observed:
                    # Preserve an existing explicit sale-pot value. This fallback
                    # fills blanks, or refreshes a value previously made here.
                    prior = offer.get('parameterObservation')
                    generated = isinstance(prior, dict) and prior.get('method') == method and 'potSize' in prior.get('fields', {})
                    if (not offer.get('potSize') or generated) and offer.get('potSize') != observed['value']:
                        changes['potSize'] = observed['value']
                        raw_fields['potSize'] = observed
                        existing_note = offer.get('measurementNote') or ''
                        if MEASUREMENT_NOTE not in existing_note:
                            changes['measurementNote'] = (existing_note + ' ' + MEASUREMENT_NOTE).strip()
                    if len(observed['value']) > 100:
                        report['potSizeOver100Characters'].append({'offerId': offer['id'], 'length': len(observed['value']), 'value': observed['value']})
            if no_fields:
                report['skipped'] += 1
                continue
            report['checked'] += 1
            if not changes:
                report['verifiedUnchanged'] += 1
                continue
            previous_observation = offer.get('parameterObservation')
            observation = copy.deepcopy(previous_observation) if isinstance(previous_observation, dict) else {}
            observation.update(sourceUrl=url, method=method, recordedAt=now)
            if nid == INNOCENTI:
                observation.update(observedAt=page['fetchedAt'], contentSha256=page.get('sha256'), productHeading=parsed['heading'])
            observation['fields'] = {**(observation.get('fields') if isinstance(observation.get('fields'), dict) else {}), **raw_fields}
            changes['parameterObservation'] = observation
            report['changes'].append({'offerId': offer['id'], 'nurseryId': nid, 'sourceUrl': url, 'set': copy.deepcopy(changes)})
            offer.update(changes)
            source_updates += 1
            report['updated'] += 1
            for field_name in ('matureHeight', 'matureCrownWidth', 'potSize'):
                if field_name in changes:
                    report[field_name + 'AddedOrChanged'] += 1
        source_report.update(status='updated' if source_updates else 'unchanged_or_not_stated', updatedOffers=source_updates)
        report['sources'].append(source_report)
    if report['updated']:
        result['updatedAt'] = now
    if report['failed']:
        report['status'] = 'partial_failure' if report['checked'] else 'failed'
    report['dataChanged'] = result != document
    return result, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', default='data/kataloske-stavke.json')
    parser.add_argument('--report', default='reports/catalog-parameters.json')
    parser.add_argument('--dry-run', action='store_true', help='Write a proposed-change report only; preserve catalogue bytes.')
    parser.add_argument('--nursery', choices=['all', INNOCENTI, VANNUCCI], default='all')
    parser.add_argument('--limit', type=int, help='Process at most this many already linked product-page groups, in catalogue order.')
    parser.add_argument('--workers', type=int, default=4, help='One to four concurrent Innocenti requests (default: four).')
    parser.add_argument('--timeout', type=int, default=20, help='Per-request timeout in seconds, 5–60.')
    parser.add_argument('--cache-dir', type=Path, help='Optional URL-bound HTML cache, reused for up to 24 hours.')
    args = parser.parse_args(argv)
    written = False
    try:
        require(5 <= args.timeout <= 60, 'timeout_invalid', 'Timeout must be between 5 and 60 seconds.')
        data_path, report_path = Path(args.data), Path(args.report)
        require(data_path.resolve() != report_path.resolve(), 'paths_invalid', 'Report and catalogue paths must differ.')
        original_bytes = data_path.read_bytes()
        document = json.loads(original_bytes)
        result, report = update_document(document, nursery=args.nursery, limit=args.limit,
                                         workers=args.workers, cache_dir=args.cache_dir,
                                         timeout=args.timeout, dry_run=args.dry_run)
        if report['dataChanged'] and not args.dry_run:
            require(data_path.read_bytes() == original_bytes, 'concurrent_catalogue_change', 'Catalogue changed during fetching; no updates written. Rerun against the latest data.')
            atomic_json(data_path, result)
            written = True
        report['catalogueWritten'] = written
        atomic_json(report_path, report)
        print(json.dumps({k: v for k, v in report.items() if k not in ('sources', 'changes', 'potSizeOver100Characters')}, ensure_ascii=False))
        return 0
    except (ParameterError, OSError, ValueError, TypeError, KeyError) as error:
        report = {'schemaVersion': 1, 'startedAt': now_iso(), 'status': 'configuration_or_data_error',
                  'dryRun': args.dry_run, 'catalogueWritten': written,
                  'reason': getattr(error, 'code', type(error).__name__),
                  'detail': getattr(error, 'detail', str(error))}
        if Path(args.report).resolve() != Path(args.data).resolve():
            atomic_json(args.report, report)
        print(json.dumps(report, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Find exact plant photographs on verified nursery sites, with a resumable queue.

Discovery reads robots/sitemaps and links actually returned by those sites.
It never edits catalogue data, invents product URLs, searches by genus alone,
or substitutes another nursery/cultivar. Downloading images is a separate step.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

from update_photos import (Document, PhotoError, atomic_write, check_url,
                           fetch_resource, identity_forms, resolve_product_image)

USER_AGENT = 'DemetraCataloguePhotos/1.0'
INACTIVE = {'needs_review', 'superseded'}
PRIORITY = ['lorberg', 'innocenti-mangoni', 'vannucci-piante', 'willaert',
            'combinatie-mauritz', 'arbor', 'vivai-reali']
STATE_PATH = 'docs/photo-discovery-state.json'
DEFAULTS = {'timeout': 20, 'maxBytes': 3_000_000, 'maxSitemapBytes': 20_000_000, 'maxUrlsPerNursery': 40000,
            'maxCandidatesPerPair': 3, 'retryDays': 7, 'refreshIndexDays': 30,
            'maxResourcesPerNurseryPerRun': 8}


def read(path, default=None):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else copy.deepcopy(default)


def stamp(now=None):
    if now:
        return now
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def due(value, now, days):
    if not value:
        return True
    try:
        old = datetime.fromisoformat(value.replace('Z', '+00:00'))
        current = datetime.fromisoformat(now.replace('Z', '+00:00'))
        return current - old >= timedelta(days=days)
    except (ValueError, TypeError):
        return True


def normalize_url(value):
    p = urlsplit(value)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or '/', p.query, ''))


def names_for(plant):
    """Accept full botanical aliases only; never 'Pacific Sunset' by itself."""
    name = plant['latinName'].strip()
    genus = re.match(r'^[A-Z][a-z]+', name)
    if not genus:
        return []
    genus = genus.group()
    values = [name]
    for alias in [*plant.get('synonyms', []), *plant.get('searchAliases', [])]:
        if isinstance(alias, str) and re.match(r'^' + re.escape(genus) + r'\s+', alias):
            values.append(alias)
    unique = []
    for value in values:
        tokens = next(iter(identity_forms(value)))
        if len(tokens) >= 2 and tokens[1] not in {'sp', 'spp'} and value not in unique:
            unique.append(value)
    return unique


def candidate_rank(url, names):
    """URL ranking chooses candidates only. The page must still prove identity."""
    path = unquote(urlsplit(url).path).casefold()
    tail = path.rstrip('/').rsplit('/', 1)[-1]
    tokens = tuple(re.findall(r'[^\W_]+', tail, flags=re.UNICODE))
    best = 0
    for name in names:
        for form in identity_forms(name):
            if tokens == form:
                best = max(best, 100)
            elif len(tokens) >= len(form) and any(tokens[i:i + len(form)] == form
                                                for i in range(len(tokens) - len(form) + 1)):
                best = max(best, 60)
    if best and re.search(r'/(?:en|en-gb)/', path):
        best += 5
    return best


def build_policies(nurseries, photo_config, discovery_config):
    existing = {x['nurseryId']: x for x in photo_config.get('sources', [])}
    overrides = {x['nurseryId']: x for x in discovery_config.get('sources', [])}
    result = {}
    for nursery in nurseries:
        website = nursery.get('website', '')
        parsed = urlsplit(website)
        if parsed.scheme != 'https' or not parsed.hostname or nursery.get('verificationStatus') not in {
                'verified', 'verified_in_archive'}:
            continue
        old, extra = existing.get(nursery['id'], {}), overrides.get(nursery['id'], {})
        page_hosts = set(old.get('pageHosts', [])) | {parsed.hostname} | set(extra.get('pageHosts', []))
        # www and bare names are not accepted automatically; actual configured
        # nursery roots or a reviewed override must authorize each redirect.
        image_hosts = set(old.get('imageHosts', [])) | {parsed.hostname} | set(extra.get('imageHosts', []))
        policy = {'nurseryId': nursery['id'], 'resolver': 'product', 'fillMissing': True,
                  'pageHosts': sorted(page_hosts), 'imageHosts': sorted(image_hosts),
                  'pagePathPattern': r'/.*', 'website': website}
        if old.get('imagePathPrefixes') or extra.get('imagePathPrefixes'):
            policy['imagePathPrefixes'] = {**old.get('imagePathPrefixes', {}), **extra.get('imagePathPrefixes', {})}
        policy['seedSitemaps'] = extra.get('sitemaps', [])
        result[nursery['id']] = policy
    return result


def allowed(url, hosts):
    try:
        check_url(url, hosts)
        return True
    except (PhotoError, ValueError):
        return False


def is_sitemap(url):
    return bool(re.search(r'(?:sitemap[^/?]*|\.xml(?:\.gz)?)(?:\?|$)', urlsplit(url).path, re.I))


def resource_rank(url):
    path = urlsplit(url).path.casefold()
    if re.search(r'posts-product|product-sitemap|products?-sitemap|sitemap-products?', path):
        return 0
    if re.search(r'taxonom|categor|author|tags?', path):
        return 3
    return 1


def page_links(source, base, hosts):
    doc = Document(source)
    links = []
    for node in doc.nodes:
        if node.tag not in {'a', 'link'}:
            continue
        href = node.attrs.get('href')
        if not href:
            continue
        url = normalize_url(urljoin(base, href))
        if allowed(url, hosts) and url not in links and not re.search(r'\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|pdf|zip)(?:$|\?)', url, re.I):
            links.append(url)
    return links


def sitemap_links(body, base, hosts, max_urls):
    if body.startswith(b'\x1f\x8b'):
        # Bound compressed and uncompressed forms, not only Content-Length.
        import io
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
            body = stream.read(12_000_001)
        if len(body) > 12_000_000:
            raise PhotoError('sitemap_too_large', 'Expanded sitemap exceeds its limit.')
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', body, re.I):
        raise PhotoError('unsafe_xml', 'Sitemap entity declarations are not accepted.')
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise PhotoError('invalid_sitemap', 'Sitemap is not valid XML.') from exc
    kind = root.tag.rsplit('}', 1)[-1].lower()
    if kind not in {'sitemapindex', 'urlset'}:
        raise PhotoError('invalid_sitemap', 'XML is not a sitemap index or URL list.')
    urls, seen = [], set()
    for child in root:
        # Only direct <loc> children: image:loc is not a product-page URL.
        for value in child:
            if value.tag.rsplit('}', 1)[-1] != 'loc' or not value.text:
                continue
            url = normalize_url(urljoin(base, value.text.strip()))
            if allowed(url, hosts) and url not in seen:
                urls.append(url)
                seen.add(url)
            if len(urls) >= max_urls:
                break
        if len(urls) >= max_urls:
            break
    return kind, urls


def blocked_html(source):
    doc = Document(source)
    headings = ' '.join(n.text() for n in doc.nodes if n.tag in {'title', 'h1'})
    return bool(re.search(r'verify (?:that )?you are human|checking your browser|just a moment|'
                          r'automated (?:traffic|queries)|unusual traffic|access denied', headings, re.I))


class BudgetReached(Exception):
    pass


def discover(root, *, budget=120, fetcher=fetch_resource, now=None, dry_run=False, max_seconds=480):
    root = Path(root).resolve()
    if type(budget) is not int or not 1 <= budget <= 2000:
        raise ValueError('budget must be an integer between 1 and 2000')
    if type(max_seconds) is not int or not 1 <= max_seconds <= 1800:
        raise ValueError('max_seconds must be between 1 and 1800')
    deadline = time.monotonic() + max_seconds
    now = stamp(now)
    config = read(root / 'scripts/photo-discovery.json', {'schemaVersion': 1, 'sources': []})
    limits = {**DEFAULTS, **config.get('limits', {})}
    plants = {x['id']: x for x in read(root / 'data/biljke.json')['plants']}
    nurseries = read(root / 'data/rasadnici.json')['nurseries']
    offers = read(root / 'data/kataloske-stavke.json')['offers']
    policies = build_policies(nurseries, read(root / 'scripts/photo-sources.json'), config)
    state = read(root / STATE_PATH, {'schemaVersion': 1, 'nurseries': {}, 'pairs': {}})
    if state.get('schemaVersion') != 1 or not isinstance(state.get('nurseries'), dict) or not isinstance(state.get('pairs'), dict):
        raise ValueError('Invalid discovery state')
    initial_state = copy.deepcopy(state)
    pairs = {}
    for offer in offers:
        if offer.get('recordStatus') in INACTIVE or offer.get('image'):
            continue
        key = offer['nurseryId'] + '::' + offer['plantId']
        pairs.setdefault(key, {'plantId': offer['plantId'], 'nurseryId': offer['nurseryId'], 'offerIds': []})['offerIds'].append(offer['id'])
    report = {'status': 'completed', 'startedAt': now, 'requests': 0, 'budget': budget,
              'bindings': [], 'pending': [], 'errors': [], 'missingPairs': len(pairs),
              'statePath': STATE_PATH, 'dryRun': bool(dry_run)}
    used = {}
    stopped_hosts = set()
    response_cache = {}

    def get(url, policy):
        check_url(url, policy['pageHosts'])
        host = urlsplit(url).hostname
        if host in stopped_hosts:
            raise PhotoError('host_blocked_for_run', 'This site has already blocked this run.')
        if url in response_cache:
            return response_cache[url]
        if report['requests'] >= budget or time.monotonic() >= deadline:
            raise BudgetReached()
        report['requests'] += 1
        max_bytes = limits['maxSitemapBytes'] if is_sitemap(url) else limits['maxBytes']
        result = fetcher(url, hosts=policy['pageHosts'], max_bytes=max_bytes,
                         timeout=min(limits['timeout'], max(1, int(deadline-time.monotonic()))), kind='page')
        check_url(result.url, policy['pageHosts'])
        if len(result.body) > max_bytes:
            raise PhotoError('response_too_large', 'Discovery response exceeds byte budget.')
        if result.content_type in {'text/html', 'application/xhtml+xml'} and blocked_html(result.body.decode('utf-8', 'replace')):
            stopped_hosts.add(host)
            raise PhotoError('site_blocked', 'Site asks this client for human verification or denies access.')
        response_cache[url] = result
        return result

    nursery_ids = sorted({p['nurseryId'] for p in pairs.values()},
                         key=lambda n: (PRIORITY.index(n) if n in PRIORITY else len(PRIORITY), n))
    for nursery_id in nursery_ids:
        policy = policies.get(nursery_id)
        if not policy:
            continue
        ns = state['nurseries'].setdefault(nursery_id, {'frontier': [], 'visited': [], 'pages': [], 'robots': {}})
        ns.setdefault('failedResources', {})
        ns.setdefault('blockedHosts', {})
        for host, checked in ns['blockedHosts'].items():
            if not due(checked, now, limits['retryDays']):
                stopped_hosts.add(host)
        for url, failure in ns['failedResources'].items():
            if due(failure.get('at'), now, limits['retryDays']):
                if url not in ns['frontier']:
                    ns['frontier'].append(url)
                if url in ns['visited']:
                    ns['visited'].remove(url)
        if not ns.get('indexedAt') or due(ns.get('indexedAt'), now, limits['refreshIndexDays']):
            # Standard discovery endpoints, not guessed plant URLs. A robots
            # sitemap or homepage link is preferred as soon as it is observed.
            homes = list(dict.fromkeys(['https://' + host + '/' for host in policy['pageHosts']] + [policy['website']]))
            seeds = ['https://' + urlsplit(home).netloc + '/robots.txt' for home in homes]
            seeds += policy.get('seedSitemaps', []) + homes
            ns['frontier'] = list(dict.fromkeys(seeds + ns['frontier']))
            ns['visited'] = []
            ns['indexedAt'] = now
        used[nursery_id] = 0

    # Round-robin resources prevent one large sitemap from starving every
    # other supplier. URL lists remain cached for future plants and later runs.
    crawl_budget = max(1, budget // 2)
    while report['requests'] < crawl_budget and time.monotonic() < deadline:
        progressed = False
        for nursery_id in nursery_ids:
            if report['requests'] >= crawl_budget:
                break
            policy = policies.get(nursery_id)
            if not policy:
                continue
            ns = state['nurseries'][nursery_id]
            if not ns['frontier'] or used[nursery_id] >= limits['maxResourcesPerNurseryPerRun']:
                continue
            url = ns['frontier'].pop(0)
            if url in ns['visited']:
                continue
            host, path = urlsplit(url).hostname, urlsplit(url).path
            if host in stopped_hosts:
                ns['frontier'].insert(0, url)
                continue
            rules = ns['robots'].get(host)
            if rules and path != '/robots.txt':
                robots = RobotFileParser(); robots.parse(rules)
                if not robots.can_fetch(USER_AGENT, url):
                    ns['visited'].append(url)
                    report['errors'].append({'nurseryId': nursery_id, 'url': url, 'reason': 'robots_disallowed'})
                    continue
            progressed = True
            used[nursery_id] += 1
            try:
                result = get(url, policy)
                ns['visited'].append(url)
                ns['failedResources'].pop(url, None)
                raw = result.body.decode('utf-8', 'replace')
                resources, pages = [], []
                if path == '/robots.txt':
                    ns['robots'][host] = raw.splitlines()
                    resources = [line.split(':', 1)[1].strip() for line in raw.splitlines()
                                 if line.lower().startswith('sitemap:')]
                    if not resources:
                        resources = ['https://' + host + '/sitemap.xml']
                elif is_sitemap(result.url) or result.content_type in {'application/xml', 'text/xml', 'application/gzip'}:
                    kind, urls = sitemap_links(result.body, result.url, policy['pageHosts'], limits['maxUrlsPerNursery'])
                    if kind == 'sitemapindex':
                        resources = urls
                    else:
                        pages = urls
                elif result.content_type in {'text/html', 'application/xhtml+xml'}:
                    links = page_links(raw, result.url, policy['pageHosts'])
                    resources = [x for x in links if is_sitemap(x)]
                    pages = [x for x in links if not is_sitemap(x)]
                new_resources = []
                for link in resources:
                    if not allowed(link, policy['pageHosts']):
                        report['errors'].append({'nurseryId': nursery_id, 'url': link,
                                                 'reason': 'unreviewed_sitemap_host', 'discoveredAt': result.url})
                    elif link not in ns['frontier'] and link not in ns['visited']:
                        new_resources.append(normalize_url(link))
                # Read plant/product URL lists before category and author lists.
                ns['frontier'] = sorted(set(new_resources), key=lambda x: (resource_rank(x), x)) + ns['frontier']
                known = set(ns['pages'])
                for link in pages:
                    if link not in known and len(ns['pages']) < limits['maxUrlsPerNursery']:
                        ns['pages'].append(link); known.add(link)
                ns['lastCheckedAt'] = now
            except BudgetReached:
                ns['frontier'].insert(0, url)
                break
            except (PhotoError, OSError, ValueError) as exc:
                ns['visited'].append(url)
                ns['lastError'] = {'url': url, 'reason': getattr(exc, 'code', 'fetch_error'), 'at': now}
                ns['failedResources'][url] = ns['lastError']
                if ns['lastError']['reason'] in {'site_blocked', 'host_blocked_for_run'}:
                    ns['blockedHosts'][host] = now
                report['errors'].append({'nurseryId': nursery_id, **ns['lastError']})
                # A missing robots endpoint still allows a single standard
                # sitemap probe. Authentication/bot failures are not bypassed.
                if path == '/robots.txt' and '404' in str(exc):
                    sitemap = 'https://' + host + '/sitemap.xml'
                    if sitemap not in ns['frontier'] and sitemap not in ns['visited']:
                        ns['frontier'].insert(0, sitemap)
        if not progressed:
            break

    # Index URL candidates by approved genus once; avoid rescanning a large
    # 40,000-URL sitemap for every single plant on each run.
    genus_urls = {}
    for nursery_id in nursery_ids:
        if nursery_id not in state['nurseries']:
            continue
        genera = {next(iter(identity_forms(plants[p['plantId']]['latinName'])))[0]
                  for p in pairs.values() if p['nurseryId'] == nursery_id and names_for(plants[p['plantId']])}
        index = {g: [] for g in genera}
        for url in state['nurseries'][nursery_id]['pages']:
            tail = unquote(urlsplit(url).path).rstrip('/').rsplit('/', 1)[-1]
            tokens = set(re.findall(r'[^\W_]+', tail.casefold(), flags=re.UNICODE))
            for genus in genera & tokens:
                index[genus].append(url)
        genus_urls[nursery_id] = index
    order = sorted(pairs, key=lambda k: (bool(state['pairs'].get(k, {}).get('checkedAt')),
                                        state['pairs'].get(k, {}).get('checkedAt', ''),
                                        nursery_ids.index(pairs[k]['nurseryId']), k))
    for key in order:
        pair = pairs[key]
        policy = policies.get(pair['nurseryId'])
        if not policy:
            report['pending'].append({**pair, 'reason': 'nursery_identity_or_website_unverified'})
            continue
        ns = state['nurseries'][pair['nurseryId']]
        record = state['pairs'].get(key, {})
        if record.get('binding'):
            binding = record['binding']
            try:
                check_url(binding['pageUrl'], policy['pageHosts'])
                check_url(binding['imageUrl'], policy['imageHosts'], policy.get('imagePathPrefixes'))
                same_identity = binding.get('canonicalName') == plants[pair['plantId']]['latinName']
            except (PhotoError, ValueError):
                same_identity = False
            if same_identity and not due(record.get('checkedAt') or binding.get('verifiedAt'), now, limits['retryDays']):
                fresh_policy = {k: copy.deepcopy(v) for k, v in policy.items() if k not in {'website', 'seedSitemaps'}}
                fresh_policy['pagePathPattern'] = re.escape(urlsplit(binding['pageUrl']).path)
                report['bindings'].append({**binding, 'offerIds': pair['offerIds'], 'policy': fresh_policy})
                continue
        names = names_for(plants[pair['plantId']])
        if not names:
            report['pending'].append({**pair, 'reason': 'full_botanical_identity_required'})
            continue
        genus = next(iter(identity_forms(names[0])))[0]
        candidates = [(candidate_rank(url, names), url) for url in genus_urls.get(pair['nurseryId'], {}).get(genus, [])]
        candidates = [url for score, url in sorted(candidates, key=lambda x: (-x[0], x[1])) if score]
        candidates = candidates[:limits['maxCandidatesPerPair']]
        fingerprint = hashlib.sha256('\n'.join(candidates).encode()).hexdigest()
        if record.get('candidateFingerprint') == fingerprint and not due(record.get('checkedAt'), now, limits['retryDays']):
            report['pending'].append({**pair, 'reason': record.get('reason', 'waiting_for_retry'),
                                      'checkedAt': record.get('checkedAt')})
            continue
        if not candidates:
            reason = 'index_incomplete' if ns['frontier'] else 'exact_product_page_not_found'
            report['pending'].append({**pair, 'reason': reason})
            continue
        if report['requests'] >= budget or time.monotonic() >= deadline:
            report['pending'].append({**pair, 'reason': 'request_budget_remaining_work'})
            continue
        found = None
        failures = []
        complete = True
        for url in candidates:
            robots = RobotFileParser(); robots.parse(ns['robots'].get(urlsplit(url).hostname, []))
            if ns['robots'].get(urlsplit(url).hostname) and not robots.can_fetch(USER_AGENT, url):
                failures.append({'url': url, 'reason': 'robots_disallowed'})
                continue
            try:
                response = get(url, policy)
                if response.content_type not in {'text/html', 'application/xhtml+xml'}:
                    raise PhotoError('invalid_page', 'Candidate is not an HTML product page.')
                text = response.body.decode('utf-8', 'replace')
                errors = []
                for name in names:
                    try:
                        image_url, method = resolve_product_image(text, response.url, name, policy)
                        bound_policy = {k: copy.deepcopy(v) for k, v in policy.items() if k not in {'website', 'seedSitemaps'}}
                        bound_policy['pagePathPattern'] = re.escape(urlsplit(response.url).path)
                        found = {**pair, 'pageUrl': response.url, 'imageUrl': image_url,
                                 'matchedName': name, 'canonicalName': plants[pair['plantId']]['latinName'],
                                 'policy': bound_policy, 'verifiedAt': now,
                                 'evidence': {'method': method, 'discoveredUrl': url,
                                              'discovery': 'nursery_sitemap_or_observed_link',
                                              'identity': 'exact_full_botanical_name'}}
                        break
                    except PhotoError as exc:
                        errors.append(exc)
                if found:
                    break
                raise errors[-1]
            except BudgetReached:
                complete = False
                break
            except (PhotoError, OSError, ValueError) as exc:
                if getattr(exc, 'code', '') in {'site_blocked', 'host_blocked_for_run'}:
                    ns['blockedHosts'][urlsplit(url).hostname] = now
                failures.append({'url': url, 'reason': getattr(exc, 'code', 'fetch_error')})
        if found:
            report['bindings'].append(found)
            state['pairs'][key] = {'binding': found, 'checkedAt': now, 'candidateFingerprint': fingerprint}
        else:
            reason = 'candidate_not_confirmed' if complete else 'request_budget_remaining_work'
            report['pending'].append({**pair, 'reason': reason, 'candidates': failures})
            if complete:
                state['pairs'][key] = {'checkedAt': now, 'reason': reason,
                                       'candidateFingerprint': fingerprint, 'failures': failures}
    report['timeBudgetReached'] = time.monotonic() >= deadline
    if (report['requests'] >= budget or report['timeBudgetReached']) and report['pending']:
        report['status'] = 'partial_budget'
    elif report['errors']:
        report['status'] = 'partial_failure'
    elif report['pending']:
        report['status'] = 'incomplete_sources'
    report['confirmedPairs'] = len(report['bindings'])
    report['pendingPairs'] = len(report['pending'])
    report['coverageComplete'] = not report['pending']
    report['indexedPages'] = sum(len(x.get('pages', [])) for x in state['nurseries'].values())
    report['queuedResources'] = sum(len(x.get('frontier', [])) for x in state['nurseries'].values())
    if state != initial_state:
        state['updatedAt'] = now
        if not dry_run:
            atomic_write(root / STATE_PATH, (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode())
    report['stateChanged'] = state != initial_state
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--budget', type=int, default=120)
    parser.add_argument('--max-seconds', type=int, default=480)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    report = discover(args.root, budget=args.budget, dry_run=args.dry_run, max_seconds=args.max_seconds)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in {'bindings', 'pending', 'errors'}}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Find attributed reference photographs, distinct from nursery photographs.

Wikidata P225/P18 or direct membership of an exact Commons taxon category
provides the identity evidence. A species photograph may illustrate a named
cultivar only with matchLevel=species_reference; a genus-only name is never
silently converted to an arbitrary species. All other catalogue data is fixed.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import time
import unicodedata
from urllib.parse import urlencode, urlsplit

from update_photos import (PhotoError, DEFAULT_LIMITS, fetch_resource, to_jpeg,
                           local_image, commit_files, index_rows, require)

API_HOSTS = ('www.wikidata.org', 'commons.wikimedia.org')
IMAGE_HOSTS = ('upload.wikimedia.org',)
WD = 'https://www.wikidata.org/w/api.php'
COMMONS = 'https://commons.wikimedia.org/w/api.php'
STATE_PATH = 'docs/reference-photo-state.json'
PHOTO_KEYS = {'image', 'sourceUrl', 'imageUrl', 'taxon', 'matchLevel', 'origin',
              'author', 'license', 'licenseUrl', 'checkedAt', 'status', 'sha256',
              'identityEvidence'}
NOT_PHOTO = re.compile(r'\b(?:illustration|drawing|drawings|diagram|diagrams|map|maps|'
                       r'herbarium|herbar|painting|paintings|engraving|logo|icon|stamp|'
                       r'woodcut|botanical art|distribution)\b', re.I)


def plain(value):
    value = html.unescape(re.sub(r'<[^>]*>', ' ', str(value or '')))
    return ' '.join(value.split())


def identity(value):
    value = unicodedata.normalize('NFKC', plain(value)).replace('×', ' x ')
    value = value.replace('®', '').replace('™', '')
    return tuple(re.findall(r'[^\W_]+', value.casefold(), flags=re.UNICODE))


def targets(latin_name):
    """Full taxon first; only an explicit binomial can have a species fallback."""
    name = plain(latin_name)
    if not re.match(r'^[A-Z][A-Za-z-]+\s+', name):
        return []
    tokens = identity(name)
    if len(tokens) < 2 or tokens[1] in ('sp', 'spp'):
        return []
    match = re.match(r'^([A-Z][A-Za-z-]+)\s+(?:(×|x)\s+)?([a-z][a-z-]+)(?=\s|$)', name)
    if not match or match[3] in ('sp', 'spp', 'cv', 'var', 'subsp'):
        return []
    values = [(name, 'exact')]
    base = match[1] + (' × ' if match[2] else ' ') + match[3]
    if identity(base) != identity(name):
        values.append((base, 'species_reference'))
    return values


def claim_values(entity, prop):
    result = []
    for statement in entity.get('claims', {}).get(prop, []):
        if statement.get('rank') == 'deprecated':
            continue
        snak = statement.get('mainsnak', {})
        if snak.get('snaktype') == 'value':
            value = snak.get('datavalue', {}).get('value')
            if isinstance(value, str):
                result.append(value)
    return result


def permitted_license(metadata, source_url):
    """Require the image's own licence and attribution, not a site-wide licence."""
    value = lambda key: plain(metadata.get(key, {}).get('value', ''))
    name, author, url = value('LicenseShortName'), value('Artist'), value('LicenseUrl')
    require(author and len(author) <= 2000, 'missing_attribution', 'The image has no usable author attribution.')
    key = re.sub(r'\s+', ' ', name.casefold()).strip()
    is_cc = bool(re.fullmatch(r'cc[ -]by(?:[ -]sa)?(?:[ -]\d(?:\.\d)?)?', key))
    is_public = key in ('public domain', 'cc0', 'cc0 1.0', 'cc-zero')
    require(is_cc or is_public, 'unsupported_license', 'No supported open image licence was confirmed.')
    if url.startswith('//'):
        url = 'https:' + url
    if url.startswith('http://creativecommons.org/'):
        url = 'https://' + url[len('http://'):]
    if not url and is_public:
        # Commons description page contains the actual public-domain declaration.
        url = source_url + '#Licensing'
    parsed = urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in ('creativecommons.org', 'commons.wikimedia.org')
            and not parsed.username and not parsed.password,
            'unsupported_license_url', 'The image licence URL was not confirmed.')
    return name, author, url


def compact_api(data):
    if 'entities' in data:
        return {'entities': {key: {'id': item.get('id', key),
                                  'claims': {p: item.get('claims', {}).get(p, []) for p in ('P225', 'P18')}}
                             for key, item in data['entities'].items()}}
    return data


class RequestBudget(PhotoError):
    pass


class ReferenceSession:
    def __init__(self, root, state, fetcher, now, budget, max_seconds):
        self.root, self.state, self.fetcher, self.now = root, state, fetcher, now
        self.budget, self.max_seconds = budget, max_seconds
        self.requests, self.cached = 0, 0
        self.start = time.monotonic()
        self.pending = {}

    def request(self, url, *, image=False):
        if self.requests >= self.budget or time.monotonic() - self.start >= self.max_seconds:
            raise RequestBudget('budget_exhausted', 'The run will continue from its saved cursor next time.')
        self.requests += 1
        hosts = IMAGE_HOSTS if image else API_HOSTS
        result = self.fetcher(url, hosts=list(hosts), max_bytes=DEFAULT_LIMITS['maxImageBytes'] if image else 3_000_000,
                              timeout=15, kind='image' if image else 'page')
        parsed = urlsplit(result.url)
        require(parsed.scheme == 'https' and parsed.hostname in hosts and not parsed.username and not parsed.password,
                'unapproved_url', 'Reference response left the approved Wikimedia host.')
        require(len(result.body) <= (DEFAULT_LIMITS['maxImageBytes'] if image else 3_000_000),
                'response_too_large', 'Reference response exceeded the size limit.')
        if image:
            require(result.content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif'),
                    'not_photograph', 'Reference image is not a supported photographic bitmap.')
        return result

    def api(self, endpoint, params):
        params = {'format': 'json', 'formatversion': 2, 'maxlag': 5, **params}
        url = endpoint + '?' + urlencode(params)
        cached = self.state.setdefault('cache', {}).get(url)
        if cached and cached.get('expiresAt', '') > self.now:
            self.cached += 1
            return copy.deepcopy(cached['data'])
        raw = self.request(url)
        try:
            data = json.loads(raw.body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise PhotoError('invalid_api_response', 'Wikimedia did not return JSON.') from exc
        require(isinstance(data, dict) and 'error' not in data, 'api_error', 'The public image API returned an error.')
        data = compact_api(data)
        self.state['cache'][url] = {'expiresAt': later(self.now, days=7), 'data': copy.deepcopy(data)}
        return data

    def metadata(self, file_name):
        return self.api(COMMONS, {'action': 'query', 'prop': 'imageinfo', 'titles': 'File:' + file_name,
                                 'iiprop': 'url|size|mime|mediatype|extmetadata', 'iiurlwidth': 1200})

    def selected_image(self, page, taxon, match_level, proof):
        info = (page.get('imageinfo') or [{}])[0]
        title = plain(page.get('title'))
        ext = info.get('extmetadata') or {}
        descriptor = ' '.join([title, plain(ext.get('ImageDescription', {}).get('value')),
                               plain(ext.get('Categories', {}).get('value'))])
        require(not NOT_PHOTO.search(descriptor), 'not_photograph', 'The source describes an illustration, map or specimen sheet.')
        require(info.get('mime') in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')
                and info.get('mediatype', 'BITMAP') == 'BITMAP', 'not_photograph', 'Only photographic raster files are accepted.')
        require(info.get('width', 0) >= 128 and info.get('height', 0) >= 128,
                'image_too_small', 'Reference image is too small.')
        source_url = info.get('descriptionurl', '')
        parsed = urlsplit(source_url)
        require(parsed.scheme == 'https' and parsed.hostname == 'commons.wikimedia.org'
                and parsed.path.startswith('/wiki/File:'), 'unapproved_source_page', 'Commons file provenance is absent.')
        license_name, author, license_url = permitted_license(ext, source_url)
        image_url = info.get('thumburl') or info.get('url') or ''
        parsed_image = urlsplit(image_url)
        require(parsed_image.scheme == 'https' and parsed_image.hostname in IMAGE_HOSTS,
                'unapproved_image_url', 'Reference image is outside Wikimedia upload storage.')
        # Reuse the same species image for several cultivar references without
        # pretending that it is an exact cultivar or nursery image.
        asset = self.state.setdefault('assets', {}).get(image_url)
        jpeg = None
        if asset and asset.get('expiresAt', '') > self.now:
            path = local_image(self.root, asset.get('image', ''))
            body = self.pending.get(path) or (path.read_bytes() if path.exists() else None)
            if body and hashlib.sha256(body).hexdigest() == asset.get('sha256'):
                self.cached += 1
                jpeg = body
        if jpeg is None:
            jpeg = to_jpeg(self.request(image_url, image=True).body, DEFAULT_LIMITS)
        digest = hashlib.sha256(jpeg).hexdigest()
        relative = 'assets/biljke/reference-' + digest[:24] + '.jpg'
        path = local_image(self.root, relative)
        if not path.exists():
            self.pending[path] = jpeg
        else:
            require(path.read_bytes() == jpeg, 'asset_collision', 'Reference asset contents differ.')
        self.state['assets'][image_url] = {'image': relative, 'sha256': digest,
                                          'expiresAt': asset.get('expiresAt') if asset and jpeg is not None and asset.get('expiresAt', '') > self.now else later(self.now, days=7)}
        return {'image': relative, 'sourceUrl': source_url, 'imageUrl': image_url,
                'taxon': taxon, 'matchLevel': match_level, 'origin': 'wikimedia',
                'author': author, 'license': license_name, 'licenseUrl': license_url,
                'checkedAt': self.now, 'status': 'verified', 'sha256': digest,
                'identityEvidence': proof}

    def lookup(self, taxon, match_level):
        search = self.api(WD, {'action': 'wbsearchentities', 'search': taxon,
                               'language': 'en', 'type': 'item', 'limit': 5})
        ids = [x.get('id') for x in search.get('search', []) if re.fullmatch(r'Q\d+', x.get('id', ''))]
        reasons = []
        if ids:
            entities = self.api(WD, {'action': 'wbgetentities', 'ids': '|'.join(ids), 'props': 'claims'}).get('entities', {})
            for qid in ids:
                entity = entities.get(qid, {})
                names = claim_values(entity, 'P225')
                if not any(identity(name) == identity(taxon) for name in names):
                    continue
                for file_name in claim_values(entity, 'P18')[:2]:
                    response = self.metadata(file_name)
                    for page in response.get('query', {}).get('pages', []):
                        try:
                            return self.selected_image(page, taxon, match_level,
                                {'method': 'wikidata_P225_P18', 'entity': qid,
                                 'scientificName': taxon, 'fileTitle': 'File:' + file_name})
                        except RequestBudget:
                            raise
                        except PhotoError as exc:
                            reasons.append(exc.code)
        # Exact category membership is additional primary identity evidence.
        # No recursive category traversal or loosely related search-result images.
        category = 'Category:' + taxon
        category_info = self.api(COMMONS, {'action': 'query', 'titles': category, 'prop': 'categoryinfo'})
        categories = category_info.get('query', {}).get('pages', [])
        valid_category = any(not p.get('missing') and p.get('ns') == 14
                             and identity(p.get('title', '')[len('Category:'):]) == identity(taxon)
                             and 'categoryinfo' in p for p in categories)
        if valid_category:
            response = self.api(COMMONS, {'action': 'query', 'generator': 'categorymembers',
                                         'gcmtitle': category, 'gcmnamespace': 6, 'gcmlimit': 6,
                                         'prop': 'imageinfo', 'iiprop': 'url|size|mime|mediatype|extmetadata',
                                         'iiurlwidth': 1200})
            for page in response.get('query', {}).get('pages', []):
                try:
                    return self.selected_image(page, taxon, match_level,
                                               {'method': 'exact_commons_taxon_category', 'category': category,
                                                'fileTitle': page.get('title')})
                except RequestBudget:
                    raise
                except PhotoError as exc:
                    reasons.append(exc.code)
        raise PhotoError('no_verified_reference', 'No attributed photographic reference for this exact taxon. '
                         + ('Rejected candidates: ' + ', '.join(sorted(set(reasons))) if reasons else ''))


def later(now, **delta):
    return (datetime.fromisoformat(now.replace('Z', '+00:00')) + timedelta(**delta)).isoformat(timespec='seconds').replace('+00:00', 'Z')


def run_reference_update(root, *, budget=60, fetcher=fetch_resource, dry_run=False, now=None,
                         max_seconds=600, plant_id=None, progress=None):
    root = Path(root).resolve()
    require(type(budget) is int and 0 < budget <= 10000, 'invalid_budget', 'Request budget must be 1–10000.')
    require(type(max_seconds) is int and 0 < max_seconds <= 3600, 'invalid_budget', 'Run duration must be at most one hour.')
    now = now or datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    plants_path, offers_path, state_path = root / 'data/biljke.json', root / 'data/kataloske-stavke.json', root / STATE_PATH
    plant_bytes, offer_bytes = plants_path.read_bytes(), offers_path.read_bytes()
    original, offers = json.loads(plant_bytes), json.loads(offer_bytes)
    require(offers.get('sourcePolicy') == {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']},
            'source_policy', 'Only photographs may be refreshed online.')
    document = copy.deepcopy(original)
    plants = index_rows(document.get('plants'), 'plants')
    state = json.loads(state_path.read_bytes()) if state_path.exists() else {'schemaVersion': 1, 'cursor': 0, 'entries': {}, 'cache': {}, 'assets': {}}
    require(state.get('schemaVersion') == 1, 'state_schema', 'Unknown reference state schema.')
    before_state = copy.deepcopy(state)
    require(not plant_id or plant_id in plants, 'unknown_plant', 'Unknown plant ID.')
    session = ReferenceSession(root, state, fetcher, now, budget, max_seconds)
    report = {'status': 'completed', 'startedAt': now, 'dryRun': bool(dry_run), 'requests': 0,
              'checked': 0, 'added': 0, 'updated': 0, 'verifiedUnchanged': 0, 'pending': 0,
              'failed': 0, 'skipped': 0, 'sources': [], 'dataChanged': False,
              'imageFilesChanged': 0, 'stateChanged': False}
    keys = list(plants)
    cursor = int(state.get('cursor', 0)) % max(len(keys), 1)
    ordered = keys[cursor:] + keys[:cursor]
    for pid in ordered:
        if plant_id and pid != plant_id:
            continue
        plant = plants[pid]
        entry = state.setdefault('entries', {}).get(pid, {})
        current_photo = plant.get('photo') or {}
        current_exists = False
        if current_photo.get('status') == 'verified' and current_photo.get('image'):
            try:
                current_exists = local_image(root, current_photo['image']).is_file()
            except PhotoError:
                pass
        if entry.get('nextCheckAt', '') > now and (entry.get('status') != 'verified' or current_exists):
            report['skipped'] += 1
            continue
        source = {'plantId': pid, 'latinName': plant.get('latinName', '')}
        choices = targets(plant.get('latinName'))
        photo, error, exhausted = None, None, False
        if not choices:
            error = PhotoError('taxon_not_specific', 'No species or exact cultivar taxon can be safely resolved from the name.')
        for taxon, match_level in choices:
            try:
                photo = session.lookup(taxon, match_level)
                break
            except RequestBudget as exc:
                error, exhausted = exc, True
                break
            except PhotoError as exc:
                error = exc
                # A provider outage or access denial is not a reason to submit
                # more queries to the same provider during this run.
                if exc.code not in ('no_verified_reference', 'taxon_not_specific'):
                    break
        if photo:
            existing_compare = {k: v for k, v in current_photo.items() if k != 'checkedAt'}
            new_compare = {k: v for k, v in photo.items() if k != 'checkedAt'}
            if current_exists and existing_compare == new_compare:
                report['verifiedUnchanged'] += 1
                photo = current_photo
            else:
                plant['photo'] = photo
                report['updated' if current_photo else 'added'] += 1
            report['checked'] += 1
            source.update(status='verified', matchLevel=photo['matchLevel'], taxon=photo['taxon'],
                          sourceUrl=photo['sourceUrl'], image=photo['image'])
            state['entries'][pid] = {'status': 'verified', 'attemptedAt': now,
                                     'nextCheckAt': later(now, days=30), 'taxon': photo['taxon']}
        elif exhausted:
            source.update(status='deferred', reason='budget_exhausted', photoPreserved=True)
            report['status'] = 'partial'
            report['sources'].append(source)
            # Cached completed API calls let this unfinished taxon resume.
            state['cursor'] = keys.index(pid)
            break
        else:
            code = error.code if error else 'no_verified_reference'
            source.update(status='pending', reason=code, detail=str(error or ''), photoPreserved=True)
            report['pending'] += 1
            if code not in ('no_verified_reference', 'taxon_not_specific'):
                report['failed'] += 1
            state['entries'][pid] = {'status': 'pending', 'reason': code, 'attemptedAt': now,
                                     'nextCheckAt': later(now, days=7)}
        report['sources'].append(source)
        state['cursor'] = (keys.index(pid) + 1) % max(len(keys), 1)
        if progress:
            progress({**source, 'requests': session.requests})
        if error and error.code in ('http_error', 'api_error', 'download_failed', 'invalid_api_response'):
            report['status'] = 'partial'
            report['providerPaused'] = True
            break
        if session.requests >= budget or time.monotonic() - session.start >= max_seconds:
            report['status'] = 'partial'
            break
    report['requests'], report['cacheHits'] = session.requests, session.cached
    # Every public image is explicitly qualified. No price, offer or botanical
    # field can be changed by this worker, including catalogue scope metadata.
    require({k: v for k, v in document.items() if k != 'plants'} == {k: v for k, v in original.items() if k != 'plants'},
            'non_photo_change', 'Plant envelope changed outside its photo field.')
    for old, new in zip(original['plants'], document['plants']):
        require({k: v for k, v in old.items() if k != 'photo'} == {k: v for k, v in new.items() if k != 'photo'},
                'non_photo_change', 'Reference refresh changed a non-photo plant field.')
        if new.get('photo'):
            require(set(new['photo']) <= PHOTO_KEYS, 'photo_schema', 'Unexpected photograph metadata.')
    report['dataChanged'] = document != original
    report['stateChanged'] = state != before_state
    report['imageFilesChanged'] = len(session.pending)
    report['verifiedPlants'] = sum(bool(p.get('photo', {}).get('status') == 'verified') for p in plants.values())
    report['remainingPlants'] = len(plants) - report['verifiedPlants']
    report['finishedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    if not dry_run:
        require(plants_path.read_bytes() == plant_bytes and offers_path.read_bytes() == offer_bytes,
                'concurrent_edit', 'Catalogue changed during reference lookup; refusing to overwrite it.')
        pending = dict(session.pending)
        if report['dataChanged']:
            pending[plants_path] = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode()
        if report['stateChanged']:
            pending[state_path] = (json.dumps(state, ensure_ascii=False, indent=2) + '\n').encode()
        commit_files(pending)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--budget', type=int, default=60)
    parser.add_argument('--max-seconds', type=int, default=600)
    parser.add_argument('--plant-id')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    report = run_reference_update(args.root, budget=args.budget, max_seconds=args.max_seconds,
                                  plant_id=args.plant_id, dry_run=args.dry_run,
                                  progress=lambda item: print(json.dumps(item, ensure_ascii=False), flush=True))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'sources'}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

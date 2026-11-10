#!/usr/bin/env python3
"""All-plant photo coverage. Only plant.photo and new local assets may change.

Source evidence and resumable state live in docs, never on public cards.
Every run inventories every plant, regardless of existing offer/source bindings.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.parse import urlsplit, unquote
from urllib.robotparser import RobotFileParser

from PIL import Image
from update_photos import (DEFAULT_LIMITS, PhotoError, check_url, commit_files,
                           fetch_resource, local_image, resolve_product_image, to_jpeg, identity_forms)
from discover_nursery_photos import (build_policies, candidate_rank, discover,
                                    names_for, blocked_html)

INACTIVE = {'superseded', 'needs_review'}
STATE = 'docs/full-photo-state.json'
MANIFEST = 'docs/full-photo-manifest.json'
INPUTS = ('data/biljke.json', 'data/kataloske-stavke.json', 'data/rasadnici.json',
          'scripts/photo-sources.json', 'scripts/photo-discovery.json',
          'scripts/full-photo-policy.json', 'docs/photo-reference-catalog.json',
          'docs/fotografije.json', 'docs/photo-discovery-state.json', STATE, MANIFEST)


def read(root, name, default=None):
    path = Path(root)/name
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else copy.deepcopy(default)


def encoded(data):
    return (json.dumps(data, ensure_ascii=False, indent=2)+'\n').encode('utf-8')


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def digest(body):
    return hashlib.sha256(body).hexdigest()


def valid_image(root, relative, expected=None):
    try:
        body = local_image(root, relative).read_bytes()
        if expected and digest(body) != expected:
            return False
        with Image.open(BytesIO(body)) as im:
            if min(im.size) < 64 or im.width*im.height > DEFAULT_LIMITS['maxPixels']:
                return False
            im.verify()
        return True
    except (PhotoError, OSError, ValueError, TypeError):
        return False


def protect(before, after):
    left, right = copy.deepcopy(before), copy.deepcopy(after)
    for envelope in (left, right):
        for plant in envelope['plants']:
            plant.pop('photo', None)
    if left != right:
        raise PhotoError('non_photo_change', 'Plant names, IDs, order and all non-photo fields must stay unchanged.')


def taxonomy_keys(plants, config):
    """Unify only explicitly evidenced full-name synonyms/spelling corrections.

    Search aliases from public catalogue data are NEVER used here.
    """
    parents={}
    def key(name):
        forms=identity_forms(name)
        return ' '.join(min(forms,key=lambda f:(len(f),f)))
    def find(value):
        parents.setdefault(value,value)
        if parents[value]!=value:
            parents[value]=find(parents[value])
        return parents[value]
    for plant in plants:
        original=key(plant['latinName']); find(original)
        for alias in config.get('exactNameAliases',{}).get(plant['id'],[]):
            if not alias.get('evidenceUrls') or not alias.get('name'):
                continue
            left,right=find(original),find(key(alias['name']))
            parents[max(left,right)]=min(left,right)
    return {p['id']:find(key(p['latinName'])) for p in plants}


def validate(root):
    root = Path(root).resolve()
    plants = read(root, 'data/biljke.json')['plants']
    manifest = read(root, MANIFEST, {'plants':{}})['plants']
    taxon_keys=taxonomy_keys(plants,read(root,'scripts/full-photo-policy.json',{}))
    hashes, count = {}, 0
    for plant in plants:
        photo = plant.get('photo')
        if not photo:
            continue
        record = manifest.get(plant['id'], {})
        if set(photo) != {'image','sourceUrl'} or any((
                record.get('latinName') != plant['latinName'],
                record.get('image') != photo.get('image'),
                record.get('sourceUrl') != photo.get('sourceUrl'),
                record.get('matchLevel') != 'exact',
                not record.get('sha256'),
                not valid_image(root,photo.get('image'),record.get('sha256')))):
            raise PhotoError('invalid_photo_manifest','Photo provenance or image integrity failed: '+plant['id'])
        previous = hashes.setdefault(record['sha256'],taxon_keys[plant['id']])
        if previous != taxon_keys[plant['id']]:
            raise PhotoError('image_identity_conflict','One image is linked to different full botanical names.')
        count += 1
    return {'status':'valid','plants':len(plants),'verifiedPlantReferences':count}


class Exhausted(PhotoError):
    pass


class Session:
    def __init__(self, fetcher, budget, seconds):
        self.fetcher, self.budget = fetcher, budget
        self.deadline = time.monotonic()+seconds
        self.requests = 0
        self.cache, self.failed = {}, {}

    def get(self, url, **kwargs):
        check_url(url, kwargs['hosts'], kwargs.get('path_prefixes'))
        if url in self.cache:
            return self.cache[url]
        host = urlsplit(url).hostname
        if host in self.failed:
            raise self.failed[host]
        if self.requests >= self.budget or time.monotonic() >= self.deadline:
            raise Exhausted('budget_exhausted', 'Automatically resumes on the next workflow run.')
        self.requests += 1
        kwargs['timeout'] = min(kwargs['timeout'], max(1, int(self.deadline-time.monotonic())))
        try:
            result = self.fetcher(url, **kwargs)
            check_url(result.url, kwargs['hosts'], kwargs.get('path_prefixes'))
            if len(result.body) > kwargs['max_bytes']:
                raise PhotoError('response_too_large', 'Response exceeds byte limit.')
            if kwargs['kind'] == 'page' and result.content_type in ('text/html', 'application/xhtml+xml') and blocked_html(result.body.decode('utf-8', 'replace')):
                raise PhotoError('site_blocked', 'Source refused automated access.')
            self.cache[url] = result
            return result
        except PhotoError as exc:
            if exc.code in ('site_blocked', 'download_failed') or (exc.code == 'http_error' and any(x in str(exc) for x in ('403', '429', '503'))):
                self.failed[host] = exc
            raise


def candidates_for(plant, offers, references, policies, index, names=None):
    names = names or [plant['latinName']]
    own = {o['nurseryId'] for o in offers if o['plantId'] == plant['id'] and o.get('recordStatus') not in INACTIVE}
    candidates = {}
    def add(nid, page, origin):
        if nid not in policies or not page:
            return
        try:
            check_url(page, policies[nid]['pageHosts'])
        except (PhotoError, ValueError):
            return
        score = candidate_rank(page, names)
        # Archive references have an exact plant ID; their page must still
        # prove the complete botanical identity before any image is accepted.
        if score or origin != 'sitemap':
            candidates.setdefault((nid, page), {'nurseryId': nid, 'pageUrl': page,
                'tier': 0 if nid in own else 1, 'score': score, 'origin': origin})
    for ref in references:
        if ref.get('plantId') == plant['id']:
            add(ref.get('nurseryId'), ref.get('photoSourcePage') or ref.get('sourcePage'), 'archive_reference')
    for offer in offers:
        if offer['plantId'] == plant['id']:
            for field in ('photoSourcePage', 'imageSourceUrl', 'sourceUrl'):
                add(offer['nurseryId'], offer.get(field), 'offer')
    genus = plant['latinName'].split()[0].casefold()
    for nid, item in index.get('nurseries', {}).items():
        for url in item.get('_genusPages', {}).get(genus, item.get('pages', [])):
            if candidate_rank(url, names):
                add(nid, url, 'sitemap')
    return sorted(candidates.values(), key=lambda x: (x['tier'], -x['score'], x['nurseryId'], x['pageUrl']))


def nursery_candidate(plant, item, policy, index, session, names=None):
    page = item['pageUrl']
    rules = index.get('nurseries', {}).get(item['nurseryId'], {}).get('robots', {}).get(urlsplit(page).hostname)
    if rules:
        robot = RobotFileParser(); robot.parse(rules)
        if not robot.can_fetch('DemetraCataloguePhotos', page):
            raise PhotoError('robots_disallowed', 'Source disallows this page.')
    response = session.get(page, hosts=policy['pageHosts'], max_bytes=3_000_000, timeout=15, kind='page')
    if response.content_type not in ('text/html', 'application/xhtml+xml'):
        raise PhotoError('invalid_page', 'Nursery candidate is not an HTML product page.')
    error = PhotoError('identity_missing', 'No exact full botanical name.')
    # Search aliases are for navigation, never evidence of cultivar identity.
    for name in names or [plant['latinName']]:
        try:
            image, method = resolve_product_image(response.body.decode('utf-8', 'replace'), response.url, name, policy)
            return {'provider': 'supplying_nursery' if item['tier'] == 0 else 'other_catalogue_nursery',
                    'nurseryId': item['nurseryId'], 'imageUrl': image, 'sourceUrl': response.url,
                    'matchedName': name, 'identityEvidence': {'method': method, 'canonicalName': plant['latinName']},
                    'imageHosts': policy['imageHosts'], 'imagePathPrefixes': policy.get('imagePathPrefixes'),
                    'license': 'existing_catalogue_source_policy'}
        except PhotoError as exc:
            error = exc
    raise error


def save_candidate(root, plant, candidate, session, pending, manifest):
    if candidate.get('imageUrl') in manifest.get('excludedImageUrls',[]):
        raise PhotoError('reviewed_image_exclusion','Source photo identity was not confirmed during review.')
    response = session.get(candidate['imageUrl'], hosts=candidate['imageHosts'],
        path_prefixes=candidate.get('imagePathPrefixes'), max_bytes=DEFAULT_LIMITS['maxImageBytes'], timeout=20, kind='image')
    if response.content_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'):
        raise PhotoError('invalid_image_type', 'Source did not return a raster photo.')
    jpeg = to_jpeg(response.body, DEFAULT_LIMITS)
    store_jpeg(root, plant, candidate, jpeg, pending, manifest)


def store_jpeg(root, plant, candidate, jpeg, pending, manifest):
    if candidate.get('imageUrl') in manifest.get('excludedImageUrls',[]):
        raise PhotoError('reviewed_image_exclusion','Source photo identity was not confirmed during review.')
    with Image.open(BytesIO(jpeg)) as image:
        if min(image.size) < 128:
            raise PhotoError('image_too_small', 'Photo is too small for the catalogue.')
    sha = digest(jpeg)
    if sha in manifest.get('excludedImageHashes',[]):
        raise PhotoError('reviewed_image_exclusion','Image identity was not confirmed during catalogue review.')
    for plant_id, record in manifest['plants'].items():
        if plant_id != plant['id'] and record.get('sha256') == sha and record.get('taxonKey',record.get('latinName')) != candidate.get('taxonKey',plant['latinName']):
            manifest.setdefault('ambiguousImages', {})[sha] = sorted({record['latinName'],plant['latinName']})
            raise PhotoError('image_identity_conflict', 'The same photo is already bound to a different full botanical name.')
    relative = 'assets/biljke/reference-'+sha[:24]+'.jpg'
    path = local_image(root, relative)
    if path.exists() and path.read_bytes() != jpeg:
        raise PhotoError('asset_collision', 'Existing photo differs from new asset.')
    pending[path] = jpeg
    plant['photo'] = {'image': relative, 'sourceUrl': candidate['sourceUrl']}
    manifest['plants'][plant['id']] = {**candidate, 'latinName': plant['latinName'],
        'image': relative, 'sha256': sha, 'checkedAt': stamp(), 'matchLevel': 'exact'}


def inventory(root, plants, offers, pending=None):
    pending = pending or {}
    native = {o['plantId'] for o in offers if o.get('recordStatus') not in INACTIVE and valid_image(root, o.get('image'))}
    covered = set(native)
    references = set()
    for p in plants:
        photo = p.get('photo') or {}
        compact = set(photo) <= {'image', 'sourceUrl', 'status'} and photo.get('image') and photo.get('sourceUrl')
        if compact and ((root/photo['image']) in pending or valid_image(root, photo['image'])):
            covered.add(p['id'])
            references.add(p['id'])
    missing = [{'plantId': p['id'], 'latinName': p['latinName']} for p in plants if p['id'] not in covered]
    active = [o for o in offers if o.get('recordStatus') not in INACTIVE]
    return {'schemaVersion': 2, 'checkedAt': stamp(), 'status': 'complete' if not missing else 'partial',
        'plants': len(plants), 'plantsInventoried': len(plants), 'plantsWithPhoto': len(covered),
        'plantsWithoutPhoto': missing, 'coveragePercent': round(100*len(covered)/max(1,len(plants)), 2),
        'activeOffers': len(active), 'remainingOffers': sum(o['plantId'] not in references and not valid_image(root,o.get('image')) for o in active)}


def update_index(root, plants, offers, session, budget, seconds, config=None):
    """Index every reviewed nursery; the main lookup covers all plants.

    Virtual offer pairs exist only in a temporary directory. They never enter
    catalogue data, and photo work can never create a price/offer record.
    """
    with tempfile.TemporaryDirectory(prefix='demetra-index-') as tmp:
        target = Path(tmp)
        for name in ('data/biljke.json', 'data/rasadnici.json', 'scripts/photo-sources.json',
                     'scripts/photo-discovery.json', 'docs/photo-discovery-state.json'):
            if (root/name).exists():
                (target/name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root/name, target/name)
        config = config or {}
        nursery_data = read(root, 'data/rasadnici.json')
        nurseries = nursery_data['nurseries'] + config.get('additionalNurseries',[])
        nursery_data['nurseries'] = nurseries
        (target/'data/rasadnici.json').write_bytes(encoded(nursery_data))
        discovery_config=read(root,'scripts/photo-discovery.json')
        discovery_config['sources'] += config.get('additionalSourcePolicies',[])
        (target/'scripts/photo-discovery.json').write_bytes(encoded(discovery_config))
        index=read(root,'docs/photo-discovery-state.json',{'schemaVersion':1,'nurseries':{},'pairs':{}})
        for item in config.get('observedPages',[]):
            ns=index['nurseries'].setdefault(item['nurseryId'],{'frontier':[],'visited':[],'pages':[],'robots':{}})
            if item['pageUrl'] not in ns['pages']:
                ns['pages'].append(item['pageUrl'])
        (target/'docs').mkdir(exist_ok=True)
        (target/'docs/photo-discovery-state.json').write_bytes(encoded(index))
        # Sitemap indexing needs one queue entry per nursery, not the full
        # plant-by-nursery Cartesian product. Product lookup occurs afterwards.
        virtual = [{'id': 'photo-index-'+n['id'], 'plantId': plants[0]['id'], 'nurseryId': n['id']}
                   for n in nurseries] if plants else []
        (target/'data/kataloske-stavke.json').write_bytes(encoded({'offers': virtual}))
        result = discover(target, budget=budget, max_seconds=seconds, fetcher=session.get)
        return read(target, 'docs/photo-discovery-state.json', {'schemaVersion':1,'nurseries':{},'pairs':{}}), result


def run(root, *, request_budget=1000, max_seconds=1500, audit_only=False, fetcher=fetch_resource,
        providers=None, refresh_index=True, now=None, retry_now=False, progress=False):
    root = Path(root).resolve()
    if not 0 <= request_budget <= 20000 or not 1 <= max_seconds <= 7200:
        raise ValueError('Invalid bounded request/time budget.')
    now = now or stamp()
    snapshots = {name: (root/name).read_bytes() if (root/name).exists() else None for name in INPUTS}
    before = read(root, 'data/biljke.json'); data = copy.deepcopy(before)
    plants = data['plants']; offers = read(root, 'data/kataloske-stavke.json')['offers']
    if len({p['id'] for p in plants}) != len(plants):
        raise PhotoError('duplicate_plant', 'Plant IDs are not unique.')
    config = read(root, 'scripts/full-photo-policy.json')
    taxon_keys=taxonomy_keys(plants,config)
    if config.get('allowSpeciesFallback') is not False or config.get('scope') != 'all_catalog_plants':
        raise PhotoError('unsafe_policy', 'Only all-plant exact identity coverage is supported.')
    state = read(root, STATE, {'schemaVersion':1, 'plants':{}})
    retry_cap=(datetime.fromisoformat(now.replace('Z','+00:00'))+timedelta(days=config.get('retryDays',1))).isoformat().replace('+00:00','Z')
    for item in state['plants'].values():
        if item.get('retryAt','') > retry_cap:
            item['retryAt']=retry_cap
    if retry_now:
        for item in state['plants'].values():
            item.pop('retryAt', None)
            item.pop('nextCandidate', None)
            item.pop('nextProvider', None)
    manifest = read(root, MANIFEST, {'schemaVersion':1, 'plants':{}, 'retiredReferences':{}})
    pending, events = {}, []
    session = Session(fetcher, request_budget, max_seconds)
    nursery_list=read(root, 'data/rasadnici.json')['nurseries']+config.get('additionalNurseries',[])
    discovery_config=read(root,'scripts/photo-discovery.json')
    discovery_config['sources'] += config.get('additionalSourcePolicies',[])
    policies = build_policies(nursery_list, read(root, 'scripts/photo-sources.json'), discovery_config)
    index = read(root, 'docs/photo-discovery-state.json', {'schemaVersion':1,'nurseries':{},'pairs':{}})
    for item in config.get('observedPages',[]):
        ns=index['nurseries'].setdefault(item['nurseryId'],{'frontier':[],'visited':[],'pages':[],'robots':{}})
        if item['pageUrl'] not in ns['pages']:
            ns['pages'].append(item['pageUrl'])
    refs = read(root, 'docs/photo-reference-catalog.json', {'references':[]})['references']
    photo_taxa = {}
    for plant_id,record in manifest['plants'].items():
        if plant_id in taxon_keys:
            record['taxonKey']=taxon_keys[plant_id]
        if record.get('sha256'):
            photo_taxa.setdefault(record['sha256'],set()).add(record.get('taxonKey',record.get('latinName')))
    from archive_photo_recovery import rejected_jpeg_hashes, rejected_source_urls
    manifest['excludedImageHashes'] = sorted(rejected_jpeg_hashes(root) | set(config.get('excludedImageHashes',[])))
    manifest['excludedImageUrls'] = sorted(rejected_source_urls(root) | set(config.get('excludedImageUrls',[])))
    ambiguous_hashes = {sha for sha,names in photo_taxa.items() if len(names)>1} | set(manifest.get('ambiguousImages',{})) | set(manifest['excludedImageHashes'])
    # Preserve provenance off the cards. Species substitutions and references
    # requiring visible attribution cannot be migrated into a metadata-free card.
    for plant in plants:
        photo = plant.get('photo')
        if not photo:
            continue
        if set(photo) <= {'image', 'sourceUrl', 'status'}:
            record = manifest['plants'].get(plant['id'], {})
            if record.get('imageUrl') not in manifest['excludedImageUrls'] and record.get('sha256') not in ambiguous_hashes and record.get('latinName') == plant['latinName'] and record.get('sourceUrl') == photo.get('sourceUrl') and record.get('image') == photo.get('image') and valid_image(root, photo.get('image'), record.get('sha256')):
                continue
        manifest.setdefault('retiredReferences', {})[plant['id']] = photo
        plant.pop('photo', None)
    # Earlier catalogue references already carry plant/nursery/image bindings.
    # Reuse only complete, exact-name archive evidence and unambiguous images.
    from archive_photo_recovery import recover_candidates
    archived = recover_candidates(root)
    for plant in plants:
        if plant.get('photo') or plant['id'] not in archived:
            continue
        candidate = dict(archived[plant['id']])
        candidate['taxonKey']=taxon_keys[plant['id']]
        jpeg = candidate.pop('jpeg')
        try:
            store_jpeg(root,plant,candidate,jpeg,pending,manifest)
        except PhotoError as exc:
            events.append({'stage':'archive','plantId':plant['id'],'status':'rejected','reason':exc.code})
    donors={taxon_keys[p['id']]:p for p in plants if p.get('photo')}
    for plant in plants:
        donor=donors.get(taxon_keys[plant['id']])
        if plant.get('photo') or not donor:
            continue
        plant['photo']=copy.deepcopy(donor['photo'])
        record=copy.deepcopy(manifest['plants'][donor['id']])
        record.update(latinName=plant['latinName'],taxonKey=taxon_keys[plant['id']],
            sharedFromPlantId=donor['id'],synonymEvidence=config.get('exactNameAliases',{}).get(plant['id'],[]))
        manifest['plants'][plant['id']]=record
    if not audit_only and refresh_index and request_budget:
        try:
            index, stage = update_index(root, plants, offers, session,
                min(config.get('indexBudget',120), max(1,request_budget//4)), min(240,max(1,max_seconds//5)),config)
            pending[root/'docs/photo-discovery-state.json'] = encoded(index)
            events.append({'stage':'nursery_index','status':stage['status'],'indexedPages':stage['indexedPages']})
        except (PhotoError, OSError, ValueError) as exc:
            events.append({'stage':'nursery_index','status':'source_error','reason':getattr(exc,'code','index_error'),'detail':str(exc)})
    if providers is None and not audit_only:
        from open_photo_sources import commons_candidates, gbif_candidates
        providers = (commons_candidates, gbif_candidates)
    genera = {p['latinName'].split()[0].casefold() for p in plants}
    for item in index.get('nurseries', {}).values():
        item['_genusPages'] = {g:[] for g in genera}
        for page in item.get('pages', []):
            tokens = set(re.findall(r'[^\W_]+', unquote(urlsplit(page).path).casefold()))
            for genus in genera & tokens:
                item['_genusPages'][genus].append(page)
    by_id = {p['id']:p for p in plants}
    # Never-linked plants are first; partial work retains a cursor per plant.
    order = sorted(plants, key=lambda p:(state['plants'].get(p['id'],{}).get('checkedAt',''),p['id']))
    for plant in order:
        entry = state['plants'].setdefault(plant['id'], {})
        if entry.get('latinName') != plant['latinName']:
            entry.clear(); entry['latinName'] = plant['latinName']
        if plant.get('photo'):
            entry.update(status='verified',checkedAt=now)
            continue
        if audit_only:
            entry.update(status='pending',reason='awaiting_search')
            continue
        if session.requests >= session.budget or time.monotonic() >= session.deadline:
            break
        if entry.get('retryAt','') > now:
            continue
        failures = []
        done, exhausted = False, False
        approved_aliases=[a['name'] for a in config.get('exactNameAliases',{}).get(plant['id'],[]) if a.get('evidenceUrls')]
        photo_names=[plant['latinName']]+approved_aliases
        candidates = candidates_for(plant, offers, refs, policies, index,photo_names)
        fingerprint = digest(encoded(candidates))
        if entry.get('fingerprint') != fingerprint:
            entry.pop('nextProvider',None)
        start = entry.get('nextCandidate',0) if entry.get('fingerprint') == fingerprint else 0
        stop = min(len(candidates), start+config.get('maxNurseryCandidates',12))
        for pos in range(start, stop):
            item = candidates[pos]
            try:
                candidate = nursery_candidate(plant,item,policies[item['nurseryId']],index,session,photo_names)
                candidate['taxonKey']=taxon_keys[plant['id']]
                save_candidate(root,plant,candidate,session,pending,manifest)
                done = True; break
            except Exhausted:
                entry['nextCandidate'] = pos; exhausted = True; break
            except (PhotoError,OSError,ValueError) as exc:
                failures.append({'provider':item['nurseryId'],'sourceUrl':item['pageUrl'],'reason':getattr(exc,'code','source_error'),'detail':str(exc)[:200]})
                entry['nextCandidate'] = pos+1
        entry['fingerprint'] = fingerprint
        # Complete the nursery candidate queue before falling down the hierarchy.
        if not done and not exhausted and stop < len(candidates):
            entry.update(status='pending',reason='nursery_candidates_continue',checkedAt=now,failures=failures)
            continue
        if not done and not exhausted:
            provider_list = providers or ()
            provider_start = entry.get('nextProvider', 0)
            for provider_pos, provider in enumerate(provider_list):
                if provider_pos < provider_start:
                    continue
                try:
                    for candidate in provider(plant['latinName'],fetcher=session.get):
                        candidate['taxonKey']=taxon_keys[plant['id']]
                        try:
                            save_candidate(root,plant,candidate,session,pending,manifest)
                            done=True; break
                        except Exhausted:
                            raise
                        except (PhotoError,OSError,ValueError) as exc:
                            failures.append({'provider':candidate.get('provider'),'reason':getattr(exc,'code','image_error')})
                    if done:
                        break
                    entry['nextProvider'] = provider_pos+1
                except Exhausted:
                    entry['nextProvider'] = provider_pos
                    exhausted=True; break
                except (PhotoError,OSError,ValueError) as exc:
                    failures.append({'provider':provider.__name__,'reason':getattr(exc,'code','source_error'),'detail':str(exc)[:200]})
                    entry['nextProvider'] = provider_pos+1
        entry.update(status='verified' if done else 'pending',checkedAt=now,failures=failures)
        entry.pop('retryAt',None)
        if done:
            entry.pop('nextCandidate',None); entry.pop('reason',None)
            entry.pop('nextProvider',None)
            if progress:
                print('Foto: '+plant['latinName']+' | '+str(session.requests)+' zahteva',flush=True)
        elif exhausted:
            entry['reason']='budget_continuation'
        else:
            entry['reason']='no_verified_exact_photo'
            entry['retryAt']=(datetime.fromisoformat(now.replace('Z','+00:00'))+timedelta(days=config.get('retryDays',7))).isoformat().replace('+00:00','Z')
            entry['nextCandidate']=0
            entry.pop('nextProvider',None)
        if exhausted:
            break
    # Inventory includes every plant even when the bounded online batch stops.
    for plant in plants:
        record = manifest['plants'].get(plant['id'],{})
        if plant.get('photo') and record.get('sha256') in manifest.get('ambiguousImages',{}):
            manifest.setdefault('retiredReferences',{})[plant['id']] = plant.pop('photo')
            state['plants'][plant['id']].update(status='pending',reason='ambiguous_shared_image')
            state['plants'][plant['id']].pop('retryAt',None)
    for plant in plants:
        state['plants'].setdefault(plant['id'], {'latinName':plant['latinName'],'status':'pending','reason':'awaiting_search'})
    state['plants'] = {p['id']:state['plants'][p['id']] for p in plants}
    state['updatedAt']=now
    report = {'schemaVersion':2,'startedAt':now,'finishedAt':stamp(),'scope':'all_catalog_plants',
              'requests':session.requests,'auditOnly':audit_only,'nonPhotoDataUnchanged':True,
              'stages':{'fullCoverage':{'status':'completed' if not any(e.get('status')=='source_error' for e in events) else 'partial_failure'}},
              'events':events,'coverage':inventory(root,plants,offers,pending)}
    report['status']=report['coverage']['status']
    report['sourceErrors'] = sum(len(e.get('failures', [])) for e in state['plants'].values())
    report['verifiedPlantReferences']=sum(bool(p.get('photo')) for p in plants)
    report['newlyVerified']=sum(p.get('photo') != by.get('photo') for p,by in zip(plants,before['plants']) if p.get('photo'))
    protect(before,data)
    for name, expected in snapshots.items():
        if ((root/name).read_bytes() if (root/name).exists() else None) != expected:
            raise PhotoError('concurrent_edit','Input changed during photo processing: '+name)
    pending.update({root/'data/biljke.json':encoded(data),root/STATE:encoded(state),root/MANIFEST:encoded(manifest),
        root/'docs/photo-coverage.json':encoded(report['coverage']),root/'docs/photo-pipeline-report.json':encoded(report)})
    commit_files({p:b for p,b in pending.items() if not p.exists() or p.read_bytes()!=b})
    return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--request-budget',type=int,default=1000)
    parser.add_argument('--max-seconds',type=int,default=1500)
    parser.add_argument('--audit-only',action='store_true')
    parser.add_argument('--validate-only',action='store_true')
    parser.add_argument('--index-only',action='store_true')
    parser.add_argument('--skip-index',action='store_true')
    parser.add_argument('--retry-now',action='store_true')
    parser.add_argument('--report',type=Path)
    args=parser.parse_args(argv)
    try:
        if args.index_only:
            root=args.root.resolve()
            inputs={name:(root/name).read_bytes() if (root/name).exists() else None for name in INPUTS}
            session=Session(fetch_resource,args.request_budget,args.max_seconds)
            state,index_report=update_index(root,read(root,'data/biljke.json')['plants'],read(root,'data/kataloske-stavke.json')['offers'],session,min(1000,args.request_budget),min(1800,args.max_seconds),read(root,'scripts/full-photo-policy.json'))
            for name,body in inputs.items():
                if ((root/name).read_bytes() if (root/name).exists() else None)!=body:raise PhotoError('concurrent_edit','Input changed during indexing: '+name)
            commit_files({root/'docs/photo-discovery-state.json':encoded(state)})
            report={'status':index_report['status'],'requests':session.requests,'indexedPages':index_report['indexedPages']}
        else:
            report=validate(args.root) if args.validate_only else run(args.root,request_budget=args.request_budget,max_seconds=args.max_seconds,audit_only=args.audit_only,refresh_index=not args.skip_index,retry_now=args.retry_now,progress=True)
        code=0
    except (PhotoError,OSError,ValueError,KeyError) as exc:
        report={'status':'failed','fatal':True,'reason':getattr(exc,'code','pipeline_error'),'detail':str(exc)}
        code=2
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_bytes(encoded(report))
    print(json.dumps({k:v for k,v in report.items() if k not in ('events','coverage')},ensure_ascii=False,indent=2),flush=True)
    if 'coverage' in report:
        print(json.dumps({k:v for k,v in report['coverage'].items() if k!='plantsWithoutPhoto'},ensure_ascii=False,indent=2),flush=True)
    return code


if __name__=='__main__':
    raise SystemExit(main())

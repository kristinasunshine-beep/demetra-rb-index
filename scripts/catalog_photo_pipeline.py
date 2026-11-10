#!/usr/bin/env python3
"""Discover, refresh and account for catalogue photos using only repository files.

Every stage runs in an isolated working copy. Only photographic fields, their
verified assets, allowlisted source bindings and cursors may reach the repository.
Source failures preserve earlier photos; integrity/concurrent-edit failures abort.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
from urllib.parse import urlsplit

from update_photos import (PHOTO_FIELDS, PhotoError, check_url, commit_files,
                           fetch_resource, to_jpeg, local_image, run_update,
                           load_policies, require, index_rows, supported_page)

INACTIVE = {'superseded', 'needs_review'}
SOURCE_POLICY = {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']}
READ_ONLY_FILES = ('data/rasadnici.json', 'scripts/photo-discovery.json')
OUTPUT_FILES = (
    'data/kataloske-stavke.json', 'data/biljke.json', 'scripts/photo-sources.json',
    'docs/fotografije.json', 'docs/photo-discovery-state.json',
    'docs/reference-photo-state.json', 'docs/photo-refresh-state.json', 'docs/photo-coverage.json',
    'docs/photo-pipeline-report.json',
)
WORK_FILES = OUTPUT_FILES + READ_ONLY_FILES
INTEGRITY_ERRORS = {'non_photo_change', 'offer_identity_change', 'plant_identity_change',
                    'concurrent_edit', 'asset_collision', 'source_policy', 'invalid_data'}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def write(path, value):
    path = Path(path)
    content = encoded(value)
    if not path.exists() or path.read_bytes() != content:
        commit_files({path: content})


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def photo_only_guard(before_offers, after_offers, before_plants, after_plants):
    """Real exceptions, never assertions that disappear under Python -O."""
    def without(value, fields):
        return {k: v for k, v in value.items() if k not in fields}
    for label, before, after, rows_key, fields, envelope in (
        ('offer', before_offers, after_offers, 'offers', PHOTO_FIELDS, {'offers', 'updatedAt'}),
        ('plant', before_plants, after_plants, 'plants', {'photo'}, {'plants'}),
    ):
        old = index_rows(before.get(rows_key), label + ' before')
        new = index_rows(after.get(rows_key), label + ' after')
        require(list(old) == list(new), label + '_identity_change',
                'Photo automation may not add, remove or reorder ' + label + ' records.')
        require(without(before, envelope) == without(after, envelope), 'non_photo_change',
                label + ' metadata changed outside photograph fields.')
        for key in old:
            require(without(old[key], fields) == without(new[key], fields), 'non_photo_change',
                    'Protected catalogue data changed in ' + label + ': ' + key)
    require(after_offers.get('sourcePolicy') == SOURCE_POLICY, 'source_policy',
            'Online work must be limited to photographs.')


def image_exists(root, image):
    try:
        return bool(image) and local_image(root, image).is_file()
    except (PhotoError, TypeError, ValueError):
        return False


def refresh_connected(root, *, fetcher=fetch_resource, limit=120):
    """Rotate the bounded legacy updater so later records cannot starve.

    The legacy worker accepts one limit but no cursor. Only its isolated work
    queue is temporarily reordered; final catalogue order is restored exactly.
    """
    root = Path(root)
    path = root/'data/kataloske-stavke.json'
    original_bytes = path.read_bytes()
    original = json.loads(original_bytes)
    offers = index_rows(original['offers'], 'offers')
    photos = index_rows(read(root/'docs/fotografije.json')['photos'], 'photos', 'offerId')
    policies, _ = load_policies(read(root/'scripts/photo-sources.json'))
    state_path = root/'docs/photo-refresh-state.json'
    state = read(state_path) if state_path.exists() else {'schemaVersion': 1}
    require(state.get('schemaVersion') == 1, 'invalid_data', 'Unknown refresh cursor schema.')
    eligible = []
    for oid, offer in offers.items():
        policy = policies.get(offer['nurseryId'])
        if not policy or offer.get('recordStatus') in INACTIVE:
            continue
        photo = photos.get(oid)
        page = photo.get('sourcePage', '') if photo else (
            offer.get('photoSourcePage') or offer.get('imageSourceUrl') or offer.get('sourceUrl', ''))
        if photo or (not offer.get('image') and policy.get('fillMissing') is True and
                     page and supported_page(policy, page)):
            eligible.append(oid)
    if not eligible:
        return {'status': 'completed', 'checked': 0, 'requests': 0, 'eligible': 0}
    start = eligible.index(state['nextOfferId']) if state.get('nextOfferId') in eligible else 0
    queue = eligible[start:] + eligible[:start]
    selected = queue[:limit]
    reordered = copy.deepcopy(original)
    selected_set = set(selected)
    reordered['offers'] = [offers[oid] for oid in selected] + [o for o in original['offers'] if o['id'] not in selected_set]
    if reordered != original:
        write(path, reordered)
    report = run_update(root, fetcher=fetcher, limit=len(selected))
    updated = read(path)
    indexed = index_rows(updated['offers'], 'offers after refresh')
    require(set(indexed) == set(offers), 'offer_identity_change', 'Refresh changed offer membership.')
    updated['offers'] = [indexed[oid] for oid in offers]
    commit_files({path: original_bytes if updated == original else encoded(updated)})
    deferred = [x['offerId'] for x in report.get('sources', []) if x.get('reason') == 'time_budget']
    next_offer = deferred[0] if deferred else queue[len(selected) % len(queue)]
    state.update(nextOfferId=next_offer, checkedAt=now_utc(), eligible=len(eligible),
                 lastBatchSize=len(selected), nextRunResumes=True)
    write(state_path, state)
    report.update(eligible=len(eligible), batchSize=len(selected), nextOfferId=next_offer)
    return report


def propagate_same_pair(root):
    """Share a documented local nursery photograph within its exact pair only."""
    root = Path(root)
    path, manifest_path = root/'data/kataloske-stavke.json', root/'docs/fotografije.json'
    data, manifest = read(path), read(manifest_path)
    records = index_rows(manifest['photos'], 'photo manifest', 'offerId')
    active = [o for o in data['offers'] if o.get('recordStatus') not in INACTIVE]
    donors = {}
    for offer in active:
        record = records.get(offer['id'])
        if not image_exists(root, offer.get('image')) or not offer.get('imageSourceUrl'):
            continue
        if record and not (record.get('status') == 'saved' and
                           record.get('plantId') == offer['plantId'] and
                           record.get('nurseryId') == offer['nurseryId'] and
                           record.get('localPath') == offer['image'] and
                           record.get('sourcePage') == offer['imageSourceUrl']):
            continue
        # Older archive photos can have source provenance without a modern
        # refresh manifest. Do not invent a remote image URL for those records.
        key = (offer['plantId'], offer['nurseryId'])
        if key not in donors or record:
            donors[key] = offer
    changed = []
    for offer in active:
        donor = donors.get((offer['plantId'], offer['nurseryId']))
        if image_exists(root, offer.get('image')) or not donor:
            continue
        for field in PHOTO_FIELDS:
            offer[field] = donor.get(field, '')
        if donor['id'] in records:
            rec = copy.deepcopy(records[donor['id']])
            rec.update(offerId=offer['id'], sharedFromOfferId=donor['id'])
            records[offer['id']] = rec
        changed.append({'offerId': offer['id'], 'sourceOfferId': donor['id']})
    if changed:
        data['updatedAt'] = now_utc()
        manifest.update(photos=list(records.values()), snapshotAt=data['updatedAt'])
        commit_files({path: encoded(data), manifest_path: encoded(manifest)})
    return {'status': 'completed', 'added': len(changed), 'changes': changed}


def merge_policy(existing, observed, page_url):
    """Retain all reviewed product paths instead of replacing them per plant.

    observed comes from the current reviewed configuration, not the binding's
    self-declared hosts. Existing CDN path restrictions are never removed.
    """
    require(not existing or existing['nurseryId'] == observed['nurseryId'],
            'binding_identity', 'Source policy belongs to another nursery.')
    result = copy.deepcopy(existing or {})
    result.update(nurseryId=observed['nurseryId'], resolver='product', fillMissing=True)
    for field in ('pageHosts', 'imageHosts'):
        result[field] = sorted(set(result.get(field, [])) | set(observed[field]))
    if existing and 'resolverHosts' in existing:
        result['resolverHosts'] = sorted(set(existing['resolverHosts']) | {urlsplit(page_url).hostname})
    prefixes = copy.deepcopy((existing or {}).get('imagePathPrefixes', {}))
    for host, paths in observed.get('imagePathPrefixes', {}).items():
        prefixes[host] = sorted(set(prefixes.get(host, [])) | set(paths))
    if prefixes:
        result['imagePathPrefixes'] = prefixes
    # Store alternatives explicitly so a repeated run cannot nest/duplicate
    # an ever-growing regex. Existing hand-reviewed product patterns remain.
    patterns = list(result.get('discoveredPagePatterns', []))
    old_pattern = (existing or {}).get('pagePathPattern')
    if old_pattern and not patterns and (existing or {}).get('resolver') == 'product':
        patterns.append(old_pattern)
    exact = re.escape(urlsplit(page_url).path)
    if exact not in patterns and not any(re.fullmatch(pattern, urlsplit(page_url).path) for pattern in patterns):
        patterns.append(exact)
    result['discoveredPagePatterns'] = list(dict.fromkeys(patterns))
    result['pagePathPattern'] = '(?:' + '|'.join('(?:' + p + ')' for p in result['discoveredPagePatterns']) + ')'
    return result


def apply_discovered_bindings(root, bindings, fetcher=fetch_resource, *, max_seconds=240):
    from discover_nursery_photos import build_policies, names_for
    root = Path(root)
    path, manifest_path = root/'data/kataloske-stavke.json', root/'docs/fotografije.json'
    data, manifest, config = read(path), read(manifest_path), read(root/'scripts/photo-sources.json')
    offers = index_rows(data['offers'], 'offers')
    plants = index_rows(read(root/'data/biljke.json')['plants'], 'plants')
    policies, limits = load_policies(config)
    discovery_path = root/'scripts/photo-discovery.json'
    reviewed = build_policies(read(root/'data/rasadnici.json')['nurseries'], config,
                              read(discovery_path) if discovery_path.exists() else {'sources': []})
    photos = index_rows(manifest['photos'], 'photos', 'offerId')
    report = {'status': 'completed', 'added': 0, 'failed': 0, 'requests': 0, 'pending': 0, 'sources': []}
    current, deadline, pending_files = now_utc(), time.monotonic() + max_seconds, {}
    for binding in bindings:
        event = {k: binding.get(k) for k in ('plantId', 'nurseryId')}
        if time.monotonic() >= deadline:
            report['pending'] += 1
            report['sources'].append({**event, 'status': 'deferred', 'reason': 'time_budget'})
            continue
        try:
            plant_id, nursery_id = binding['plantId'], binding['nurseryId']
            require(plant_id in plants and nursery_id in reviewed, 'binding_identity', 'Unknown plant or unreviewed nursery.')
            require(binding.get('canonicalName') == plants[plant_id]['latinName'] and
                    binding.get('matchedName') in names_for(plants[plant_id]) and
                    binding.get('evidence', {}).get('identity') == 'exact_full_botanical_name',
                    'binding_identity', 'Discovered page has no current exact botanical identity evidence.')
            require(binding.get('policy', {}).get('nurseryId') == nursery_id,
                    'binding_identity', 'Binding policy belongs to a different nursery.')
            for offer_id in binding.get('offerIds', []):
                require(offer_id in offers and offers[offer_id]['plantId'] == plant_id and
                        offers[offer_id]['nurseryId'] == nursery_id, 'binding_identity',
                        'A discovered offer belongs to another plant or nursery.')
            policy = reviewed[nursery_id]
            check_url(binding['pageUrl'], policy['pageHosts'])
            check_url(binding['imageUrl'], policy['imageHosts'], policy.get('imagePathPrefixes'))
            targets = [o for o in offers.values() if not image_exists(root, o.get('image')) and
                       o.get('recordStatus') not in INACTIVE and
                       o['plantId'] == plant_id and o['nurseryId'] == nursery_id]
            if not targets:
                report['sources'].append({**event, 'status': 'already_filled'})
                continue
            report['requests'] += 1
            result = fetcher(binding['imageUrl'], hosts=policy['imageHosts'],
                             max_bytes=limits['maxImageBytes'],
                             timeout=min(limits['timeout'], max(1, int(deadline-time.monotonic()))),
                             kind='image', path_prefixes=policy.get('imagePathPrefixes'))
            check_url(result.url, policy['imageHosts'], policy.get('imagePathPrefixes'))
            require(len(result.body) <= limits['maxImageBytes'], 'response_too_large', 'Image response exceeds byte limit.')
            require(result.content_type in {'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'},
                    'invalid_image_type', 'Product source did not return a raster photograph.')
            jpeg = to_jpeg(result.body, limits)
            digest = hashlib.sha256(jpeg).hexdigest()
            key = hashlib.sha256((nursery_id+'\0'+plant_id).encode()+jpeg).hexdigest()[:24]
            relative = 'assets/biljke/photo-'+key+'.jpg'
            asset = local_image(root, relative)
            require(not asset.exists() or asset.read_bytes() == jpeg, 'asset_collision', 'An existing asset has different bytes.')
            if not asset.exists():
                pending_files[asset] = jpeg
            merged = merge_policy(policies.get(nursery_id), policy, binding['pageUrl'])
            require(supported_page(merged, binding['pageUrl']), 'invalid_config', 'Merged policy lost the observed product page.')
            for offer in targets:
                offer.update(image=relative, imageKind='Kataloška fotografija rasadnika', imageSourceUrl=binding['pageUrl'])
                photos[offer['id']] = {
                    'offerId': offer['id'], 'plantId': plant_id, 'nurseryId': nursery_id,
                    'sourceUrl': result.url, 'sourcePage': binding['pageUrl'], 'status': 'saved',
                    'localPath': relative, 'sha256': digest, 'photoUpdatedAt': current,
                    'resolutionMode': 'discovered_product_page',
                    'resolutionMethod': binding.get('evidence', {}).get('method', 'exact_botanical_identity'),
                    'matchedName': binding['matchedName'], 'discoveryEvidence': binding['evidence']}
                report['added'] += 1
            policies[nursery_id] = merged
            event.update(status='saved', offers=len(targets), localPath=relative)
        except (PhotoError, OSError, ValueError, TypeError, KeyError) as error:
            report['failed'] += 1
            event.update(status='failed', reason=getattr(error, 'code', 'binding_error'), detail=str(error))
        report['sources'].append(event)
    if report['added']:
        data['updatedAt'] = current
        manifest.update(photos=list(photos.values()), snapshotAt=current)
        config['sources'] = list(policies.values())
        load_policies(config)
        pending_files.update({path: encoded(data), manifest_path: encoded(manifest),
                              root/'scripts/photo-sources.json': encoded(config)})
        commit_files(pending_files)
    if report['failed']:
        report['status'] = 'partial_failure'
    elif report['pending']:
        report['status'] = 'partial_budget'
    return report


def coverage(root):
    root = Path(root).resolve()
    data, plants = read(root/'data/kataloske-stavke.json'), read(root/'data/biljke.json')['plants']
    plant_map = {p['id']: p for p in plants}
    active = [o for o in data['offers'] if o.get('recordStatus') not in INACTIVE]
    def reference(plant):
        photo = plant.get('photo') or {}
        return photo.get('status') == 'verified' and image_exists(root, photo.get('image'))
    native = [o for o in active if image_exists(root, o.get('image'))]
    fallback = [o for o in active if not image_exists(root, o.get('image')) and reference(plant_map[o['plantId']])]
    remaining = [o for o in active if not image_exists(root, o.get('image')) and not reference(plant_map[o['plantId']])]
    covered_plants = {o['plantId'] for o in native} | {p['id'] for p in plants if reference(p)}
    pending_pairs = {}
    for offer in remaining:
        key = (offer['plantId'], offer['nurseryId'])
        row = pending_pairs.setdefault(key, {'plantId': key[0], 'nurseryId': key[1],
                                             'latinName': plant_map[key[0]]['latinName'], 'offerIds': []})
        row['offerIds'].append(offer['id'])
    empty_plants = [{'plantId': p['id'], 'latinName': p['latinName']} for p in plants if p['id'] not in covered_plants]
    return {'schemaVersion': 1, 'checkedAt': now_utc(),
            'status': 'complete' if not remaining and not empty_plants else 'partial',
            'plants': len(plants), 'plantsWithPhoto': len(covered_plants),
            'activeOffers': len(active), 'nurseryPhotos': len(native), 'referencePhotos': len(fallback),
            'remainingOffers': len(remaining), 'coveragePercent': round((len(native)+len(fallback))*100/max(1,len(active)), 2),
            'pendingPairs': list(pending_pairs.values()), 'plantsWithoutPhoto': empty_plants,
            'completionRule': 'Every active offer and plant card has a local nursery photo or a clearly labelled, attributed reference; references never prove nursery availability or exact cultivar when labelled species_reference.'}


def copy_workspace(source, target):
    target.mkdir(parents=True, exist_ok=True)
    for relative in WORK_FILES:
        path = source/relative
        if path.exists():
            (target/relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target/relative)
    if (source/'assets/biljke').exists():
        shutil.copytree(source/'assets/biljke', target/'assets/biljke')


def assert_immutable_assets(before, after):
    for path in (before/'assets/biljke').rglob('*'):
        if path.is_file():
            result = after/path.relative_to(before)
            require(result.is_file() and result.read_bytes() == path.read_bytes(),
                    'asset_collision', 'A photo stage removed or overwrote a previously stored asset.')


def run_pipeline(root, *, discovery_budget=120, reference_budget=180, refresh=True,
                 max_seconds=1500, refresh_limit=120, fetcher=fetch_resource, dry_run=False):
    from discover_nursery_photos import discover
    from reference_photos import run_reference_update
    root = Path(root).resolve()
    require(type(discovery_budget) is int and 0 <= discovery_budget <= 1000 and
            type(reference_budget) is int and 0 <= reference_budget <= 1500 and
            type(max_seconds) is int and 1 <= max_seconds <= 1680 and
            type(refresh_limit) is int and 1 <= refresh_limit <= 1000,
            'invalid_budget', 'Photo request and time budgets must remain bounded.')
    original = {p: (root/p).read_bytes() if (root/p).exists() else None for p in WORK_FILES}
    before_offers, before_plants = read(root/'data/kataloske-stavke.json'), read(root/'data/biljke.json')
    photo_only_guard(before_offers, before_offers, before_plants, before_plants)
    report = {'schemaVersion': 1, 'startedAt': now_utc(), 'status': 'running', 'dryRun': bool(dry_run),
              'stages': {}, 'errors': [], 'nonPhotoDataUnchanged': True, 'committed': False}
    deadline = time.monotonic() + max_seconds
    with tempfile.TemporaryDirectory(prefix='demetra-photos-') as temporary:
        base = Path(temporary)
        work = base/'initial'
        copy_workspace(root, work)

        def stage(name, action):
            nonlocal work
            if time.monotonic() >= deadline:
                result = {'status': 'deferred', 'reason': 'pipeline_time_budget'}
                report['stages'][name] = result
                return result
            trial = base/name
            copy_workspace(work, trial)
            started = time.monotonic()
            print('Photo stage: ' + name, flush=True)
            try:
                result = action(trial)
                require(isinstance(result, dict), 'invalid_report', 'Photo worker did not return a report.')
                photo_only_guard(before_offers, read(trial/'data/kataloske-stavke.json'),
                                 before_plants, read(trial/'data/biljke.json'))
                for relative in READ_ONLY_FILES:
                    value = (trial/relative).read_bytes() if (trial/relative).exists() else None
                    require(value == original[relative], 'non_photo_change', 'Read-only source file changed: ' + relative)
                assert_immutable_assets(work, trial)
                shutil.rmtree(work)
                work = trial
            except Exception as error:
                shutil.rmtree(trial, ignore_errors=True)
                reason = getattr(error, 'code', 'stage_error')
                result = {'status': 'failed', 'reason': reason, 'detail': str(error), 'rolledBack': True}
                report['errors'].append({'stage': name, **result})
                if reason in INTEGRITY_ERRORS:
                    report['fatal'] = True
                    report['status'] = 'failed'
                    report['stages'][name] = result
                    error.pipeline_report = report
                    raise
            result['durationSeconds'] = round(time.monotonic()-started, 2)
            report['stages'][name] = result
            return result

        def remaining(cap):
            return max(1, min(cap, int(deadline-time.monotonic())))

        if refresh:
            refresh_deadline = min(deadline, time.monotonic()+360)
            def bounded_fetch(url, **kwargs):
                require(time.monotonic() < refresh_deadline, 'time_budget', 'Refresh continues on the next run.')
                kwargs['timeout'] = min(kwargs['timeout'], max(1, int(refresh_deadline-time.monotonic())))
                return fetcher(url, **kwargs)
            stage('refresh', lambda path: refresh_connected(path, fetcher=bounded_fetch, limit=refresh_limit))
        stage('samePair', propagate_same_pair)
        if discovery_budget:
            found = stage('discovery', lambda path: discover(path, budget=discovery_budget, fetcher=fetcher,
                                                            max_seconds=remaining(min(480, max(1, int(max_seconds*0.40))))))
            if found.get('bindings'):
                # Reserve time for downloads and references even during short
                # interactive runs; a large sitemap must not consume the job.
                download_seconds = remaining(240)
                if reference_budget:
                    download_seconds = min(download_seconds, max(1, remaining(1500)//2))
                stage('download', lambda path: apply_discovered_bindings(path, found['bindings'], fetcher=fetcher,
                                                                         max_seconds=download_seconds))
        if reference_budget:
            stage('references', lambda path: run_reference_update(path, budget=reference_budget, fetcher=fetcher,
                                                                  max_seconds=remaining(600)))
        photo_only_guard(before_offers, read(work/'data/kataloske-stavke.json'),
                         before_plants, read(work/'data/biljke.json'))
        report['coverage'] = coverage(work)
        report['stagesWithSourceErrors'] = [name for name, result in report['stages'].items()
                                           if result.get('status') in {'failed', 'partial_failure', 'configuration_or_data_error'}
                                           or result.get('failed', 0) or result.get('errors')]
        report['status'] = 'partial_failure' if report['errors'] or report['stagesWithSourceErrors'] else report['coverage']['status']
        report['finishedAt'] = now_utc()
        report['timeBudgetReached'] = time.monotonic() >= deadline
        report['committed'] = not dry_run
        write(work/'docs/photo-coverage.json', report['coverage'])
        write(work/'docs/photo-pipeline-report.json', report)
        pending = {}
        for relative in OUTPUT_FILES:
            path = work/relative
            if path.exists() and path.read_bytes() != original[relative]:
                pending[root/relative] = path.read_bytes()
        for path in (work/'assets/biljke').rglob('*'):
            if path.is_file():
                target = root/path.relative_to(work)
                require(not target.exists() or target.read_bytes() == path.read_bytes(),
                        'asset_collision', 'Concurrent work changed an existing image.')
                if not target.exists():
                    pending[target] = path.read_bytes()
        # Check every input and cursor again immediately before writing. A new
        # upload/edit during a long crawl is never replaced by a stale snapshot.
        for relative, expected in original.items():
            path = root/relative
            require((path.read_bytes() if path.exists() else None) == expected,
                    'concurrent_edit', 'Repository changed during photo work: ' + relative)
        report['changedFiles'] = [str(path.relative_to(root)) for path in pending]
        if not dry_run:
            pending[root/'docs/photo-pipeline-report.json'] = encoded(report)
            commit_files(pending)
    print(json.dumps({k:v for k,v in report['coverage'].items() if k not in {'pendingPairs','plantsWithoutPhoto'}},
                     ensure_ascii=False, indent=2), flush=True)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--discovery-budget', type=int, default=120)
    parser.add_argument('--reference-budget', type=int, default=180)
    parser.add_argument('--refresh-limit', type=int, default=120)
    parser.add_argument('--max-seconds', type=int, default=1500)
    parser.add_argument('--skip-refresh', action='store_true')
    parser.add_argument('--coverage-only', action='store_true')
    parser.add_argument('--require-complete', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(argv)
    code = 0
    try:
        if args.coverage_only:
            result = coverage(args.root)
            if not args.dry_run:
                write(args.root/'docs/photo-coverage.json', result)
        else:
            result = run_pipeline(args.root, discovery_budget=args.discovery_budget,
                                  reference_budget=args.reference_budget, refresh=not args.skip_refresh,
                                  max_seconds=args.max_seconds, refresh_limit=args.refresh_limit, dry_run=args.dry_run)
        if args.require_complete and result.get('coverage', result)['status'] != 'complete':
            code = 1
    except (PhotoError, OSError, ValueError, TypeError, KeyError) as error:
        result = getattr(error, 'pipeline_report', {})
        result.update(status='failed', fatal=True, committed=False,
                      reason=getattr(error, 'code', 'pipeline_error'), detail=str(error), finishedAt=now_utc())
        code = 2
    if args.report:
        write(args.report, result)
    print(json.dumps({k:v for k,v in result.items() if k not in {'stages', 'coverage', 'pendingPairs', 'plantsWithoutPhoto'}},
                     ensure_ascii=False, indent=2), flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())

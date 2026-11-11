"""Photo sources are limited to the nurseries represented in supplied offers.

This module intentionally uses only the standard library, including in Pages
validation. Source evidence stays in the audit files, outside public cards.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit


def read(root, name, default=None):
    path = Path(root) / name
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def offered_nurseries(root):
    ids = {o['nurseryId'] for o in read(root, 'data/kataloske-stavke.json', {}).get('offers', [])}
    return [n for n in read(root, 'data/rasadnici.json', {}).get('nurseries', []) if n['id'] in ids]


def allowed_policies(root):
    sources = {s['nurseryId']: s for s in read(root, 'scripts/photo-sources.json', {}).get('sources', [])}
    overrides = {s['nurseryId']: s for s in read(root, 'scripts/photo-discovery.json', {}).get('sources', [])}
    result = {}
    for nursery in offered_nurseries(root):
        website = nursery.get('website', '')
        parsed = urlsplit(website)
        if parsed.scheme != 'https' or not parsed.hostname or nursery.get('verificationStatus') not in ('verified', 'verified_in_archive'):
            continue
        old, extra = sources.get(nursery['id'], {}), overrides.get(nursery['id'], {})
        result[nursery['id']] = {
            'nurseryId': nursery['id'], 'website': website, 'resolver': 'product', 'fillMissing': True,
            'pageHosts': sorted({parsed.hostname} | set(old.get('pageHosts', [])) | set(extra.get('pageHosts', []))),
            'imageHosts': sorted({parsed.hostname} | set(old.get('imageHosts', [])) | set(extra.get('imageHosts', []))),
            'pagePathPattern': r'/.*', 'seedSitemaps': extra.get('sitemaps', []),
            'imagePathPrefixes': {**old.get('imagePathPrefixes', {}), **extra.get('imagePathPrefixes', {})}}
    return result


def allowed_url(url, hosts, prefixes=None):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.hostname in hosts and
                not parsed.username and not parsed.password and parsed.port in (None, 443) and
                (not (prefixes or {}).get(parsed.hostname) or
                 any(parsed.path.startswith(p) for p in prefixes[parsed.hostname])))
    except (TypeError, ValueError):
        return False


def candidate_allowed(record, policies):
    policy = policies.get(record.get('nurseryId'))
    return bool(policy and record.get('provider') not in ('commons', 'gbif') and
                allowed_url(record.get('sourceUrl'), policy['pageHosts']) and
                allowed_url(record.get('imageUrl'), policy['imageHosts'], policy.get('imagePathPrefixes')))


def offer_allowed(offer, policies, nursery_ids):
    if offer.get('nurseryId') not in nursery_ids:
        return False
    source_url = offer.get('imageSourceUrl')
    page = offer.get('photoSourcePage')
    if source_url or page:
        policy = policies.get(offer['nurseryId'])
        return bool(policy and (not source_url or allowed_url(source_url, policy['imageHosts'], policy.get('imagePathPrefixes'))) and
                    (not page or allowed_url(page, policy['pageHosts'])))
    evidence = offer.get('sourceEvidence') or {}
    return bool(offer.get('dataOrigin') == 'rasadnici-ponude-zip' and evidence.get('archiveVerified') is True and
                evidence.get('sourceFile') and evidence.get('sourceSha256'))


def validate_sources(root):
    policies = allowed_policies(root)
    nursery_ids = {n['id'] for n in offered_nurseries(root)}
    manifest = read(root, 'docs/full-photo-manifest.json', {}).get('plants', {})
    references = 0
    for plant in read(root, 'data/biljke.json', {}).get('plants', []):
        if not plant.get('photo'):
            continue
        record = manifest.get(plant['id'], {})
        if not candidate_allowed(record, policies) or record.get('sourceUrl') != plant['photo'].get('sourceUrl') or record.get('image') != plant['photo'].get('image'):
            raise ValueError('Photo source outside offer nurseries: ' + plant['id'])
        references += 1
    offers = [o for o in read(root, 'data/kataloske-stavke.json', {}).get('offers', []) if o.get('image')]
    for offer in offers:
        if not offer_allowed(offer, policies, nursery_ids):
            raise ValueError('Unverified offer photograph source: ' + offer['id'])
    return {'sourcePolicy': 'offer_nurseries_only', 'nurseriesInOffers': len(nursery_ids),
            'verifiedWebSources': len(policies), 'plantPhotos': references, 'offerPhotos': len(offers)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    print(json.dumps(validate_sources(args.root), indent=2))

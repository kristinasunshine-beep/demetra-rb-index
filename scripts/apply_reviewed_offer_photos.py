#!/usr/bin/env python3
"""Attach reviewed crops from original supplied offers to their exact offer rows.

The registry is docs/reviewed-offer-photos.json:
  {schemaVersion: 1, sourcePolicy: 'original_supplied_offer', entries: [
    {plantId, latinName, nurseryId, offerIds: [...], sourceSha256,
     image: 'assets/biljke/name.jpg', imageSha256,
     provenance: {sourceFile: 'basename.pdf', reviewedAt: ISO_UTC,
       identityEvidence: 'Exact original row/photo association',
       page: 1, sourceRow: '8', pdfImageIndexZeroBased: 3}}
  ]}
For a screenshot, provenance.crop uses left/top/right/bottom/unit='pixels',
with optional originalDimensions=[width,height]. Crop or page is required.
No original documents, private paths or invented source URLs are published.
Default is validation/dry-run; --apply writes only the three offer photo fields.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path, PureWindowsPath
import re

from PIL import Image
from update_photos import PhotoError, atomic_write

REGISTRY = 'docs/reviewed-offer-photos.json'
PHOTO_FIELDS = {'image', 'imageKind', 'imageEvidence'}
PHOTO_KIND = 'Fotografija iz dostavljene ponude'
INACTIVE = {'needs_review', 'superseded'}
ASSET = re.compile(r'assets/biljke/[A-Za-z0-9_-]+\.jpg')
LOCAL_IMAGE = re.compile(r'assets/biljke/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)', re.I)
SHA256 = re.compile(r'[a-f0-9]{64}')


def require(condition, message):
    if not condition:
        raise PhotoError('invalid_reviewed_offer_photo', message)


def keys(value, allowed, required, label):
    require(isinstance(value, dict) and set(value) <= set(allowed) and set(required) <= set(value),
            'Invalid or undocumented fields in ' + label + '.')


def safe_path(root, relative, pattern):
    require(isinstance(relative, str) and pattern.fullmatch(relative), 'Invalid local asset path.')
    target = root / relative
    require(not any(p.is_symlink() for p in [target, *target.parents] if p != root.parent),
            'Symlinked assets are not accepted.')
    require(target.resolve().is_relative_to(root) and target.is_file(), 'Asset is missing or outside repository.')
    return target


def fingerprints(body, *, candidate=False):
    require(len(body) <= 10_485_760, 'Image exceeds the byte limit.')
    with Image.open(io.BytesIO(body)) as image:
        require(0 < image.width * image.height <= 20_000_000, 'Invalid or excessive image dimensions.')
        if candidate:
            require(image.format == 'JPEG' and min(image.size) >= 128,
                    'Reviewed asset must be a JPEG with both dimensions at least 128 pixels.')
        image.load()
        dimensions = image.size
        pixels = hashlib.sha256(str(dimensions).encode() + image.convert('RGB').tobytes()).hexdigest()
    return hashlib.sha256(body).hexdigest(), pixels, dimensions


def validate_provenance(value):
    fields = {'sourceFile', 'reviewedAt', 'identityEvidence', 'page', 'sourceRow',
              'pdfImageIndexZeroBased', 'crop', 'originalDimensions'}
    keys(value, fields, {'sourceFile', 'reviewedAt', 'identityEvidence'}, 'provenance')
    source = value['sourceFile']
    require(isinstance(source, str) and source and len(source) <= 255 and
            not re.search(r'[/\\:\x00-\x1f]', source) and source not in {'.', '..'},
            'Provenance sourceFile must be a basename, never a private path.')
    require(isinstance(value['identityEvidence'], str) and value['identityEvidence'].strip() and
            len(value['identityEvidence']) <= 3000 and
            not re.search(r'[A-Za-z]:[\\/]|file://|/(?:Users|home|workspace)/|\\\\', value['identityEvidence']),
            'Identity evidence must contain the reviewed association, not a private path.')
    try:
        reviewed = datetime.fromisoformat(value['reviewedAt'].replace('Z', '+00:00'))
        require(reviewed.tzinfo is not None, 'Review time must include its timezone.')
    except (ValueError, TypeError, AttributeError):
        raise PhotoError('invalid_reviewed_offer_photo', 'Invalid review timestamp.')
    require('crop' in value or 'page' in value, 'Original page or crop location is required.')
    if 'page' in value:
        require(type(value['page']) is int and value['page'] >= 1, 'Page must be a positive one-based integer.')
    if 'sourceRow' in value:
        require(isinstance(value['sourceRow'], str) and value['sourceRow'].strip(), 'Invalid source row.')
    if 'pdfImageIndexZeroBased' in value:
        require('page' in value and type(value['pdfImageIndexZeroBased']) is int and
                value['pdfImageIndexZeroBased'] >= 0, 'Invalid PDF image index.')
    if 'originalDimensions' in value:
        dims = value['originalDimensions']
        require(isinstance(dims, list) and len(dims) == 2 and all(type(n) is int and n > 0 for n in dims),
                'Invalid original dimensions.')
    if 'crop' in value:
        crop = value['crop']
        keys(crop, {'left', 'top', 'right', 'bottom', 'unit'}, {'left', 'top', 'right', 'bottom', 'unit'}, 'crop')
        require(crop['unit'] == 'pixels' and all(type(crop[k]) is int for k in ('left', 'top', 'right', 'bottom')),
                'Crop coordinates must be integer pixels.')
        require(0 <= crop['left'] < crop['right'] and 0 <= crop['top'] < crop['bottom'], 'Invalid crop rectangle.')
        if 'originalDimensions' in value:
            require(crop['right'] <= dims[0] and crop['bottom'] <= dims[1], 'Crop exceeds original image dimensions.')


def validate_supplement(value, entry, offer):
    fields = {'photoSourceFile', 'photoSourceSha256', 'quoteNumber', 'quoteDate', 'position'}
    keys(value, fields, fields, 'supplemental proof')
    filename = value['photoSourceFile']
    require(isinstance(filename, str) and filename and len(filename) <= 255 and
            not re.search(r'[/\\:\x00-\x1f]', filename) and filename not in {'.', '..'},
            'Supplementary photo source must be a basename.')
    require(isinstance(value['photoSourceSha256'], str) and SHA256.fullmatch(value['photoSourceSha256']) and
            value['photoSourceSha256'] != entry['sourceSha256'], 'Supplementary photograph needs its own distinct source SHA256.')
    require(isinstance(value['quoteNumber'], str) and re.fullmatch(r'\d{1,30}', value['quoteNumber']), 'Invalid supplementary quote number.')
    try:
        date = datetime.strptime(value['quoteDate'], '%Y-%m-%d').date().isoformat()
        require(date == value['quoteDate'] == offer.get('sourceDate'), 'Supplementary quote date does not match the priced offer.')
    except (ValueError, TypeError):
        raise PhotoError('invalid_reviewed_offer_photo', 'Invalid supplementary quote date.')
    evidence = offer.get('sourceEvidence') or {}
    require(isinstance(value['position'], str) and value['position'] and
            value['position'] == str(evidence.get('row', '')) == entry['provenance'].get('sourceRow'),
            'Supplementary photo position does not match the priced original row.')
    quote_proof = ' '.join(str(v) for v in (evidence.get('sourceFile', ''),
                                          (offer.get('priceEvidence') or {}).get('dateEvidence', '')))
    require(re.search(r'(?<!\d)' + re.escape(value['quoteNumber']) + r'(?!\d)', quote_proof),
            'Supplementary quote number is not evidenced by the priced original offer.')


def protect(before, after):
    def stripped(document):
        result = copy.deepcopy(document)
        result['offers'] = [{k: v for k, v in row.items() if k not in PHOTO_FIELDS} for row in result['offers']]
        return result
    require(stripped(before) == stripped(after), 'A field outside the three offer photo fields changed.')


def run(root, *, apply=False, registry=REGISTRY):
    root = Path(root).resolve(strict=True)
    require(registry == REGISTRY, 'Only the reviewed offer-photo registry is accepted.')
    names = [registry, 'data/biljke.json', 'data/rasadnici.json', 'data/kataloske-stavke.json']
    snapshots = {name: (root / name).read_bytes() for name in names}
    source, plant_data, nursery_data, before = [json.loads(snapshots[name].decode('utf-8')) for name in names]
    keys(source, {'schemaVersion', 'sourcePolicy', 'entries'}, {'schemaVersion', 'sourcePolicy', 'entries'}, 'registry')
    require(source['schemaVersion'] == 1 and source['sourcePolicy'] == 'original_supplied_offer' and
            isinstance(source['entries'], list), 'Unsupported reviewed-photo registry.')
    plants = {p['id']: p for p in plant_data['plants']}
    offers = {o['id']: o for o in before['offers']}
    require(len(offers) == len(before['offers']), 'Duplicate offer identifiers.')
    nurseries = {n['id'] for n in nursery_data['nurseries']}
    plan, assigned, registry_assets = [], set(), {}
    image_owners, pixel_owners = {}, {}

    def ownership(digest, pixels, name):
        image_owners.setdefault(digest, set()).add(name)
        pixel_owners.setdefault(pixels, set()).add(name)

    # Validate every proof and target before deciding whether anything can change.
    for entry in source['entries']:
        fields = {'plantId', 'latinName', 'nurseryId', 'offerIds', 'sourceSha256', 'image', 'imageSha256', 'provenance'}
        keys(entry, fields | {'supplementalProof'}, fields, 'registry entry')
        plant = plants.get(entry['plantId'])
        require(plant is not None and plant['latinName'] == entry['latinName'], 'Exact plant identifier and Latin name do not match.')
        require(entry['nurseryId'] in nurseries, 'Unknown nursery identifier.')
        require(isinstance(entry['sourceSha256'], str) and SHA256.fullmatch(entry['sourceSha256']) and
                isinstance(entry['imageSha256'], str) and SHA256.fullmatch(entry['imageSha256']), 'Invalid SHA256 proof.')
        validate_provenance(entry['provenance'])
        target = safe_path(root, entry['image'], ASSET)
        body = target.read_bytes()
        digest, pixels, dimensions = fingerprints(body, candidate=True)
        require(digest == entry['imageSha256'], 'Reviewed image SHA256 does not match the local asset.')
        registry_assets[target] = body
        ownership(digest, pixels, entry['latinName'])
        ids = entry['offerIds']
        require(isinstance(ids, list) and ids and all(isinstance(v, str) and v for v in ids) and
                len(ids) == len(set(ids)), 'Offer identifiers must be a nonempty unique list.')
        for offer_id in ids:
            require(offer_id not in assigned, 'An offer is assigned by more than one registry entry.')
            assigned.add(offer_id)
            offer = offers.get(offer_id)
            require(offer is not None and offer['plantId'] == entry['plantId'] and
                    offer['nurseryId'] == entry['nurseryId'], 'Exact offer/plant/nursery binding does not match.')
            require(offer.get('recordStatus') not in INACTIVE, 'Hidden or superseded offers cannot receive photographs.')
            evidence = offer.get('sourceEvidence') or {}
            require(offer.get('dataOrigin') == 'rasadnici-ponude-zip' and evidence.get('archiveVerified') is True and
                    evidence.get('sourceSha256') == entry['sourceSha256'], 'Original verified offer SHA256 does not match.')
            require(evidence.get('sourceFile') and PureWindowsPath(evidence['sourceFile']).name == entry['provenance']['sourceFile'],
                    'Original offer basename does not match the provenance.')
            for proof_key, original_key in [('page', 'page'), ('sourceRow', 'row')]:
                if proof_key in entry['provenance'] and original_key in evidence:
                    require(str(entry['provenance'][proof_key]) == str(evidence[original_key]), 'Original offer page/row does not match.')
            if 'supplementalProof' in entry:
                validate_supplement(entry['supplementalProof'], entry, offer)
            plan.append((offer_id, entry, dimensions))

    # Compare with existing local offer and plant images, including duplicate files
    # with different names or JPEG metadata. Other cultivars cannot share this crop.
    asset_cache = {}
    existing = [(p['id'], p.get('photo', {}).get('image')) for p in plants.values() if isinstance(p.get('photo'), dict)]
    existing += [(o['plantId'], o.get('image')) for o in offers.values() if o.get('image')]
    for plant_id, relative in existing:
        if not relative or not LOCAL_IMAGE.fullmatch(relative):
            continue
        require(plant_id in plants, 'Existing image has an unknown plant identity.')
        if relative not in asset_cache:
            asset_cache[relative] = fingerprints(safe_path(root, relative, LOCAL_IMAGE).read_bytes())[:2]
        ownership(*asset_cache[relative], plants[plant_id]['latinName'])
    for target, body in registry_assets.items():
        digest, pixels, _ = fingerprints(body, candidate=True)
        require(len(image_owners[digest]) == 1 and len(pixel_owners[pixels]) == 1,
                'The same reviewed image is associated with different plants or cultivars.')

    after = copy.deepcopy(before)
    updated = {o['id']: o for o in after['offers']}
    report = {'registryEntries': len(source['entries']), 'targetOffers': len(plan), 'changedOffers': 0,
              'skippedExistingImage': 0, 'skippedOnlineSource': 0, 'alreadyApplied': 0,
              'nonPhotoDataUnchanged': True, 'applied': bool(apply), 'changes': []}
    for offer_id, entry, dimensions in plan:
        offer = updated[offer_id]
        image_evidence = {'origin': 'reviewed_original_offer', 'sourceSha256': entry['sourceSha256'],
                          'imageSha256': entry['imageSha256'], 'dimensions': list(dimensions),
                          **copy.deepcopy(entry['provenance'])}
        if 'supplementalProof' in entry:
            image_evidence['supplementalProof'] = copy.deepcopy(entry['supplementalProof'])
        if offer.get('image'):
            if offer['image'] == entry['image'] and offer.get('imageEvidence') == image_evidence:
                report['alreadyApplied'] += 1
            else:
                report['skippedExistingImage'] += 1
            continue
        if any(str(offer.get(field) or '').strip() for field in ('imageSourceUrl', 'photoSourcePage')):
            report['skippedOnlineSource'] += 1
            continue
        offer.update(image=entry['image'], imageKind=PHOTO_KIND, imageEvidence=image_evidence)
        report['changes'].append({'offerId': offer_id, 'plantId': entry['plantId'], 'image': entry['image']})
        report['changedOffers'] += 1
    protect(before, after)
    for name, body in snapshots.items():
        require((root / name).read_bytes() == body, 'Input changed during reviewed-photo validation: ' + name)
    for target, body in registry_assets.items():
        require(target.read_bytes() == body, 'Reviewed image changed during validation.')
    if apply and report['changedOffers']:
        atomic_write(root / 'data/kataloske-stavke.json', (json.dumps(after, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--validate-only', action='store_true')
    args = parser.parse_args(argv)
    try:
        print(json.dumps(run(args.root, apply=args.apply), ensure_ascii=True, indent=2))
        return 0
    except (PhotoError, OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'status': 'failed', 'reason': str(exc)}, ensure_ascii=True))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

"""Recover conservative photo candidates from the project's existing archive.

This is an offline provenance check, not a fresh validation of remote pages.
Nothing is written. The caller retains the catalogue mutation boundary.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
from io import BytesIO
import json
from pathlib import Path

from PIL import Image, ImageOps

from discover_nursery_photos import build_policies, candidate_rank
from update_photos import DEFAULT_LIMITS, PhotoError, check_url, local_image, to_jpeg

INACTIVE = {'superseded', 'needs_review'}
# Visual QA raised uncertainty for the first two associations; it did not
# establish a replacement botanical identification. The last two files contain
# the same image associated with different named cultivars in the old archive.
REJECTED_ARCHIVE_PATHS = {
    'assets/biljke/cec7c1beedcd4a94db1e.jpg': 'visual_identity_uncertain',
    'assets/biljke/aa8ec6ade4e9dd11a647.jpg': 'visual_identity_uncertain',
    'assets/biljke/3ede436075be52311ac4.jpg': 'cross_cultivar_duplicate',
    'assets/biljke/55b5f03b662033299a2a.jpg': 'cross_cultivar_duplicate',
}


def _read(root, relative, default):
    path = root/relative
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else default


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _inspect(root, relative):
    path = local_image(root, relative)
    # Limit reads before decoding rather than reading an unbounded file.
    with path.open('rb') as stream:
        body = stream.read(DEFAULT_LIMITS['maxImageBytes']+1)
    jpeg = to_jpeg(body, DEFAULT_LIMITS)
    with Image.open(BytesIO(body)) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
        if min(image.size) < 128:
            raise PhotoError('image_too_small', 'Archived photo is too small.')
        pixels = str(image.size).encode()+b'\0'+image.tobytes()
    return {'jpeg': jpeg, 'rawHash': _digest(body), 'pixelHash': _digest(pixels),
            'jpegHash': _digest(jpeg)}


def rejected_jpeg_hashes(root):
    """Return normalized JPEG hashes of uncertain or ambiguous archive images.

    The online acquisition path can apply the same exclusion after decoding a
    download. Missing archive files are harmless in small fixtures/checkouts.
    """
    root = Path(root).resolve()
    rejected = set()
    for relative in REJECTED_ARCHIVE_PATHS:
        try:
            rejected.add(_inspect(root, relative)['jpegHash'])
        except (PhotoError, OSError, ValueError, TypeError):
            continue
    return rejected


def rejected_source_urls(root):
    """Return original IMAGE URLs linked to rejected archive files.

    This complements content hashes when a server returns a differently sized
    or encoded version of the same uncertain photograph at its original URL.
    """
    root = Path(root).resolve()
    references = _read(root, 'docs/photo-reference-catalog.json', {}).get('references', [])
    urls = set()
    for reference in references:
        manifest = reference.get('manifest') or {}
        if (reference.get('image') in REJECTED_ARCHIVE_PATHS or
                manifest.get('localPath') in REJECTED_ARCHIVE_PATHS):
            url = manifest.get('sourceUrl')
            if isinstance(url, str) and url:
                urls.add(url)
    return urls


def recover_candidates(root):
    """Return plantId -> candidate, choosing supplying nurseries first.

    All content collisions across different full catalogue names are rejected
    on both sides, even if only one of those references passes URL validation.
    Records without saved local bytes are not eligible for offline recovery.
    """
    root = Path(root).resolve()
    references = _read(root, 'docs/photo-reference-catalog.json', {}).get('references', [])
    if not references:
        return {}
    plants = {p['id']: p for p in _read(root, 'data/biljke.json', {}).get('plants', [])}
    offers = _read(root, 'data/kataloske-stavke.json', {}).get('offers', [])
    from photo_source_policy import allowed_policies
    policies = allowed_policies(root)
    rejected = rejected_jpeg_hashes(root)
    rejected_urls = rejected_source_urls(root)
    suppliers = defaultdict(set)
    for offer in offers:
        if offer.get('recordStatus') not in INACTIVE:
            suppliers[offer.get('plantId')].add(offer.get('nurseryId'))

    cache, associations = {}, []
    hashes = {kind: defaultdict(set) for kind in ('rawHash', 'pixelHash', 'jpegHash')}
    for reference in references:
        plant = plants.get(reference.get('plantId'))
        manifest = reference.get('manifest') or {}
        relative = reference.get('image') or manifest.get('localPath')
        if not plant or not relative:
            continue
        if relative not in cache:
            try:
                cache[relative] = _inspect(root, relative)
            except (PhotoError, OSError, ValueError, TypeError):
                cache[relative] = None
        photo = cache[relative]
        if not photo:
            continue
        associations.append((reference, plant, photo))
        for kind, index in hashes.items():
            index[photo[kind]].add(plant['latinName'])

    result, priorities = {}, {}
    for reference, plant, photo in associations:
        if reference.get('image') in REJECTED_ARCHIVE_PATHS or photo['jpegHash'] in rejected:
            continue
        if any(len(index[photo[kind]]) > 1 for kind, index in hashes.items()):
            continue
        manifest = reference.get('manifest') or {}
        nursery = reference.get('nurseryId')
        policy = policies.get(nursery)
        page = reference.get('photoSourcePage') or reference.get('sourcePage')
        relative = reference.get('image')
        if not policy or not page or not relative or manifest.get('status') != 'saved':
            continue
        if (manifest.get('plantId') != plant['id'] or manifest.get('nurseryId') != nursery or
                manifest.get('localPath') != relative or manifest.get('sourcePage') != page):
            continue
        # An exact URL tail is intentionally required; broad species aliases,
        # surrounding product tokens and name substrings cannot prove a cultivar.
        if candidate_rank(page, [plant['latinName']]) not in (100, 105):
            continue
        image_url = manifest.get('sourceUrl')
        if image_url in rejected_urls:
            continue
        try:
            check_url(page, policy['pageHosts'])
            check_url(image_url, policy['imageHosts'], policy.get('imagePathPrefixes'))
        except (PhotoError, ValueError, TypeError):
            continue
        priority = (0 if nursery in suppliers[plant['id']] else 1, nursery, page, reference.get('id', ''))
        if plant['id'] in priorities and priorities[plant['id']] <= priority:
            continue
        priorities[plant['id']] = priority
        result[plant['id']] = {
            'provider': 'archived_nursery', 'sourceUrl': page, 'imageUrl': image_url,
            'matchedName': plant['latinName'], 'nurseryId': nursery,
            'license': 'existing_catalogue_source_policy',
            'imageHosts': policy['imageHosts'], 'imagePathPrefixes': policy.get('imagePathPrefixes'),
            'identityEvidence': {
                'method': 'existing_archive_association_and_exact_canonical_url',
                'canonicalName': plant['latinName'], 'archiveReferenceId': reference.get('id'),
                'archiveLocalPath': relative, 'freshRemotePageValidation': False,
                'rawSha256': photo['rawHash'], 'pixelSha256': photo['pixelHash'],
                'jpegSha256': photo['jpegHash']},
            'jpeg': photo['jpeg']}
    return result


archived_candidates = recover_candidates

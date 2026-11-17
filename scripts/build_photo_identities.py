"""Build public byte identities for duplicate local catalogue photographs.

This is display metadata only: it does not merge plants, offers or image files.
Only referenced assets with identical complete bytes under different paths are
included. Unique paths continue to use their URL as the display identity.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


LOCAL_IMAGE = re.compile(r'assets/biljke/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)', re.I)
REMOTE_IMAGE = re.compile(r'https?://|data:image/', re.I)
OUTPUT_PATH = Path('assets/photo-identities.json')


def _image_path(root: Path, value: object) -> str | None:
    if value in (None, ''):
        return None
    if not isinstance(value, str):
        raise ValueError('Photo paths must be strings')
    if REMOTE_IMAGE.match(value):
        return None  # Remote/data URLs use the renderer's URL identity.
    if not LOCAL_IMAGE.fullmatch(value):
        raise ValueError(f'Unsafe local photo path: {value}')
    resolved = (root / value).resolve(strict=True)
    if not resolved.is_relative_to(root / 'assets' / 'biljke') or not resolved.is_file():
        raise ValueError(f'Photo must be a file within assets/biljke: {value}')
    return value


def build_photo_identities(root: Path) -> dict:
    root = Path(root).resolve()
    plants = json.loads((root / 'data/biljke.json').read_text(encoding='utf-8'))['plants']
    offers = json.loads((root / 'data/kataloske-stavke.json').read_text(encoding='utf-8'))['offers']
    paths: set[str] = set()
    values = [plant.get('photo', {}).get('image') for plant in plants if plant.get('photo')]
    values.extend(offer.get('image') for offer in offers)
    for value in values:
        relative = _image_path(root, value)
        if relative:
            paths.add(relative)

    groups: dict[str, list[str]] = {}
    for relative in sorted(paths):
        digest = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        groups.setdefault(digest, []).append(relative)
    identities = {relative: digest for digest, duplicates in groups.items()
                  if len(duplicates) > 1 for relative in duplicates}
    return {'schemaVersion': 1, 'identities': dict(sorted(identities.items()))}


def write_photo_identities(root: Path) -> dict:
    root = Path(root).resolve()
    manifest = build_photo_identities(root)
    output = root / OUTPUT_PATH
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or not output.parent.resolve().is_relative_to(root):
        raise ValueError('Photo identity output must remain inside the project')
    output.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    manifest = write_photo_identities(args.root)
    print(json.dumps({'path': OUTPUT_PATH.as_posix(), 'paths': len(manifest['identities']),
                      'groups': len(set(manifest['identities'].values()))}))


if __name__ == '__main__':
    main()

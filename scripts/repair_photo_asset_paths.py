#!/usr/bin/env python3
"""Restore the verified files from one accidental assets/biljke/biljke upload."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
POLICY = "scripts/repair-photo-paths.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def history_images(commit, names):
    """Read only the exact original files from this repository's pinned commit."""
    base = "https://raw.githubusercontent.com/kristinasunshine-beep/demetra-rb-index/"

    def download(name):
        url = base + commit + "/assets/biljke/biljke/" + name
        request = urllib.request.Request(url, headers={"User-Agent": "Demetra-Verified-Photo-Restore"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(25 * 1024 * 1024 + 1)
        if len(data) > 25 * 1024 * 1024:
            raise ValueError("Historical image exceeds the size limit")
        return name, data

    with ThreadPoolExecutor(max_workers=6) as pool:
        return dict(pool.map(download, names))


def repair(root, history_loader=None):
    root = Path(root).resolve(strict=True)
    destination = root / "assets" / "biljke"
    misplaced = destination / "biljke"
    for path in (root / "assets", destination, misplaced):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("Photo repair refuses symlinked or external directories")
    if misplaced.exists() and not misplaced.is_dir():
        raise ValueError("The misplaced path is not a directory")
    policy = json.loads((root / POLICY).read_text(encoding="utf-8"))
    expected = policy["files"]
    commit = policy["verifiedAgainstCommit"]
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid historical commit")
    if not isinstance(expected, dict) or not expected:
        raise ValueError("Missing verified image policy")
    for name, value in expected.items():
        if not re.fullmatch(r"reference-[a-f0-9]+\.jpg", name) or not re.fullmatch(r"[a-f0-9]{64}", value):
            raise ValueError("Invalid verified image policy")

    # Validate every source and collision before moving or removing any file.
    sources = sorted(misplaced.iterdir()) if misplaced.exists() else []
    for source in sources:
        if source.is_symlink() or not source.is_file() or source.name not in expected:
            raise ValueError("Unexpected entry in misplaced photo folder: " + source.name)
    source_names = {source.name for source in sources}
    plan = []
    missing = []
    for name, checksum in sorted(expected.items()):
        source = misplaced / name
        target = destination / name
        if not source.resolve().is_relative_to(root) or not target.resolve().is_relative_to(root):
            raise ValueError("Photo repair path escapes repository")
        if name in source_names and digest(source) != checksum:
            raise ValueError("Misplaced image differs from verified original: " + name)
        if target.is_symlink() or (target.exists() and (not target.is_file() or digest(target) != checksum)):
            raise ValueError("A different image already occupies the target: " + name)
        if name in source_names:
            plan.append((source, target, target.exists()))
        elif not target.exists():
            missing.append(name)

    restored = (history_loader or history_images)(commit, missing) if missing else {}
    if set(restored) != set(missing):
        raise ValueError("Incomplete historical photo recovery")
    for name, data in restored.items():
        if hashlib.sha256(data).hexdigest() != expected[name]:
            raise ValueError("Historical image differs from verified original: " + name)

    destination.mkdir(parents=True, exist_ok=True)
    for name, data in restored.items():
        with (destination / name).open("xb") as stream:
            stream.write(data)

    moved = duplicates = 0
    for source, target, identical_copy in plan:
        if identical_copy:
            source.unlink()
            duplicates += 1
        else:
            source.rename(target)
            moved += 1
    if misplaced.exists():
        misplaced.rmdir()  # Only the verified, now-empty nested directory is removed.
    return {"changed": bool(moved or duplicates or restored), "moved": moved,
            "removedIdenticalCopies": duplicates, "restoredFromHistory": len(restored)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    result = repair(ROOT)
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as stream:
            stream.write("changed=" + str(result["changed"]).lower() + "\n")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()

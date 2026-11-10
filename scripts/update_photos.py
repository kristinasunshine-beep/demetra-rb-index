#!/usr/bin/env python3
"""Refresh reviewed nursery photographs. Python 3.11+ and Pillow==13.0.0.

Only image/imageKind/imageSourceUrl, the catalogue version timestamp, the photo
manifest, and JPEG assets may change. Unknown sites use their confirmed direct
image URL, never discovery.
Source failures preserve the complete old photo record. The report is separate
from catalogue freshness; unchanged images do not produce timestamp commits.
"""
from __future__ import annotations

import argparse
import copy
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import html
from html.parser import HTMLParser
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

PHOTO_FIELDS = frozenset({"image", "imageKind", "imageSourceUrl"})
VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
BLOCKED_CONTEXT = re.compile(r"(?:^|[\s_-])(?:related|upsells?|cross-sells?|recommendations?|logo|footer|header)(?:$|[\s_-])", re.I)
BLOCKED_IMAGE = re.compile(r"(?:^|[/_\s.-])(?:logos?|favicon|gravatar|avatar|placeholder|no[-_ ]?image|no[-_ ]?photo|default[-_ ]?(?:image|social)|social[-_ ]?(?:default|share)|sociaal[-_ ]?delen)(?:$|[/_\s.-])", re.I)
LOCAL_JPEG = re.compile(r"assets/biljke/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.jpe?g\Z", re.I)
DEFAULT_LIMITS = {"timeout": 20, "maxPageBytes": 3_000_000, "maxImageBytes": 10_485_760,
                  "maxPixels": 20_000_000, "maxSide": 1200, "jpegQuality": 82}


class PhotoError(Exception):
    def __init__(self, code, detail):
        self.code, self.detail = code, detail
        super().__init__(detail)


def require(condition, code, detail):
    if not condition:
        raise PhotoError(code, detail)


def clean(value):
    return " ".join(html.unescape(str(value or "")).split())


def identity_forms(value):
    """Formatting only. No fuzzy matching, cultivar omission, or taxon aliasing."""
    text = clean(unicodedata.normalize("NFKC", str(value or "")))
    # A supplier's trailing parenthesized nomenclatural synonym is not a new
    # cultivar. The entire primary name before it still has to match exactly.
    primary = re.sub(r"\s+\((?:[A-Z][a-z]+|[A-Z]\.)\s+[a-z].*\)\s*$", "", text)
    forms = set()
    for item in (text, primary):
        item = item.replace("×", " x ").replace("®", "").replace("™", "")
        item = re.sub(r"(?<=\w)['’‘′](?=\w)", "", item)
        forms.add(tuple(re.findall(r"[^\W_]+", item.casefold(), flags=re.UNICODE)))
    return forms


def identity_matches(value, latin_name, *, title=False):
    if title:
        value = re.split(r"\s+[|–—]\s+", clean(value), maxsplit=1)[0]
    expected = identity_forms(latin_name)
    if not any(len(x) >= 2 and x[1] not in {"sp", "spp"} for x in expected):
        return False
    actual=identity_forms(value)
    return bool(actual & expected) or any(a == e*2 for a in actual for e in expected)


def url_key(url):
    p = urlsplit(url)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), p.query, ""))


def check_url(url, hosts, path_prefixes=None):
    try:
        p = urlsplit(url)
        valid = (p.scheme == "https" and p.hostname in hosts and
                 not p.username and not p.password and p.port in (None, 443))
    except (TypeError, ValueError):
        valid = False
    require(valid, "unapproved_url", "HTTPS URL is not on this nursery's host allowlist.")
    prefixes = (path_prefixes or {}).get(p.hostname)
    require(not prefixes or any(p.path.startswith(x) for x in prefixes),
            "unapproved_image_path", "Image URL is outside this nursery's approved CDN directory.")
    return url


@dataclass
class FetchResult:
    body: bytes
    url: str
    content_type: str


class SafeRedirects(HTTPRedirectHandler):
    max_redirections = 4
    max_repeats = 2

    def __init__(self, check):
        super().__init__()
        self.check = check

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_resource(url, *, hosts, max_bytes, timeout, kind, path_prefixes=None):
    check = lambda value: check_url(value, hosts, path_prefixes)
    check(url)
    request = Request(url, headers={
        "User-Agent": "DemetraPhotoBot/1.0 (https://github.com/kristinasunshine-beep/demetra-rb-index)",
        "Accept": ("application/json" if kind == "api" else
                   "text/html,application/xhtml+xml" if kind == "page" else
                   "image/jpeg,image/png,image/webp,image/avif,image/gif"),
        "Accept-Encoding": "identity",
    })
    try:
        start = time.monotonic()
        with build_opener(SafeRedirects(check)).open(request, timeout=timeout) as response:
            check(response.url)
            length = response.headers.get("Content-Length")
            require(not length or not length.isdigit() or int(length) <= max_bytes,
                    "response_too_large", "Remote response exceeds the byte limit.")
            chunks, size = [], 0
            while True:
                require(time.monotonic() - start <= timeout, "timeout", "Source exceeded its time limit.")
                chunk = response.read(min(65536, max_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                require(size <= max_bytes, "response_too_large", "Remote response exceeds the byte limit.")
                chunks.append(chunk)
            return FetchResult(b"".join(chunks), response.url,
                               response.headers.get_content_type().lower())
    except HTTPError as exc:
        raise PhotoError("http_error", f"Source returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise PhotoError("download_failed", str(exc)) from exc


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: "Node | None" = field(default=None, repr=False)

    def text(self):
        output, stack = [], list(reversed(self.children))
        while stack:
            value = stack.pop()
            if isinstance(value, str):
                output.append(value)
            elif value.tag not in {"script", "style"}:
                stack.extend(reversed(value.children))
        return clean("".join(output))

    def excluded(self):
        node = self
        while node:
            if node.tag in {"header", "footer", "nav", "aside"}:
                return True
            if BLOCKED_CONTEXT.search(node.attrs.get("class", "") + " " + node.attrs.get("id", "")):
                return True
            node = node.parent
        return False


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.nodes, self.stack = [], [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        require(len(self.nodes) < 100000 and len(self.stack) < 512,
                "html_too_complex", "HTML exceeds parser limits.")
        node = Node(tag, {k: v or "" for k, v in attrs}, parent=self.stack[-1])
        self.nodes.append(node)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def jsonld_objects(doc):
    result = []
    for node in doc.nodes:
        if node.tag != "script" or "ld+json" not in node.attrs.get("type", ""):
            continue
        try:
            value = json.loads("".join(x for x in node.children if isinstance(x, str)))
        except (ValueError, RecursionError):
            continue
        stack = [value]
        while stack:
            require(len(result) < 20000, "jsonld_too_complex", "JSON-LD exceeds parser limits.")
            item = stack.pop()
            if isinstance(item, dict):
                result.append(item)
                stack.extend(item.values())
            elif isinstance(item, list):
                stack.extend(reversed(item))
    return result


def has_type(item, expected):
    types = item.get("@type", [])
    return any(str(t).rstrip("/").rsplit("/", 1)[-1] == expected
               for t in (types if isinstance(types, list) else [types]))


def image_values(value, references, depth=0):
    if depth > 6:
        return []
    if isinstance(value, str):
        if value in references:
            target = references[value]
            direct = target.get("contentUrl") or target.get("url")
            if direct == value:
                return [value]
            return image_values(target, references, depth + 1)
        return [value]
    if isinstance(value, list):
        return [url for item in value for url in image_values(item, references, depth + 1)]
    if isinstance(value, dict):
        for key in ("contentUrl", "url", "@id"):
            if value.get(key):
                return image_values(value[key], references, depth + 1)
    return []


def supported_page(policy, url):
    p = urlsplit(url)
    return (policy.get("resolver") == "product" and
            p.hostname in policy.get("resolverHosts", policy["pageHosts"]) and
            bool(re.fullmatch(policy["pagePathPattern"], p.path)))


def resolve_product_image(source, page_url, latin_name, policy):
    """Resolve only the principal image of an identified, supported product."""
    require(supported_page(policy, page_url), "unsupported_page", "This URL has no supported product resolver.")
    doc = Document(source)
    objects = jsonld_objects(doc)
    # A bare {"@id": "..."} reference must not overwrite its ImageObject.
    refs = {}
    for item in objects:
        identifier = item.get("@id")
        if isinstance(identifier, str) and len(item) > len(refs.get(identifier, {})):
            refs[identifier] = item
    metas = {}
    for node in doc.nodes:
        if node.tag == "meta":
            key = node.attrs.get("property", node.attrs.get("name", "")).casefold()
            metas.setdefault(key, []).append(node.attrs.get("content", ""))
        if node.tag == "link" and "canonical" in node.attrs.get("rel", "").split():
            require(url_key(urljoin(page_url, node.attrs.get("href", ""))) == url_key(page_url),
                    "page_identity_mismatch", "Canonical URL differs from the requested product.")
    for value in metas.get("og:url", []):
        require(url_key(urljoin(page_url, value)) == url_key(page_url),
                "page_identity_mismatch", "Open Graph URL points to a different page.")
    h1s = [n.text() for n in doc.nodes if n.tag == "h1" and not n.excluded() and n.text()]
    products = [x for x in objects if has_type(x, "Product") and
                identity_matches(x.get("name", ""), latin_name) and
                (not x.get("url") or url_key(urljoin(page_url, x["url"])) == url_key(page_url))]
    if h1s:
        require(all(identity_matches(t, latin_name, title=True) for t in h1s),
                "plant_identity_mismatch", "Product heading does not exactly match genus, species and cultivar.")
    elif not products:
        titles = [n.text() for n in doc.nodes if n.tag == "title"]
        require(any(identity_matches(t, latin_name, title=True) for t in titles),
                "plant_identity_mismatch", "Product name could not be confirmed.")

    def candidate(value, method):
        for raw in image_values(value, refs):
            url = urljoin(page_url, html.unescape(raw))
            if BLOCKED_IMAGE.search(unquote(urlsplit(url).path)) or urlsplit(url).path.lower().endswith(".svg"):
                continue
            check_url(url, policy["imageHosts"], policy.get("imagePathPrefixes"))
            return url, method
        return None

    for product in products:
        result = candidate(product.get("image"), "product_jsonld")
        if result:
            return result
    for item in objects:
        if has_type(item, "WebPage") or has_type(item, "ItemPage"):
            item_url = item.get("url", item.get("@id", ""))
            if item_url and url_key(urljoin(page_url, item_url)) == url_key(page_url):
                result = candidate(item.get("primaryImageOfPage"), "page_primary_image")
                if result:
                    return result
    # Featured WooCommerce image only. Related-product thumbnails are excluded.
    for node in doc.nodes:
        if node.tag == "img" and "wp-post-image" in node.attrs.get("class", "").split() and not node.excluded():
            if BLOCKED_IMAGE.search(node.attrs.get("alt", "")):
                continue
            result = candidate(node.attrs.get("data-large_image") or node.attrs.get("data-src") or
                               node.attrs.get("src"), "featured_product_image")
            if result:
                return result
    # Some botanical catalogues have no Product JSON-LD. Require BOTH the
    # exact product identity checked above and an image's own full-name alt.
    for node in doc.nodes:
        if node.tag == "img" and not node.excluded() and identity_matches(node.attrs.get("alt", ""), latin_name, title=True):
            result = candidate(node.attrs.get("data-large_image") or node.attrs.get("data-src") or
                               node.attrs.get("data-original") or node.attrs.get("src"), "exact_product_image_alt")
            if result:
                return result
    og_names = metas.get("og:title", []) + metas.get("og:image:alt", [])
    if any(identity_matches(value, latin_name, title=True) for value in og_names):
        result = candidate(metas.get("og:image:secure_url", []) + metas.get("og:image", []), "product_og_image")
        if result:
            return result
    raise PhotoError("no_product_image", "No trustworthy principal product photograph was found.")


def to_jpeg(body, limits):
    require(isinstance(body, bytes) and len(body) <= limits["maxImageBytes"],
            "response_too_large", "Image exceeds the byte limit.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(body)) as source:
                require(source.format in {"JPEG", "PNG", "WEBP", "GIF", "AVIF"},
                        "unsupported_image", "Only supported raster photographs are accepted.")
                require(0 < source.width * source.height <= limits["maxPixels"],
                        "image_too_large", "Image exceeds the pixel limit.")
                require(min(source.size) >= 64, "image_too_small", "Image is too small to be a catalogue photograph.")
                image = ImageOps.exif_transpose(source)
                image.thumbnail((limits["maxSide"], limits["maxSide"]), Image.Resampling.LANCZOS)
                if image.mode in {"RGBA", "LA", "P"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    rgb = Image.new("RGB", rgba.size, "white")
                    rgb.paste(rgba, mask=rgba.getchannel("A"))
                    image = rgb
                else:
                    image = image.convert("RGB")
                output = BytesIO()
                image.save(output, format="JPEG", quality=limits["jpegQuality"], optimize=True, progressive=True)
                return output.getvalue()
    except PhotoError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombWarning,
            Image.DecompressionBombError) as exc:
        raise PhotoError("invalid_image", "Response is not a safe, decodable raster image.") from exc


def local_image(root, relative):
    require(isinstance(relative, str) and LOCAL_JPEG.fullmatch(relative),
            "invalid_local_path", "Photograph must use a safe assets/biljke/*.jpg path.")
    path = (root / relative).resolve()
    require(path.is_relative_to(root / "assets" / "biljke"), "invalid_local_path", "Image path escapes its directory.")
    return path


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PhotoError("invalid_data", f"Cannot read valid JSON from {path.name}.") from exc


def index_rows(rows, label, key="id"):
    require(isinstance(rows, list) and len(rows) <= 50000, "invalid_data", f"Invalid {label} array.")
    result = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get(key), str) and row[key] and row[key] not in result,
                "invalid_data", f"Missing or duplicate {label} identifier.")
        result[row[key]] = row
    return result


def load_policies(config):
    require(isinstance(config, dict) and config.get("schemaVersion") == 1,
            "invalid_config", "Photo-source config requires schemaVersion 1.")
    policies = index_rows(config.get("sources"), "photo sources", "nurseryId")
    for policy in policies.values():
        for key in ("pageHosts", "imageHosts"):
            hosts = policy.get(key)
            require(isinstance(hosts, list) and hosts and all(isinstance(h, str) and
                    re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", h) and "." in h for h in hosts),
                    "invalid_config", f"Invalid {key} allowlist.")
        require(policy.get("resolver") in {"product", "direct"}, "invalid_config", "Unknown resolver.")
        if policy["resolver"] == "product":
            try:
                re.compile(policy["pagePathPattern"])
            except (KeyError, TypeError, re.error) as exc:
                raise PhotoError("invalid_config", "Invalid product-page pattern.") from exc
    limits = dict(DEFAULT_LIMITS)
    limits.update(config.get("limits", {}))
    for key, value in limits.items():
        require(key in DEFAULT_LIMITS and type(value) is int and 0 < value <= DEFAULT_LIMITS[key],
                "invalid_config", f"Invalid or excessive limit: {key}.")
    return policies, limits


def atomic_write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".photo-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def commit_files(files):
    """Atomic files plus rollback; no existing image is overwritten with a new image."""
    done = []
    try:
        for path, body in files.items():
            before = path.read_bytes() if path.exists() else None
            atomic_write(path, body)
            done.append((path, before))
    except Exception:
        for path, before in reversed(done):
            if before is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, before)
        raise


def run_update(root, *, config=None, fetcher=fetch_resource, dry_run=False,
               limit=None, nursery=None, offer_id=None, now=None):
    root = Path(root).resolve()
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    policies, limits = load_policies(config if config is not None else load_json(root / "scripts/photo-sources.json"))
    catalogue_path, manifest_path = root / "data/kataloske-stavke.json", root / "docs/fotografije.json"
    catalogue_bytes, manifest_bytes = catalogue_path.read_bytes(), manifest_path.read_bytes()
    original_catalogue, original_manifest = json.loads(catalogue_bytes), json.loads(manifest_bytes)
    require(isinstance(original_catalogue, dict) and original_catalogue.get("schemaVersion") == 1 and
            isinstance(original_manifest, dict), "invalid_data", "Invalid catalogue or photo-manifest envelope.")
    catalogue, manifest = copy.deepcopy(original_catalogue), copy.deepcopy(original_manifest)
    plant_data, nursery_data = load_json(root / "data/biljke.json"), load_json(root / "data/rasadnici.json")
    require(isinstance(plant_data, dict) and isinstance(nursery_data, dict),
            "invalid_data", "Invalid plant or nursery envelope.")
    plants = index_rows(plant_data.get("plants"), "plants")
    nurseries = index_rows(nursery_data.get("nurseries"), "nurseries")
    offers = index_rows(catalogue.get("offers"), "offers")
    photos = index_rows(manifest.get("photos"), "photos", "offerId")
    require(not nursery or nursery in nurseries, "invalid_selection", "Unknown nursery ID.")
    require(not offer_id or offer_id in offers, "invalid_selection", "Unknown offer ID.")
    require(limit is None or type(limit) is int and limit > 0, "invalid_selection", "Limit must be positive.")
    for offer in offers.values():
        require(offer.get("plantId") in plants and offer.get("nurseryId") in nurseries,
                "invalid_data", "An offer has an unknown plant or nursery.")
    for record in photos.values():
        offer = offers.get(record["offerId"])
        require(offer and all(record.get(k) == offer.get(k) for k in ("plantId", "nurseryId")) and
                record.get("localPath") == offer.get("image") and
                record.get("sourcePage") == offer.get("imageSourceUrl") and record.get("status") == "saved",
                "manifest_mismatch", "Photo manifest does not match its offer, plant, nursery or photo fields.")
        local_image(root, record["localPath"])

    report = {"status": "completed", "startedAt": now, "dryRun": bool(dry_run), "requests": 0,
              "checked": 0, "updated": 0, "added": 0, "verifiedUnchanged": 0, "failed": 0,
              "skipped": 0, "pageResolved": 0, "directChecks": 0, "dataChanged": False,
              "manifestChanged": False, "imageFilesChanged": 0, "sources": []}
    pending, page_cache, image_cache = {}, OrderedDict(), OrderedDict()

    def get(url, policy, kind):
        hosts = policy["pageHosts" if kind == "page" else "imageHosts"]
        prefixes = policy.get("imagePathPrefixes") if kind == "image" else None
        check_url(url, hosts, prefixes)
        if kind == "image":
            require(not BLOCKED_IMAGE.search(unquote(urlsplit(url).path)),
                    "placeholder_image", "A logo or placeholder cannot replace a photograph.")
        cache_key = (policy["nurseryId"], url)
        cache = page_cache if kind == "page" else image_cache
        if cache_key in cache:
            cache.move_to_end(cache_key)
            cached = cache[cache_key]
            if isinstance(cached, PhotoError):
                raise cached
            return cached
        report["requests"] += 1
        try:
            result = fetcher(url, hosts=hosts, max_bytes=limits["maxPageBytes" if kind == "page" else "maxImageBytes"],
                             timeout=limits["timeout"], kind=kind, path_prefixes=prefixes)
            check_url(result.url, hosts, prefixes)
            if kind == "image":
                require(not BLOCKED_IMAGE.search(unquote(urlsplit(result.url).path)),
                        "placeholder_image", "Image redirect points to a logo or placeholder.")
            require(len(result.body) <= limits["maxPageBytes" if kind == "page" else "maxImageBytes"],
                    "response_too_large", "Source exceeds the byte limit.")
            if kind == "page":
                require(result.content_type in {"text/html", "application/xhtml+xml"}, "invalid_page", "Source is not HTML.")
                value = (result.body.decode("utf-8", errors="replace"), result.url)
            else:
                require(result.content_type in {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"},
                        "invalid_image_type", "Source is not a supported raster image.")
                value = (to_jpeg(result.body, limits), result.url)
            cache[cache_key] = value
            return value
        except PhotoError as exc:
            cache[cache_key] = exc
            raise
        finally:
            while len(cache) > (8 if kind == "page" else 32):
                cache.popitem(last=False)

    selected = [o for o in offers.values() if (not nursery or o["nurseryId"] == nursery) and
                (not offer_id or o["id"] == offer_id)]
    attempted = 0
    for offer in selected:
        if offer.get('recordStatus') in {'needs_review', 'superseded'}:
            report['skipped'] += 1
            continue
        record = photos.get(offer["id"])
        policy = policies.get(offer["nurseryId"])
        entry = {"offerId": offer["id"], "plantId": offer["plantId"], "nurseryId": offer["nurseryId"]}
        # Archive-sourced offers have no online non-photo source URL. Their
        # independent photo binding may still point to an exact nursery page.
        page = record.get("sourcePage", "") if record else (
            offer.get("photoSourcePage") or offer.get("imageSourceUrl") or offer.get("sourceUrl", ""))
        can_fill = (not offer.get("image") and policy and policy.get("fillMissing") is True and
                    page and supported_page(policy, page))
        if not policy or not record and not can_fill:
            entry.update(status="skipped", reason="no_reviewed_online_photo_or_supported_product_page")
            report["skipped"] += 1
            report["sources"].append(entry)
            continue
        if limit is not None and attempted >= limit:
            break
        attempted += 1
        entry["sourcePage"] = page
        try:
            check_url(page, policy["pageHosts"])
            if supported_page(policy, page):
                source, final_page = get(page, policy, "page")
                # A redirect to a category or unrelated product must not use the
                # old URL as a silent fallback.
                image_url, method = resolve_product_image(source, final_page, plants[offer["plantId"]]["latinName"], policy)
                mode = "product_page"
            else:
                require(record, "unsupported_page", "Missing images require a supported product-page resolver.")
                image_url, method, mode = record["sourceUrl"], "confirmed_manifest_url", "confirmed_direct"
            entry.update(mode=mode, method=method, imageUrl=image_url)
            jpeg, final_image_url = get(image_url, policy, "image")
            digest = hashlib.sha256(jpeg).hexdigest()
            old_relative = offer.get("image", "")
            old_path = local_image(root, old_relative) if old_relative else None
            same_image = bool(old_path and old_path.exists() and old_path.read_bytes() == jpeg)
            if same_image:
                relative = old_relative
            else:
                # A shared old JPEG can belong to several sizes/offers. A new
                # immutable filename preserves their old provenance until each
                # corresponding offer is independently confirmed.
                asset_hash = hashlib.sha256((offer["nurseryId"] + "\0" + offer["plantId"]).encode() + jpeg).hexdigest()[:24]
                relative = "assets/biljke/photo-" + asset_hash + ".jpg"
            path = local_image(root, relative)
            if path.exists():
                require(path.read_bytes() == jpeg, "asset_collision", "An existing asset has different content.")
            elif path not in pending:
                pending[path] = jpeg
            changed = (not same_image or record is None or record.get("sourceUrl") != final_image_url or
                       offer.get("imageSourceUrl") != page)
            if changed:
                offer.update(image=relative, imageSourceUrl=page)
                if not offer.get("imageKind"):
                    offer["imageKind"] = "Kataloška fotografija rasadnika"
                new_record = dict(record or {})
                new_record.update(offerId=offer["id"], plantId=offer["plantId"], nurseryId=offer["nurseryId"],
                                  sourceUrl=final_image_url, sourcePage=page, status="saved", localPath=relative,
                                  sha256=digest, photoUpdatedAt=now, resolutionMode=mode, resolutionMethod=method)
                if record:
                    record.clear()
                    record.update(new_record)
                else:
                    manifest["photos"].append(new_record)
                    photos[offer["id"]] = new_record
                entry["status"] = "updated" if old_relative else "added"
                report[entry["status"]] += 1
            else:
                entry["status"] = "verified_unchanged"
                report["verifiedUnchanged"] += 1
            entry.update(localPath=relative, sha256=digest)
            report["checked"] += 1
            report["pageResolved" if mode == "product_page" else "directChecks"] += 1
        except (PhotoError, OSError, ValueError, TypeError) as exc:
            entry.update(status="failed", reason=getattr(exc, "code", "source_error"),
                         detail=str(exc), photoPreserved=True)
            report["failed"] += 1
        report["sources"].append(entry)

    # Defense in depth: a successful updater is not allowed to edit prices,
    # dimensions, availability, dates, plant/nursery IDs or other offer fields.
    before_offers = index_rows(original_catalogue["offers"], "original offers")
    require(set(offers) == set(before_offers), "offer_identity_change", "Photo refresh may not add or remove catalogue rows.")
    for offer in offers.values():
        require({k: v for k, v in offer.items() if k not in PHOTO_FIELDS} ==
                {k: v for k, v in before_offers[offer["id"]].items() if k not in PHOTO_FIELDS},
                "non_photo_change", "A non-photographic catalogue field changed.")
    require({k: v for k, v in catalogue.items() if k not in {"offers", "updatedAt"}} ==
            {k: v for k, v in original_catalogue.items() if k not in {"offers", "updatedAt"}},
            "non_photo_change", "Photo refresh may not change the catalogue source policy or other metadata.")
    report["dataChanged"] = catalogue != original_catalogue
    if report["dataChanged"]:
        catalogue["updatedAt"] = now
    report["manifestChanged"] = manifest != original_manifest
    if report["manifestChanged"]:
        manifest["snapshotAt"] = now[:10]
    report["imageFilesChanged"] = len(pending)
    if not dry_run:
        if report["manifestChanged"]:
            pending[manifest_path] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if report["dataChanged"]:
            pending[catalogue_path] = (json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        if pending:
            require(catalogue_path.read_bytes() == catalogue_bytes and manifest_path.read_bytes() == manifest_bytes,
                    "concurrent_edit", "Catalogue or photo manifest changed during this run; retry without overwriting it.")
        commit_files(pending)
    if report["failed"]:
        report["status"] = "partial_failure" if report["checked"] else "failed"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--nursery")
    parser.add_argument("--offer-id")
    parser.add_argument("--fail-on-source-error", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = run_update(args.root, dry_run=args.dry_run, limit=args.limit,
                            nursery=args.nursery, offer_id=args.offer_id)
        code = 1 if args.fail_on_source_error and report["failed"] else 0
    except (PhotoError, OSError, ValueError, TypeError) as exc:
        report = {"status": "failed", "fatal": True, "reason": getattr(exc, "code", "invalid_data"),
                  "detail": str(exc), "dryRun": args.dry_run, "dataChanged": False}
        code = 2
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        atomic_write(args.report.resolve(), output.encode("utf-8"))
    print(output, end="")
    return code


if __name__ == "__main__":
    sys.exit(main())

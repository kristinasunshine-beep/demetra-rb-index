#!/usr/bin/env python3
"""Conservative Commons/GBIF discovery; never mutate catalogue data or assets.

Public interface: commons_candidates(), gbif_candidates(), download_candidate().
Candidates include a fixed download-host/path allowlist. Identity checks use
formatting normalization only: no fuzzy taxon match or cultivar fallback.
An empty list means no acceptable evidence; PhotoError means provider failure.
"""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener

from update_photos import (DEFAULT_LIMITS, FetchResult, PhotoError, SafeRedirects,
                           check_url, fetch_resource, identity_forms, require, to_jpeg)

USER_AGENT = ("DemetraPhotoBot/1.0 "
              "(https://github.com/kristinasunshine-beep/demetra-rb-index)")
COMMONS = "https://commons.wikimedia.org/w/api.php"
GBIF = "https://api.gbif.org/v1/"
IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}
# Raster files may still be scans, artwork, maps or specimen sheets. Such
# illustrations must never be counted as representative plant photographs.
NOT_PHOTO = re.compile(
    r"\b(?:eb\s*1911|illustrations?|drawings?|diagrams?|engravings?|"
    r"botanical[\s_-]+plates?|herbari(?:um|a)|maps?|logos?)\b", re.I)
BAD_TAXON_FLAGS = {"TAXON_MATCH_FUZZY", "TAXON_MATCH_HIGHERRANK", "TAXON_MATCH_NONE",
                   "TAXON_MATCH_AGGREGATE", "TAXON_MATCH_NAME_AND_ID_AMBIGUOUS",
                   "SCIENTIFIC_NAME_AND_ID_INCONSISTENT"}
# These are photograph descriptors, never accepted as an extra cultivar name.
PHOTO_SUFFIXES = frozenset("jpg jpeg png webp gif avif tree trees leaf leaves flower flowers "
                          "fruit fruits bark habit foliage autumn summer winter spring "
                          "detail closeup specimen overview img dsc dscn p photo photograph "
                          "botanical botanic garden arboretum branch branches stem trunk".split())


class _Text(HTMLParser):
    def __init__(self, value):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.feed(str(value or ""))

    def handle_data(self, value):
        self.parts.append(value)


def plain(value):
    return " ".join(html.unescape(" ".join(_Text(value).parts)).split())


def _tokens(value):
    forms = identity_forms(plain(value))
    return min(forms, key=lambda item: (len(item), item))


def _cultivars(value):
    # Curly quotes, ASCII single quotes, and double quotes delimit cultivars.
    text = plain(value).replace("‘", "'").replace("’", "'").replace("′", "'")
    return {_tokens(match) for match in re.findall(r"(?<!\w)['\"]([^'\"]+)['\"]", text)}


def identity_evidence(latin_name, evidence):
    """Return matching evidence, rejecting explicit same-genus/cultivar conflicts.

    A name must occur as a complete sequence, followed only by an image
    descriptor, a number or punctuation/end. A species-only name cannot match
    an unquoted cultivar appended to the name. This is deliberately conservative.
    """
    expected = _tokens(latin_name)
    if len(expected) < 2 or expected[1] in {"sp", "spp"}:
        return []
    texts = [plain(x) for x in evidence if isinstance(x, str) and x.strip()]
    expected_cultivars = _cultivars(latin_name)
    expected_species = expected[2] if len(expected) > 2 and expected[1] == "x" else expected[1]
    base_length = 3 if len(expected) > 2 and expected[1] == "x" else 2
    expected_tail = expected[base_length:]
    if not expected_cultivars and expected_tail and expected_tail[0] not in {"var", "subsp", "ssp", "f", "forma"}:
        expected_cultivars = {expected_tail}
    for value in texts:
        quoted = _cultivars(value)
        if quoted and (not expected_cultivars or not quoted.issubset(expected_cultivars)):
            return []
        # A file naming a different species of the same genus is contradictory.
        for species in re.findall(r"\b" + re.escape(expected[0]) + r"[ _]+(?:[x×][ _]+)?([a-z-]+)\b",
                                  value, flags=re.I):
            if species.casefold() != expected_species:
                return []
        # Nursery-style/file-name cultivars are often unquoted. Any capitalized
        # cultivar-looking word directly after the species must agree too.
        pattern = (r"(?i:\b" + re.escape(expected[0]) + r"[ _]+(?:[x×][ _]+)?" +
                   re.escape(expected_species) + r")[ _]+([A-Z][A-Za-z-]*(?:[ _]+[A-Z][A-Za-z-]*)*)")
        for unquoted in re.findall(pattern, value):
            cultivar = _tokens(unquoted.replace("_", " "))
            if len(cultivar) == 1 and len(cultivar[0]) == 1:
                continue  # Botanical author initial (e.g. Acer campestre L.).
            if cultivar and cultivar[0] not in PHOTO_SUFFIXES:
                if not expected_tail or cultivar[:len(expected_tail)] != expected_tail:
                    return []
                if len(cultivar) > len(expected_tail) and cultivar[len(expected_tail)] not in PHOTO_SUFFIXES:
                    return []
    accepted = []
    for value in texts:
        tokens = _tokens(value.replace("_", " "))
        for start in range(max(0, len(tokens) - len(expected) + 1)):
            end = start + len(expected)
            if tokens[start:end] != expected:
                continue
            if end == len(tokens) or tokens[end].isdigit() or tokens[end] in PHOTO_SUFFIXES:
                accepted.append(value)
                break
    return accepted


def _limits(value):
    result = dict(DEFAULT_LIMITS)
    result.update(value or {})
    return result


def fetch_api(url, *, hosts, max_bytes, timeout, kind="api", path_prefixes=None):
    """Bounded HTTPS JSON request with identified UA and checked redirects."""
    check = lambda target: check_url(target, hosts, path_prefixes)
    check(url)
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                                   "Accept-Encoding": "identity"})
    for attempt in range(3):
        try:
            start = time.monotonic()
            with build_opener(SafeRedirects(check)).open(request, timeout=timeout) as response:
                check(response.url)
                length = response.headers.get("Content-Length")
                require(not length or not length.isdigit() or int(length) <= max_bytes,
                        "response_too_large", "Photo API response exceeds the byte limit.")
                body = bytearray()
                while True:
                    require(time.monotonic() - start <= timeout, "timeout", "Photo API response timed out.")
                    chunk = response.read(min(65536, max_bytes + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                    require(len(body) <= max_bytes, "response_too_large", "Photo API response exceeds the byte limit.")
                return FetchResult(bytes(body), response.url, response.headers.get_content_type().lower())
        except HTTPError as exc:
            delay = exc.headers.get("Retry-After", "") if exc.headers else ""
            if exc.code in (429, 503) and attempt < 2 and delay.isdigit() and int(delay) <= 30:
                time.sleep(max(1, int(delay)))
                continue
            raise PhotoError("api_http_error", f"Photo API returned HTTP {exc.code}.") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise PhotoError("api_download_failed", str(exc)) from exc
    raise PhotoError("api_download_failed", "Photo API retry limit reached.")


def _json(url, fetcher, limits):
    host = urlsplit(url).hostname
    prefixes = {"commons.wikimedia.org": ["/w/api.php"], "api.gbif.org": ["/v1/"]}
    check_url(url, {"commons.wikimedia.org", "api.gbif.org"}, prefixes)
    result = (fetcher or fetch_api)(url, hosts={host}, max_bytes=limits["maxPageBytes"],
                                   timeout=limits["timeout"], kind="api", path_prefixes=prefixes)
    check_url(result.url, {host}, prefixes)
    require(len(result.body) <= limits["maxPageBytes"], "response_too_large", "Photo API response exceeds the byte limit.")
    require(result.content_type.split(";")[0] in {"application/json", "text/json"},
            "invalid_api_response", "Photo API did not return JSON.")
    try:
        value = json.loads(result.body)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PhotoError("invalid_api_response", "Photo API JSON is malformed.") from exc
    require(isinstance(value, dict), "invalid_api_response", "Photo API JSON must be an object.")
    require(not value.get("error"), "api_error", "Photo API reported an error.")
    return value


def _meta(metadata, key):
    value = metadata.get(key, {})
    return plain(value.get("value", "")) if isinstance(value, dict) else ""


def _false(value):
    return str(value).strip().casefold() in {"false", "0", "no"}


def public_domain_license(license_value):
    """Recognize explicit CC0/PD values, never substring matches or a dataset license."""
    value = plain(license_value).strip()
    normalized = value.casefold().rstrip("/")
    if normalized in {"cc0", "cc0 1.0", "cc0_1_0", "cc0 1.0 universal"}:
        return "CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"
    if normalized in {"public domain", "public domain mark", "public domain mark 1.0"}:
        return "Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"
    if normalized == "https://commons.wikimedia.org/wiki/help:public_domain":
        return "Public domain", "https://commons.wikimedia.org/wiki/Help:Public_domain"
    try:
        parsed = urlsplit(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname in {"creativecommons.org", "www.creativecommons.org"} and not parsed.username and not parsed.password and parsed.port in {None, 80, 443} and not parsed.query and not parsed.fragment:
            path = parsed.path.rstrip("/").casefold()
            if path == "/publicdomain/zero/1.0":
                return "CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"
            if path == "/publicdomain/mark/1.0":
                return "Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"
    except ValueError:
        pass
    return None


def commons_candidates(latin_name, *, fetcher=None, limits=None, max_candidates=10):
    limits = _limits(limits)
    count = max(1, min(20, int(max_candidates)))
    # Quoted components narrow the candidate set; evidence must still validate.
    query = '"' + plain(latin_name).replace('"', "'") + '"'
    url = COMMONS + "?" + urlencode({"action": "query", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": query, "gsrlimit": count, "prop": "imageinfo",
        "iiprop": "url|mime|size|extmetadata", "iiurlwidth": limits["maxSide"],
        "format": "json", "formatversion": 2, "iiextmetadatalanguage": "en", "maxlag": 5})
    response = _json(url, fetcher, limits)
    result = []
    query_result = response.get("query", {})
    require(isinstance(query_result, dict), "invalid_api_response", "Commons query result must be an object.")
    pages = query_result.get("pages", [])
    require(isinstance(pages, list), "invalid_api_response", "Commons pages result must be an array.")
    for page in pages[:count]:
        if not isinstance(page, dict):
            continue
        info = page.get("imageinfo")
        if not isinstance(info, list) or not info or not isinstance(info[0], dict):
            continue
        photo = info[0]
        metadata = photo.get("extmetadata", {})
        if not isinstance(metadata, dict) or photo.get("mime") not in IMAGE_MIMES:
            continue
        photo_description = " ".join([plain(page.get("title", "")), _meta(metadata, "ObjectName"),
                                      _meta(metadata, "ImageDescription"), _meta(metadata, "Categories")])
        if NOT_PHOTO.search(photo_description.replace("_", " ")):
            continue
        if _meta(metadata, "DeletionReason") or _meta(metadata, "Restrictions"):
            continue
        if _meta(metadata, "NonFree") and not _false(_meta(metadata, "NonFree")):
            continue
        if not _false(_meta(metadata, "AttributionRequired")):
            continue
        license_url, license_short = _meta(metadata, "LicenseUrl"), _meta(metadata, "LicenseShortName")
        license_info = public_domain_license(license_url)
        short = public_domain_license(license_short)
        if (license_url and not license_info) or (license_short and not short):
            continue
        if not license_info:
            license_info = short
        if not license_info or (short and short[0] != license_info[0]):
            continue
        if license_info[0] == "Public domain" and not _false(_meta(metadata, "Copyrighted")):
            continue
        evidence = identity_evidence(latin_name, [page.get("title", ""), _meta(metadata, "ObjectName"),
                                                 _meta(metadata, "ImageDescription")])
        if not evidence:
            continue
        image_url = photo.get("thumburl") or photo.get("url")
        source_url = photo.get("descriptionurl")
        try:
            check_url(image_url, {"upload.wikimedia.org"}, {"upload.wikimedia.org": ["/wikipedia/commons/"]})
            check_url(source_url, {"commons.wikimedia.org"}, {"commons.wikimedia.org": ["/wiki/File:"]})
            require(int(photo.get("width", 0)) >= 300 and int(photo.get("height", 0)) >= 200,
                    "image_too_small", "Source photograph is too small.")
        except (PhotoError, TypeError, ValueError):
            continue
        result.append({"provider": "commons", "imageUrl": image_url, "sourceUrl": source_url,
                       "matchedName": latin_name, "identityEvidence": evidence,
                       "license": license_info[0], "licenseUrl": license_info[1],
                       "imageHosts": ["upload.wikimedia.org"],
                       "imagePathPrefixes": {"upload.wikimedia.org": ["/wikipedia/commons/"]}})
    return result


def _species_name(latin_name):
    # Only unambiguous binomials (including x hybrids) can enter GBIF lookup.
    match = re.match(r"^\s*([A-Z][a-z]+)\s+([x×]\s+)?([a-z][a-z-]+)\b", plain(latin_name))
    if not match:
        return None
    return match.group(1) + " " + ("x " if match.group(2) else "") + match.group(3)


def gbif_candidates(latin_name, *, fetcher=None, limits=None, max_candidates=10):
    limits = _limits(limits)
    species = _species_name(latin_name)
    if not species:
        return []
    match_url = GBIF + "species/match?" + urlencode({"name": species, "kingdom": "Plantae", "strict": "true"})
    match = _json(match_url, fetcher, limits)
    if (match.get("matchType") != "EXACT" or match.get("rank") != "SPECIES" or
            match.get("kingdom") != "Plantae" or _tokens(match.get("canonicalName", "")) != _tokens(species)):
        return []
    key = match.get("acceptedUsageKey") or match.get("usageKey")
    if not isinstance(key, int) or isinstance(key, bool) or key <= 0:
        return []
    count = max(1, min(20, int(max_candidates)))
    search_url = GBIF + "occurrence/search?" + urlencode({"taxonKey": key, "mediaType": "StillImage",
        "basisOfRecord": "HUMAN_OBSERVATION", "limit": min(100, count * 10)})
    response = _json(search_url, fetcher, limits)
    result = []
    records = response.get("results", [])
    require(isinstance(records, list), "invalid_api_response", "GBIF results must be an array.")
    for record in records[:100]:
        if not isinstance(record, dict):
            continue
        issues = record.get("issues", [])
        if not isinstance(issues, list) or any(issue in BAD_TAXON_FLAGS for issue in issues if isinstance(issue, str)):
            continue
        if record.get("speciesKey") != key or _tokens(record.get("species", "")) != _tokens(species):
            continue
        occurrence_id = record.get("key")
        if not isinstance(occurrence_id, int) or isinstance(occurrence_id, bool) or occurrence_id <= 0:
            continue
        media_items = record.get("media", [])
        if not isinstance(media_items, list):
            continue
        for media in media_items:
            if not isinstance(media, dict) or media.get("type") != "StillImage":
                continue
            if media.get("format") and media["format"].split(";")[0] not in IMAGE_MIMES:
                continue
            license_info = public_domain_license(media.get("license", ""))
            if not license_info:
                continue
            evidence = identity_evidence(latin_name, [record.get("verbatimScientificName", ""),
                record.get("scientificName", ""), record.get("species", ""),
                media.get("title", ""), media.get("description", "")])
            if not evidence:
                continue
            identifier = media.get("identifier", "")
            try:
                parsed = urlsplit(identifier)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.port not in {None, 80, 443}:
                    continue
            except (TypeError, ValueError):
                continue
            # Never download arbitrary URLs supplied by occurrence publishers.
            # The official cache isolates provider hosts and limits image size.
            digest = hashlib.md5(identifier.encode("utf-8"), usedforsecurity=False).hexdigest()
            image_url = GBIF + f"image/cache/1200x/occurrence/{occurrence_id}/media/{digest}"
            result.append({"provider": "gbif", "imageUrl": image_url,
                "sourceUrl": f"https://www.gbif.org/occurrence/{occurrence_id}", "matchedName": latin_name,
                "identityEvidence": evidence, "license": license_info[0], "licenseUrl": license_info[1],
                "imageHosts": ["api.gbif.org"], "imagePathPrefixes": {"api.gbif.org": ["/v1/image/cache/"]}})
            if len(result) >= count:
                return result
    return result


def download_candidate(candidate, *, fetcher=None, limits=None):
    """Download only a provider-approved URL and return a validated JPEG."""
    limits = _limits(limits)
    # Reconstruct allowlists from provider, never trust mutable candidate fields.
    if candidate.get("provider") == "commons":
        hosts, prefixes = {"upload.wikimedia.org"}, {"upload.wikimedia.org": ["/wikipedia/commons/"]}
    elif candidate.get("provider") == "gbif":
        hosts, prefixes = {"api.gbif.org"}, {"api.gbif.org": ["/v1/image/cache/"]}
    else:
        raise PhotoError("unapproved_source", "Unknown open-photo provider.")
    check_url(candidate.get("imageUrl"), hosts, prefixes)
    response = (fetcher or fetch_resource)(candidate["imageUrl"], hosts=hosts,
        max_bytes=limits["maxImageBytes"], timeout=limits["timeout"], kind="image", path_prefixes=prefixes)
    check_url(response.url, hosts, prefixes)
    require(response.content_type.split(";")[0] in IMAGE_MIMES, "invalid_image", "Photo source did not return an image.")
    return to_jpeg(response.body, limits)

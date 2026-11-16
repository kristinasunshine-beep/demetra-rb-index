"""Recognize observed LvE Shopware variant URLs without weakening taxon checks.

Reviewed source: https://www.lve-baumschule.de/service/impressum/
Canonical catalogue pages use /full-botanical-slug/numeric-parent-id. Their
Open Graph URLs identify a selected stock variant, either by its exact JSON-LD
Product SKU or by an internal UUID explicitly present in both that Product's
offers and the page's product form. The only source-specific name formatting
accepted is LvE's explicit terminal " -R-" trademark marker.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

OFFICIAL_HOST = 'www.lve-baumschule.de'


def matches_lve_name(value, expected, *, title=False):
    """Match an exact name after removing only a terminal spaced '-R-' marker."""
    from update_photos import clean, identity_matches
    source = clean(value)
    if title:
        source = re.split(r'\s+[|–—]\s+', source, maxsplit=1)[0]
    source = re.sub(r'\s+-R-\s*$', '', source)
    return identity_matches(source, expected)


def _offer_urls(value, depth=0):
    if depth > 8:
        return []
    if isinstance(value, list):
        return [url for item in value for url in _offer_urls(item, depth + 1)]
    if not isinstance(value, dict):
        return []
    urls = [value['url']] if isinstance(value.get('url'), str) else []
    return urls + _offer_urls(value.get('offers'), depth + 1)


def same_product_variant(doc, objects, page_url, candidate_url, latin_name):
    """True only for a variant explicitly bound to this exact LvE product.

    The caller must restrict use to the Lorenz von Ehren nursery policy. Keep
    ordinary canonical checks and photograph identity validation in the caller.
    Lazy imports avoid a module cycle when update_photos imports this helper.
    """
    from update_photos import clean, has_type, url_key

    try:
        page, candidate = urlsplit(page_url), urlsplit(candidate_url)
        if not all(p.scheme == 'https' and p.hostname == OFFICIAL_HOST and
                   not p.username and not p.password and p.port in (None, 443)
                   and not p.query and not p.fragment for p in (page, candidate)):
            return False
        if not re.fullmatch(r'/[a-z0-9-]+/[0-9]+/?', page.path):
            return False
        canonicals = [node.attrs.get('href', '') for node in doc.nodes
                      if node.tag == 'link' and 'canonical' in node.attrs.get('rel', '').split()]
        if len(canonicals) != 1 or url_key(canonicals[0]) != url_key(page_url):
            return False
        headings = [node.text() for node in doc.nodes if node.tag == 'h1'
                    and not node.excluded() and node.text()]
        if not headings or not all(matches_lve_name(name, latin_name, title=True) for name in headings):
            return False
        products = [obj for obj in objects if isinstance(obj, dict) and has_type(obj, 'Product')
                    and matches_lve_name(obj.get('name', ''), latin_name)]
        if not products:
            return False

        page_parts = page.path.strip('/').split('/')
        variant_parts = candidate.path.strip('/').split('/')
        if (len(variant_parts) == 2 and variant_parts[0] in (page_parts[0], page_parts[0] + '-r') and
                re.fullmatch(r'[A-Za-z0-9]+', variant_parts[1])):
            return any(str(product.get('sku', '')) == variant_parts[1] and
                       (variant_parts[0] == page_parts[0] or
                        bool(re.search(r'\s+-R-\s*$', clean(product.get('name', '')))))
                       for product in products)

        match = re.fullmatch(r'/detail/([0-9a-f]{32})', candidate.path)
        if not match:
            return False
        uuid = match.group(1)
        form_bound = any(node.tag == 'input' and not node.excluded() and
                         node.attrs.get('type') == 'hidden' and
                         node.attrs.get('name') == f'lineItems[{uuid}][id]' and
                         node.attrs.get('value') == uuid for node in doc.nodes)
        if not form_bound:
            return False
        return any(url_key(candidate_url) in {url_key(url) for url in _offer_urls(product.get('offers'))}
                   for product in products)
    except (TypeError, ValueError, AttributeError):
        return False

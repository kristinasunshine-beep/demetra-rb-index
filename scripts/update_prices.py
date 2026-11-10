#!/usr/bin/env python3
"""Update existing public catalogue prices from an explicit, reviewed URL allowlist.

Python 3.11+ standard library only. No discovery, login, cart, API writes, plant
creation, taxon substitution or conversion from package to individual prices.
"""
from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass, field
from datetime import date as calendar_date, datetime, timezone
from decimal import Decimal, InvalidOperation
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

POLICIES = {
    "biojela_woocommerce": ("biojela", {"biojela.rs", "www.biojela.rs"}, "/product/"),
    "vitorovic_shopify": ("rasadnik-vitorovic", {"rasadnik-vitorovic.shop", "www.rasadnik-vitorovic.shop"}, "/products/"),
    "lorberg_selected_variant": ("lorberg", {"www.lorberg.com", "lorberg.com"}, "/en-gb/article/"),
}
CURRENCIES = {"RSD", "EUR"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class UpdateError(Exception):
    def __init__(self, code, detail):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def clean(value):
    return " ".join(html.unescape(str(value)).split())


def literal(value):
    """Case/Unicode/whitespace normalization only; no fuzzy plant-name matching."""
    return clean(unicodedata.normalize("NFKC", str(value))).casefold()


def url_key(value):
    p = urlsplit(value)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), p.query, ""))


def product_url_key(value):
    p = urlsplit(value)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), "", ""))


def require(condition, code, detail):
    if not condition:
        raise UpdateError(code, detail)


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: "Node | None" = field(default=None, repr=False)

    def has_class(self, name):
        return name in self.attrs.get("class", "").split()

    def walk(self):
        stack = [self]
        while stack:
            node = stack.pop()
            yield node
            stack.extend(reversed([c for c in node.children if isinstance(c, Node)]))

    def text(self):
        parts, stack = [], list(reversed(self.children))
        while stack:
            value = stack.pop()
            if isinstance(value, str):
                parts.append(value)
            elif value.tag not in {"script", "style"}:
                stack.extend(reversed(value.children))
        return "".join(parts)

    def raw_text(self):
        return "".join(c for c in self.children if isinstance(c, str))

    def below_tag(self, tag, boundary):
        node = self.parent
        while node and node is not boundary:
            if node.tag == tag:
                return True
            node = node.parent
        return False

    def inside_nested_product(self, boundary):
        node = self.parent
        while node and node is not boundary:
            if node.has_class("product"):
                return True
            node = node.parent
        return False


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), parent=self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def exactly_one(items, code, detail):
    values = list(items)
    require(len(values) == 1, code, detail)
    return values[0]


def decimal_price(value):
    require(not isinstance(value, bool), "invalid_price", "Boolean is not a price.")
    text = str(value).strip()
    require(bool(re.fullmatch(r"\d{1,12}(?:\.\d{1,4})?", text)), "invalid_price", "Price is missing, nonnumeric or has an unsupported decimal format.")
    try:
        amount = Decimal(text)
    except InvalidOperation as error:
        raise UpdateError("invalid_price", "Invalid decimal price.") from error
    require(amount.is_finite() and amount > 0, "nonpositive_price", "Zero and negative prices are not published as offers.")
    return amount


def localized_price(value, locale):
    text = re.sub(r"\s+", "", clean(value))
    if locale == "sr":
        require(bool(re.fullmatch(r"(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?", text)), "price_format_changed", "Unexpected Serbian price formatting.")
        return decimal_price(text.replace(".", "").replace(",", "."))
    require(bool(re.fullmatch(r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?", text)), "price_format_changed", "Unexpected English price formatting.")
    return decimal_price(text.replace(",", ""))


def currency(value, expected):
    observed = clean(value).upper()
    require(observed in CURRENCIES, "unknown_currency", "Source currency is absent or unsupported.")
    require(observed == expected, "currency_changed", "Source currency differs from the reviewed mapping.")
    return observed


def woo_money(container, expected_currency):
    result = []
    for node in container.walk():
        if not node.has_class("woocommerce-Price-amount") or node.below_tag("del", container):
            continue
        symbols = [n for n in node.walk() if n.has_class("woocommerce-Price-currencySymbol")]
        symbol = exactly_one(symbols, "unknown_currency", "Each WooCommerce amount must have an explicit currency.")
        cur = currency(symbol.text(), expected_currency)
        text = clean(node.text())
        numeric = text.replace(clean(symbol.text()), "").strip()
        result.append((localized_price(numeric, "sr"), cur, text))
    require(bool(result), "price_missing", "No current WooCommerce amount in the product price block.")
    return result


def json_objects(value):
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            yield item
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def has_type(value, expected):
    types = value.get("@type", [])
    if isinstance(types, str):
        types = [types]
    return any(t.rsplit("/", 1)[-1] == expected for t in types if isinstance(t, str))


def products(document):
    result = []
    for node in document.root.walk():
        if node.tag != "script" or node.attrs.get("type", "").lower() != "application/ld+json":
            continue
        try:
            data = json.loads(node.raw_text())
        except (ValueError, TypeError):
            continue
        result.extend(x for x in json_objects(data) if has_type(x, "Product"))
    return result


def stock_state(value):
    text = re.sub(r"\s+", "", str(value or "")).rsplit("/", 1)[-1]
    return {"InStock": "in_stock", "OutOfStock": "out_of_stock", "SoldOut": "out_of_stock", "PreOrder": "preorder", "BackOrder": "backorder", "Discontinued": "discontinued"}.get(text)


@dataclass
class Observation:
    amount: Decimal
    currency: str
    raw: str
    availability: str
    tax_status: str = "PDV nije naveden"
    pack_count: int | None = None
    unit_basis: str = "catalogue_unit"
    variant_id: str | None = None
    variant_url: str | None = None
    source_valid_until: str | None = None


def biojela(document, source):
    expected = source["expected"]
    headings = [clean(n.text()) for n in document.root.walk() if n.tag == "h1"]
    require(len(headings) == 1 and literal(headings[0]) == literal(expected["productName"]), "product_identity_changed", "BIOJela product heading no longer exactly matches the reviewed name.")
    # Avada puts the primary price in a dedicated fusion-woo-price-tb block;
    # related product cards and header/cart prices are deliberately excluded.
    blocks = [n for n in document.root.walk() if n.has_class("fusion-woo-price-tb")]
    block = exactly_one(blocks, "price_block_changed", "Expected one primary BIOJela product-price block.")
    price_block = exactly_one((n for n in block.walk() if n.tag == "p" and n.has_class("price")), "price_block_changed", "Primary product price is missing or ambiguous.")
    main_money = woo_money(price_block, expected["currency"])
    forms = [n for n in document.root.walk() if "data-product_variations" in n.attrs]
    variant_id = expected.get("variantId")
    if variant_id:
        form = exactly_one(forms, "variant_data_missing", "Expected one embedded WooCommerce variation form.")
        try:
            variants = json.loads(form.attrs["data-product_variations"])
        except (TypeError, ValueError) as error:
            raise UpdateError("variant_data_invalid", "Embedded variation JSON could not be read.") from error
        require(isinstance(variants, list) and all(isinstance(v, dict) for v in variants), "variant_data_missing", "Variations are no longer embedded as objects; no secondary request is made.")
        variant = exactly_one((v for v in variants if str(v.get("variation_id")) == str(variant_id)), "variant_identity_changed", "Configured variation ID is absent or duplicated.")
        require(variant.get("variation_is_visible", True) is True, "variant_not_visible", "The configured variation is no longer publicly visible.")
        labels = {}
        for select in (n for n in form.walk() if n.tag == "select" and n.attrs.get("name")):
            labels[select.attrs["name"]] = {n.attrs.get("value"): clean(n.text()) for n in select.walk() if n.tag == "option" and n.attrs.get("value")}
        actual = {}
        attributes = variant.get("attributes")
        require(isinstance(attributes, dict), "variant_labels_missing", "Variation attributes are missing.")
        for name, value in attributes.items():
            require(bool(value) and value in labels.get(name, {}), "variant_labels_missing", "A variation attribute has no exact visible option label.")
            actual[name] = labels[name][value]
        wanted = expected.get("variantAttributes", {})
        require(bool(wanted) and {k: literal(v) for k, v in actual.items()} == {k: literal(v) for k, v in wanted.items()}, "variant_specification_changed", "The variation dimensions/options no longer match the reviewed item.")
        amount = decimal_price(variant.get("display_price"))
        if variant.get("price_html"):
            money = woo_money(Document(variant["price_html"]).root, expected["currency"])
            require({x[0] for x in money} == {amount}, "price_disagreement", "Embedded numeric price and current visible variation price disagree.")
            raw = money[0][2]
        else:
            # Single-price variations may omit price_html. The visible primary
            # amount must then agree exactly; a range is not a single price.
            require({x[0] for x in main_money} == {amount}, "price_disagreement", "A variation without its own price block does not match the sole primary price.")
            raw = main_money[0][2]
        stock = variant.get("is_in_stock")
        require(stock is None or isinstance(stock, bool), "stock_data_invalid", "Variation stock value changed type.")
        state = "not_confirmed" if stock is None else "in_stock" if stock else "out_of_stock"
        return Observation(amount, expected["currency"], raw, state, variant_id=str(variant_id))
    require(not forms, "variant_selection_required", "The product now has variants; a simple-product mapping cannot select one.")
    require(len({x[0] for x in main_money}) == 1, "ambiguous_price_range", "A range cannot replace a single item price.")
    ancestors = []
    parent = price_block.parent
    while parent:
        if parent.has_class("product") and re.fullmatch(r"(?:post|product)-\d+", parent.attrs.get("id", "")):
            ancestors.append(parent)
        parent = parent.parent
    primary = exactly_one(ancestors, "product_container_changed", "Expected one primary WooCommerce product container.")
    stock_nodes = [n for n in primary.walk() if n.tag == "p" and n.has_class("stock") and not n.inside_nested_product(primary)]
    states = {"out_of_stock" if n.has_class("out-of-stock") else "in_stock" if n.has_class("in-stock") else "unknown" for n in stock_nodes}
    if primary.has_class("instock"):
        states.add("in_stock")
    if primary.has_class("outofstock"):
        states.add("out_of_stock")
    require(len(states - {"unknown"}) <= 1, "stock_data_conflict", "Primary-product stock statements conflict.")
    states.discard("unknown")
    amount, cur, raw = main_money[0]
    return Observation(amount, cur, raw, states.pop() if states else "not_confirmed")


def vitorovic(document, source):
    expected = source["expected"]
    product = exactly_one((p for p in products(document) if literal(p.get("name", "")) == literal(expected["productName"]) and product_url_key(p.get("url", "")) == product_url_key(source["url"])), "product_identity_changed", "Vitorović Product JSON-LD no longer matches the exact reviewed product.")
    offers = product.get("offers", [])
    if isinstance(offers, dict):
        offers = [offers]
    require(isinstance(offers, list), "variant_data_invalid", "Product offers are not a structured offer list.")
    target_url = expected.get("variantUrl", "")
    offer = exactly_one((o for o in offers if isinstance(o, dict) and has_type(o, "Offer") and url_key(o.get("url", "")) == url_key(target_url)), "variant_identity_changed", "Exact Shopify variant offer is absent or ambiguous.")
    cur = currency(offer.get("priceCurrency", ""), expected["currency"])
    amount = decimal_price(offer.get("price"))
    state = stock_state(offer.get("availability")) or "not_confirmed"
    variant = parse_qs(urlsplit(target_url).query).get("variant", [])
    require(len(variant) == 1 and variant[0].isdigit(), "invalid_variant_url", "A single explicit Shopify variant ID is required.")
    description_source = product.get("description", "")
    require(isinstance(description_source, str), "package_changed", "Product description is not readable text.")
    description = clean(Document(description_source).root.text())
    counts = {int(x) for x in re.findall(r"Broj sadnica po kontejneru\s*:\s*(\d+)", description, re.I)}
    for option in (n for n in document.root.walk() if n.tag == "option" and n.attrs.get("value") == variant[0]):
        counts.update(int(x) for x in re.findall(r"Kontejner\s*[-–]\s*(\d+)\s*sadnic", clean(option.text()), re.I))
    expected_count = expected["unit"].get("count")
    require(expected["unit"]["kind"] == "package" and counts == {expected_count}, "package_changed", "Selected package count is absent, ambiguous or different from the reviewed package.")
    tax = "PDV nije naveden"
    spec = offer.get("priceSpecification", {})
    if isinstance(spec, dict) and isinstance(spec.get("valueAddedTaxIncluded"), bool):
        tax = clean(spec.get("name")) if spec.get("name") else ("PDV je uključen" if spec["valueAddedTaxIncluded"] else "PDV nije uključen")
    return Observation(amount, cur, str(offer["price"]), state, tax, expected_count, "package", variant[0], target_url, offer.get("priceValidUntil"))


def lorberg(document, source):
    expected = source["expected"]
    headings = [clean(n.text()) for n in document.root.walk() if n.tag == "h1"]
    require(len(headings) == 1 and literal(headings[0]) == literal(expected["productName"]), "product_identity_changed", "Lorberg product name changed.")
    panel = exactly_one((n for n in document.root.walk() if n.attrs.get("id") == "ArticleInfo_ArticleKey"), "variant_panel_missing", "Lorberg selected-variant panel missing.")
    selected = exactly_one((n for n in panel.walk() if n.tag == "a" and n.has_class("dropdown-item") and n.has_class("active")), "variant_selection_changed", "Lorberg active selection is absent or ambiguous.")
    require(selected.attrs.get("id") == str(expected.get("variantId")), "variant_identity_changed", "The page default is a different variation; no variant-switch request is made.")
    require(literal(selected.text()) == literal(expected.get("variantLabel", "")), "variant_specification_changed", "Lorberg selected size/form no longer matches the reviewed label.")
    area = exactly_one((n for n in panel.walk() if n.has_class("priceAreaRow")), "price_block_changed", "Selected variant price area is missing.")
    amount_node = exactly_one((n for n in area.walk() if n.has_class("price")), "price_block_changed", "Selected price is missing or ambiguous.")
    qty = exactly_one((n for n in area.walk() if n.tag == "input" and n.attrs.get("id") == "qty"), "quantity_missing", "The price quantity is not explicit.")
    require(qty.attrs.get("value") == "1", "quantity_changed", "Selected price is no longer for quantity one.")
    raw = clean(amount_node.text())
    require(raw.startswith("€"), "unknown_currency", "Selected Lorberg price does not explicitly state EUR.")
    cur = currency("EUR", expected["currency"])
    amount = localized_price(raw[1:], "en")
    tax_node = exactly_one((n for n in area.walk() if n.has_class("tax-text")), "tax_basis_missing", "Selected variant tax statement is missing.")
    tax = clean(tax_node.text())
    require(bool(re.fullmatch(r"(?:Incl\.|Excl\.)\s*\d+(?:[.,]\d+)?%\s*VAT\.?", tax, re.I)), "tax_basis_changed", "Tax statement changed format and requires review.")
    # Product JSON-LD includes many variants without IDs. It is never used to
    # choose the price, default quantity or a substitute variation.
    return Observation(amount, cur, raw, "not_confirmed", tax, unit_basis="catalogue_unit", variant_id=str(expected["variantId"]))


ADAPTERS = {"biojela_woocommerce": biojela, "vitorovic_shopify": vitorovic, "lorberg_selected_variant": lorberg}


def validate_url(url, adapter):
    require(isinstance(url, str), "invalid_url", "A source URL must be a string.")
    p = urlsplit(url)
    _, hosts, prefix = POLICIES[adapter]
    require(p.scheme == "https" and p.hostname in hosts and p.port in {None, 443} and not p.username and not p.password and not p.fragment and p.path.startswith(prefix), "url_not_allowed", "Only the reviewed supplier's HTTPS product paths are allowed.")


class SameProductRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(url_key(req.full_url) == url_key(newurl), "redirect_changed_identity", "The source redirected to another URL; old price is preserved.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PublicFetcher:
    def __init__(self, timeout=20, max_bytes=5000000, delay=1.25):
        self.timeout, self.max_bytes, self.delay = timeout, max_bytes, delay
        self.last_request = 0.0
        self.opener = build_opener(SameProductRedirect())

    def __call__(self, url):
        remaining = self.delay - (time.monotonic() - self.last_request)
        if remaining > 0:
            time.sleep(remaining)
        self.last_request = time.monotonic()
        try:
            request = Request(url, headers={"User-Agent": "demetra-rb-index/1.0 (bounded public catalogue price check)", "Accept": "text/html,application/xhtml+xml"})
            with self.opener.open(request, timeout=self.timeout) as response:
                require(response.status == 200, "http_status", "Source did not return HTTP 200.")
                require(url_key(response.geturl()) == url_key(url), "redirect_changed_identity", "Final response URL changed.")
                content_type = response.headers.get_content_type()
                require(content_type in {"text/html", "application/xhtml+xml"}, "unexpected_content_type", "Expected a public HTML product page.")
                data = response.read(self.max_bytes + 1)
                require(len(data) <= self.max_bytes, "response_too_large", "Source response exceeded the configured byte limit.")
                return data.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
        except HTTPError as error:
            raise UpdateError("http_error", f"HTTP {error.code}; no retries or alternative endpoints used.") from error
        except (URLError, TimeoutError, OSError) as error:
            raise UpdateError("network_error", f"Public GET failed: {type(error).__name__}.") from error


def validate_config(config):
    require(isinstance(config, dict) and config.get("schemaVersion") == 1, "config_invalid", "Expected price-sources schemaVersion 1.")
    scope = config.get("scope", {})
    require(isinstance(scope, dict), "config_invalid", "scope must be an object.")
    require(scope.get("origin") == "private_offer", "config_invalid", "Scope must explicitly be private_offer plant targets.")
    for key in ["allowedPlantIds", "allowedNurseryIds"]:
        value = scope.get(key)
        require(isinstance(value, list) and all(isinstance(x, str) and x for x in value) and len(value) == len(set(value)), "config_invalid", f"scope.{key} must be a unique ID list.")
    sources = config.get("sources")
    require(isinstance(sources, list), "config_invalid", "sources must be an array.")
    ids, offer_ids = set(), set()
    for s in sources:
        require(isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"] not in ids, "config_invalid", "Each source needs a unique ID.")
        ids.add(s["id"])
        require(isinstance(s.get("enabled", True), bool), "config_invalid", "enabled must be boolean.")
        if not s.get("enabled", True):
            require(bool(s.get("reason")), "config_invalid", "Disabled sources must state a reason.")
            continue
        for key in ["offerId", "plantId", "nurseryId", "adapter", "url", "offerSourceUrl"]:
            require(isinstance(s.get(key), str) and bool(s[key]), "config_invalid", f"Source is missing {key}.")
        require(s["offerId"] not in offer_ids, "config_invalid", "Two sources may not mutate the same offer.")
        offer_ids.add(s["offerId"])
        require(s["adapter"] in ADAPTERS, "config_invalid", "Unknown adapter.")
        require(s["nurseryId"] == POLICIES[s["adapter"]][0], "config_invalid", "Adapter and nursery identity differ.")
        validate_url(s["url"], s["adapter"])
        validate_url(s["offerSourceUrl"], s["adapter"])
        expected = s.get("expected", {})
        require(isinstance(expected, dict), "config_invalid", "expected must be an object.")
        require(isinstance(expected.get("productName"), str) and expected["productName"], "config_invalid", "A literal reviewed product name is required.")
        require(expected.get("currency") in CURRENCIES, "config_invalid", "Explicit RSD or EUR source currency required.")
        unit = expected.get("unit", {})
        require(isinstance(unit, dict), "config_invalid", "expected.unit must be an object.")
        require(unit.get("kind") in {"catalogue_unit", "package"} and isinstance(unit.get("label"), str) and bool(unit["label"]), "config_invalid", "An explicit unit kind and display label are required.")
        if unit["kind"] == "package":
            require(type(unit.get("count")) is int and unit["count"] > 0, "config_invalid", "A positive package count is required.")
        evidence = s.get("evidence", {})
        require(isinstance(evidence, dict), "config_invalid", "evidence must be an object.")
        require(isinstance(evidence.get("sourceUrl"), str) and evidence["sourceUrl"] and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(evidence.get("reviewedAt", "")))), "config_invalid", "Source mapping needs its reviewed public URL and review date.")
    limits = config.get("limits", {})
    require(isinstance(limits, dict), "config_invalid", "limits must be an object.")
    require(type(limits.get("maxUrls", 40)) is int and 0 < limits.get("maxUrls", 40) <= 100, "config_invalid", "maxUrls must be between 1 and 100.")
    require(1 <= limits.get("timeoutSeconds", 20) <= 30 and 0.25 <= limits.get("requestDelaySeconds", 1.25) <= 10 and 1000 <= limits.get("maxResponseBytes", 5000000) <= 10000000, "config_invalid", "Network limits are outside the bounded range.")


def binding(source, offer, config):
    scope = config["scope"]
    require(offer is not None, "offer_missing", "Mapped offer does not exist; updater never creates it.")
    require(source["plantId"] in scope["allowedPlantIds"] and source["nurseryId"] in scope["allowedNurseryIds"], "outside_scope", "Mapping is outside the reviewed plant/nursery allowlists.")
    require(offer.get("plantId") == source["plantId"] and offer.get("nurseryId") == source["nurseryId"], "offer_identity_changed", "Offer ID now belongs to another plant or nursery.")
    require(not offer.get("demo"), "demo_offer", "Demo fixtures cannot receive live prices.")
    require(offer.get("priceKind") in {"public", "unpublished"}, "nonpublic_offer", "Only public catalogue records may be updated.")
    require(url_key(offer.get("sourceUrl", "")) == url_key(source["offerSourceUrl"]), "source_binding_changed", "Offer source URL differs from the reviewed binding.")
    require(product_url_key(source["url"]) == product_url_key(source["offerSourceUrl"]), "source_binding_changed", "Fetch URL and bound offer refer to different products.")
    require(not offer.get("sourceDate") and not offer.get("sourcePeriod"), "dated_offer_not_live_web", "Dated catalogues/seasonal offers require a separate reviewed source; not overwritten as live web prices.")
    require(literal(offer.get("unit", "")) == literal(source["expected"]["unit"]["label"]), "unit_binding_changed", "Offer unit differs from the reviewed unit.")
    require(not offer.get("currency") or offer["currency"] == source["expected"]["currency"], "currency_binding_changed", "Existing offer currency differs from the reviewed source currency.")


def observation_fields(observation, source, now):
    date = now[:10]
    state = {
        "in_stock": "Rasadnik navodi dostupnost",
        "out_of_stock": "Na javnoj stranici nije na stanju",
        "preorder": "Javna stranica navodi prednarudžbu",
        "backorder": "Javna stranica navodi naknadnu isporuku",
        "discontinued": "Javna stranica navodi da se proizvod više ne nudi",
        "not_confirmed": "Javna cena — stanje zaliha nije potvrđeno",
    }[observation.availability]
    number = int(observation.amount) if observation.amount == observation.amount.to_integral_value() else float(observation.amount)
    return {
        "price": number, "currency": observation.currency,
        "unit": source["expected"]["unit"]["label"], "priceKind": "public",
        "taxStatus": observation.tax_status, "checkedAt": date,
        "availability": f"{state} · provereno {date}",
        "priceObservation": {
            "observedAt": now, "sourcePublishedAt": None,
            "sourceUrl": source["url"], "variantId": observation.variant_id,
            "variantUrl": observation.variant_url, "raw": observation.raw,
            "basis": observation.unit_basis, "packCount": observation.pack_count,
            "publicPrice": True, "negotiatedProcurementPrice": False,
            "sourceValidUntil": observation.source_valid_until,
        },
    }


def update_document(document, config, fetcher, now=None, dry_run=False):
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    require(isinstance(document, dict) and document.get("schemaVersion") == 1 and isinstance(document.get("offers"), list), "data_invalid", "Expected the existing {schemaVersion:1, updatedAt, offers:[...]} catalogue.")
    if isinstance(document.get("sourcePolicy"), dict) and document["sourcePolicy"].get("nonPhoto") == "rasadnici-ponude-zip":
        # The supplied archive is authoritative. This guard also protects
        # against an older scheduled workflow still calling this script.
        return copy.deepcopy(document), {
            "schemaVersion": 1, "startedAt": now, "dryRun": bool(dry_run),
            "status": "disabled_by_source_policy", "scopeOrigin": "private_offer",
            "reason": "Cene i mere poticu iskljucivo iz Rasadnici ponude ZIP-a; online se osvezavaju samo fotografije.",
            "requests": 0, "checked": 0, "updated": 0, "verifiedUnchanged": 0,
            "failed": 0, "skipped": len(document["offers"]), "sources": [],
            "dataChanged": False, "successfulObservations": 0, "catalogueWritten": False,
        }
    validate_config(config)
    original = document["offers"]
    require(all(isinstance(x, dict) and isinstance(x.get("id"), str) for x in original), "data_invalid", "Every existing offer must have an ID.")
    require(len({x["id"] for x in original}) == len(original), "data_invalid", "Duplicate offer IDs prevent a safe update.")
    result = copy.deepcopy(document)
    offers = {x["id"]: x for x in result["offers"]}
    report = {"schemaVersion": 1, "startedAt": now, "dryRun": bool(dry_run), "status": "completed", "scopeOrigin": "private_offer", "requests": 0, "checked": 0, "updated": 0, "verifiedUnchanged": 0, "failed": 0, "skipped": 0, "sources": []}
    pages = {}
    successful = 0
    max_urls = config.get("limits", {}).get("maxUrls", 40)
    for source in config["sources"]:
        row = {"sourceId": source["id"], "offerId": source.get("offerId"), "nurseryId": source.get("nurseryId"), "url": source.get("url")}
        if not source.get("enabled", True):
            row.update(status="skipped", reason=source["reason"], pricePreserved=True)
            report["skipped"] += 1
            report["sources"].append(row)
            continue
        offer = offers.get(source["offerId"])
        before = {k: offer.get(k) for k in ["price", "currency", "unit", "taxStatus", "checkedAt"]} if offer else None
        row["previous"] = before
        try:
            binding(source, offer, config)
            key = url_key(source["url"])
            if key not in pages:
                require(report["requests"] < max_urls, "request_limit", "Configured maximum unique product URLs reached.")
                report["requests"] += 1
                try:
                    pages[key] = Document(fetcher(source["url"]))
                except UpdateError as error:
                    pages[key] = error
            if isinstance(pages[key], UpdateError):
                raise pages[key]
            observation = ADAPTERS[source["adapter"]](pages[key], source)
            if observation.source_valid_until is not None:
                require(isinstance(observation.source_valid_until, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", observation.source_valid_until)), "price_validity_unknown", "Source price-validity date is not an ISO calendar date.")
                try:
                    calendar_date.fromisoformat(observation.source_valid_until)
                except ValueError as error:
                    raise UpdateError("price_validity_unknown", "Source price-validity date is not a real calendar date.") from error
                require(observation.source_valid_until >= now[:10], "price_expired", "Source explicitly dates this price before the current check.")
            fields = observation_fields(observation, source, now)
            changed = any(offer.get(k) != fields[k] for k in ["price", "currency", "unit", "taxStatus"])
            offer.update(fields)
            successful += 1
            report["checked"] += 1
            report["updated" if changed else "verifiedUnchanged"] += 1
            row.update(status="would_update" if changed and dry_run else "updated" if changed else "verified_unchanged", pricePreserved=False, observed={k: fields[k] for k in ["price", "currency", "unit", "taxStatus", "checkedAt"]}, priceObservation=fields["priceObservation"])
        except UpdateError as error:
            report["failed"] += 1
            row.update(status="failed", reason=error.code, detail=error.detail, pricePreserved=True)
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            report["failed"] += 1
            row.update(status="failed", reason="source_structure_changed", detail=f"Source no longer follows the reviewed structure ({type(error).__name__}); old row preserved.", pricePreserved=True)
        report["sources"].append(row)
    if successful:
        result["updatedAt"] = now
    if report["failed"]:
        report["status"] = "partial_failure" if successful else "failed"
    report["dataChanged"] = result != document
    report["successfulObservations"] = successful
    return result, report


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data/kataloske-stavke.json")
    parser.add_argument("--config", default="scripts/price-sources.json")
    parser.add_argument("--report", default="reports/price-update.json")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate; write report only, never catalogue data.")
    parser.add_argument("--fail-on-source-error", action="store_true", help="Return exit 1 if any source fails; successful observations are still saved unless dry-run.")
    args = parser.parse_args(argv)
    catalogue_written = False
    try:
        require(Path(args.data).resolve() != Path(args.report).resolve(), "config_invalid", "Report and catalogue paths must differ.")
        data = json.loads(Path(args.data).read_text(encoding="utf-8"))
        if isinstance(data.get("sourcePolicy"), dict) and data["sourcePolicy"].get("nonPhoto") == "rasadnici-ponude-zip":
            config, fetch = {}, None
        else:
            config = json.loads(Path(args.config).read_text(encoding="utf-8"))
            validate_config(config)
            limits = config.get("limits", {})
            fetch = PublicFetcher(limits.get("timeoutSeconds", 20), limits.get("maxResponseBytes", 5000000), limits.get("requestDelaySeconds", 1.25))
        result, report = update_document(data, config, fetch, dry_run=args.dry_run)
        if not args.dry_run and report["dataChanged"]:
            atomic_json(args.data, result)
            catalogue_written = True
        atomic_json(args.report, report)
        print(json.dumps({k: v for k, v in report.items() if k != "sources"}, ensure_ascii=False))
        return 1 if args.fail_on_source_error and report["failed"] else 0
    except (UpdateError, OSError, ValueError, TypeError) as error:
        report = {"schemaVersion": 1, "startedAt": datetime.now(timezone.utc).isoformat(), "status": "configuration_or_data_error", "dryRun": args.dry_run, "catalogueWritten": catalogue_written, "reason": getattr(error, "code", type(error).__name__), "detail": getattr(error, "detail", str(error))}
        if Path(args.data).resolve() != Path(args.report).resolve():
            atomic_json(args.report, report)
        print(json.dumps(report, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

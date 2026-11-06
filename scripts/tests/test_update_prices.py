"""Price identity, package semantics and failure-preservation regression tests."""
import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_prices as updater

FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-11-06T12:00:00Z"
BIO_URL = "https://biojela.rs/product/abies-nordmanniana-2/"
SIMPLE_URL = "https://biojela.rs/product/berberis-thunbergii-atropurpurea-2/"
VITO_URL = "https://rasadnik-vitorovic.shop/products/smilje-helichrysum-italicum-kontejnerske-sadnice"
LORBERG_URL = "https://www.lorberg.com/en-gb/article/148/acer-campestre"


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def source(kind="bio", suffix="a"):
    common = {"id": "source-" + suffix, "offerId": "offer-" + suffix, "plantId": "plant-" + suffix, "enabled": True}
    if kind in {"bio", "simple"}:
        url = BIO_URL if kind == "bio" else SIMPLE_URL
        expected = {"productName": "Abies nordmanniana" if kind == "bio" else "Berberis thunbergii ‘Atropurpurea’", "currency": "RSD", "unit": {"kind": "catalogue_unit", "label": "jedinica iz cenovnika"}}
        if kind == "bio":
            expected.update(variantId="3477", variantAttributes={"attribute_pa_visina": "1-1,2m"})
        common.update(nurseryId="biojela", adapter="biojela_woocommerce", url=url, offerSourceUrl=url, expected=expected)
    elif kind == "vito":
        variant_url = VITO_URL + "?variant=46609440669939"
        common.update(nurseryId="rasadnik-vitorovic", adapter="vitorovic_shopify", url=VITO_URL, offerSourceUrl=variant_url, expected={"productName": "Kontejnerske sadnice - Smilje (Helichrysum italicum)", "variantUrl": variant_url, "currency": "RSD", "unit": {"kind": "package", "label": "pakovanje od 104 sadnice", "count": 104}})
    else:
        common.update(nurseryId="lorberg", adapter="lorberg_selected_variant", url=LORBERG_URL, offerSourceUrl=LORBERG_URL, expected={"productName": "Acer campestre", "variantId": "741", "variantLabel": "He 2xv mB geschn. 100- 125", "currency": "EUR", "unit": {"kind": "catalogue_unit", "label": "jedinica iz cenovnika"}})
    common["evidence"] = {"sourceUrl": common["url"], "reviewedAt": "2026-11-06"}
    return common


def offer(s, price=10):
    return {"id": s["offerId"], "plantId": s["plantId"], "nurseryId": s["nurseryId"], "sourceUrl": s["offerSourceUrl"], "sourceDate": "", "sourcePeriod": "", "price": price, "currency": s["expected"]["currency"], "unit": s["expected"]["unit"]["label"], "priceKind": "public", "taxStatus": "PDV nije naveden", "checkedAt": "2025-01-01", "height": "do not change", "image": "local-photo.webp", "demo": False}


def config(sources):
    return {"schemaVersion": 1, "scope": {"origin": "private_offer", "allowedPlantIds": sorted({s["plantId"] for s in sources if s.get("plantId")}), "allowedNurseryIds": sorted({s["nurseryId"] for s in sources if s.get("nurseryId")})}, "sources": sources}


def document(offers):
    return {"schemaVersion": 1, "updatedAt": "2025-01-01T00:00:00Z", "offers": offers}


class PriceUpdateTests(unittest.TestCase):
    def run_one(self, s, body, old=10):
        original = document([offer(s, old)])
        snapshot = copy.deepcopy(original)
        result, report = updater.update_document(original, config([s]), lambda url: body, now=NOW)
        self.assertEqual(original, snapshot, "Input object must not be mutated")
        return original, result, report

    def assert_preserved(self, original, result, report, reason):
        self.assertEqual(result, original)
        self.assertEqual(report["failed"], 1)
        self.assertEqual(report["sources"][0]["reason"], reason)
        self.assertTrue(report["sources"][0]["pricePreserved"])

    def test_exact_woo_variant_and_visible_option(self):
        _, result, report = self.run_one(source(), fixture("biojela-variant.html"))
        item = result["offers"][0]
        self.assertEqual(item["price"], 4200)
        self.assertEqual(item["height"], "do not change")
        self.assertEqual(item["image"], "local-photo.webp")
        self.assertEqual(item["priceObservation"]["variantId"], "3477")
        self.assertEqual(item["sourceDate"], "")
        self.assertIsNone(item["priceObservation"]["sourcePublishedAt"])
        self.assertEqual(report["failed"], 0)

    def test_simple_product_ignores_related_price_and_stock(self):
        _, result, report = self.run_one(source("simple"), fixture("biojela-simple.html"))
        self.assertEqual(result["offers"][0]["price"], 300)
        self.assertEqual(report["failed"], 0)

    def test_package_price_is_not_divided_by_104(self):
        _, result, report = self.run_one(source("vito"), fixture("vitorovic-package.html"))
        item = result["offers"][0]
        self.assertEqual(item["price"], 4160)
        self.assertEqual(item["unit"], "pakovanje od 104 sadnice")
        self.assertEqual(item["priceObservation"]["packCount"], 104)
        self.assertEqual(report["failed"], 0)

    def test_lorberg_selected_variant_not_quantity_tier_or_related_price(self):
        _, result, report = self.run_one(source("lorberg"), fixture("lorberg-selected.html"))
        item = result["offers"][0]
        self.assertEqual(item["price"], 22)
        self.assertEqual(item["currency"], "EUR")
        self.assertEqual(item["taxStatus"], "Incl. 7% VAT.")
        self.assertIn("stanje zaliha nije potvrđeno", item["availability"])
        self.assertEqual(report["failed"], 0)

    def test_product_name_change_preserves_complete_row(self):
        values = self.run_one(source(), fixture("biojela-variant.html").replace("Abies nordmanniana", "Abies alba"))
        self.assert_preserved(*values, "product_identity_changed")

    def test_variant_id_change_preserves_complete_row(self):
        s = source(); s["expected"]["variantId"] = "999999"
        self.assert_preserved(*self.run_one(s, fixture("biojela-variant.html")), "variant_identity_changed")

    def test_variant_dimensions_change_preserves_complete_row(self):
        s = source(); s["expected"]["variantAttributes"]["attribute_pa_visina"] = "8-9m"
        self.assert_preserved(*self.run_one(s, fixture("biojela-variant.html")), "variant_specification_changed")

    def test_zero_price_is_not_an_offer(self):
        self.assert_preserved(*self.run_one(source(), fixture("biojela-variant.html").replace("4200", "0")), "nonpositive_price")

    def test_unknown_currency_fails_closed(self):
        self.assert_preserved(*self.run_one(source(), fixture("biojela-variant.html").replace("RSD", "JPY")), "unknown_currency")

    def test_simple_range_is_not_a_single_price(self):
        body = fixture("biojela-simple.html")
        amount = '<span class="woocommerce-Price-amount amount"><bdi>400,00 <span class="woocommerce-Price-currencySymbol">RSD</span></bdi></span>'
        body = body.replace('</p></div>', " – " + amount + '</p></div>', 1)
        self.assert_preserved(*self.run_one(source("simple"), body), "ambiguous_price_range")

    def test_simple_discount_uses_current_price_not_deleted_price(self):
        body = fixture("biojela-simple.html")
        start = body.index('<p class="price">') + len('<p class="price">')
        end = body.index('</p>', start)
        old = body[start:end]
        body = body[:start] + '<del>' + old + '</del><ins>' + old.replace('300,00', '250,00') + '</ins>' + body[end:]
        _, result, report = self.run_one(source("simple"), body)
        self.assertEqual(result["offers"][0]["price"], 250)
        self.assertEqual(report["failed"], 0)

    def test_changed_package_count_preserves_complete_row(self):
        self.assert_preserved(*self.run_one(source("vito"), fixture("vitorovic-package.html").replace("104", "52")), "package_changed")

    def test_expired_public_price_preserves_complete_row(self):
        body = fixture("vitorovic-package.html").replace('"price": 4160.0', '"priceValidUntil": "2020-01-01", "price": 4160.0')
        self.assert_preserved(*self.run_one(source("vito"), body), "price_expired")

    def test_invalid_validity_date_is_not_saved(self):
        body = fixture("vitorovic-package.html").replace('"price": 4160.0', '"priceValidUntil": "2030-99-99", "price": 4160.0')
        self.assert_preserved(*self.run_one(source("vito"), body), "price_validity_unknown")

    def test_missing_stock_does_not_invent_availability(self):
        body = fixture("biojela-simple.html").replace("type-product instock", "type-product")
        _, result, report = self.run_one(source("simple"), body)
        self.assertEqual(result["offers"][0]["price"], 300)
        self.assertIn("stanje zaliha nije potvrđeno", result["offers"][0]["availability"])
        self.assertEqual(report["failed"], 0)

    def test_changed_lorberg_default_does_not_choose_other_variant(self):
        body = fixture("lorberg-selected.html").replace('active" id="741"', 'active" id="742"')
        self.assert_preserved(*self.run_one(source("lorberg"), body), "variant_identity_changed")

    def test_network_failure_preserves_price_and_last_checked_date(self):
        s = source(); original = document([offer(s)])
        def fail(_): raise updater.UpdateError("http_error", "HTTP 503")
        result, report = updater.update_document(original, config([s]), fail, now=NOW)
        self.assert_preserved(original, result, report, "http_error")

    def test_two_variants_fetch_one_page_and_keep_separate_prices(self):
        a, b = source(suffix="a"), source(suffix="b")
        b["expected"].update(variantId="3147", variantAttributes={"attribute_pa_visina": "1,3-1,5m"})
        calls = []
        def fetch(url): calls.append(url); return fixture("biojela-variant.html")
        result, report = updater.update_document(document([offer(a), offer(b)]), config([a, b]), fetch, now=NOW)
        self.assertEqual(len(calls), 1)
        self.assertEqual([x["price"] for x in result["offers"]], [4200, 5000])
        self.assertEqual(report["successfulObservations"], 2)

    def test_scope_mismatch_prevents_network_and_writes(self):
        s = source(); original = document([offer(s)]); conf = config([s]); conf["scope"]["allowedPlantIds"] = []
        calls = []
        result, report = updater.update_document(original, conf, lambda url: calls.append(url), now=NOW)
        self.assert_preserved(original, result, report, "outside_scope")
        self.assertEqual(calls, [])

    def test_source_binding_change_prevents_network(self):
        s = source(); original = document([offer(s)]); original["offers"][0]["sourceUrl"] = SIMPLE_URL
        calls = []
        result, report = updater.update_document(original, config([s]), lambda url: calls.append(url), now=NOW)
        self.assert_preserved(original, result, report, "source_binding_changed")
        self.assertEqual(calls, [])

    def test_missing_offer_does_not_create_records(self):
        s = source(); original = document([])
        result, report = updater.update_document(original, config([s]), lambda url: "", now=NOW)
        self.assert_preserved(original, result, report, "offer_missing")
        self.assertEqual(result["offers"], [])

    def test_disabled_supplier_has_no_fake_check(self):
        s = {"id": "gold-disabled", "nurseryId": "rasadnik-gold", "enabled": False, "reason": "no_public_numeric_price"}
        calls = []; original = document([])
        result, report = updater.update_document(original, config([s]), lambda url: calls.append(url), now=NOW)
        self.assertEqual(result, original)
        self.assertEqual(calls, [])
        self.assertEqual(report["skipped"], 1)
        self.assertEqual(report["successfulObservations"], 0)

    def test_bad_source_does_not_block_good_source(self):
        a, b = source("simple", "a"), source("vito", "b")
        original = document([offer(a), offer(b)])
        def fetch(url):
            if url == SIMPLE_URL: return fixture("biojela-simple.html")
            raise updater.UpdateError("http_error", "HTTP 503")
        result, report = updater.update_document(original, config([a, b]), fetch, now=NOW)
        self.assertEqual(result["offers"][0]["price"], 300)
        self.assertEqual(result["offers"][1], original["offers"][1])
        self.assertEqual(report["status"], "partial_failure")

    def test_config_cannot_use_other_supplier_or_internal_url(self):
        s = source(); s["url"] = "http://127.0.0.1/product/example"
        with self.assertRaises(updater.UpdateError): updater.validate_config(config([s]))
        s = source(); s["nurseryId"] = "plantarium"
        with self.assertRaises(updater.UpdateError): updater.validate_config(config([s]))

    def test_redirect_to_another_product_is_rejected(self):
        redirect = updater.SameProductRedirect()
        with self.assertRaises(updater.UpdateError):
            redirect.redirect_request(Request(BIO_URL), None, 302, "Found", {}, SIMPLE_URL)

    def test_cli_dry_run_leaves_original_bytes_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); s = source("simple")
            data = json.dumps(document([offer(s)]), ensure_ascii=False, separators=(",", ":"))
            (p / "data.json").write_text(data, encoding="utf-8")
            (p / "config.json").write_text(json.dumps(config([s]), ensure_ascii=False), encoding="utf-8")
            with patch.object(updater, "PublicFetcher", return_value=lambda url: fixture("biojela-simple.html")), redirect_stdout(io.StringIO()):
                code = updater.main(["--data", str(p / "data.json"), "--config", str(p / "config.json"), "--report", str(p / "report.json"), "--dry-run"])
            self.assertEqual(code, 0)
            self.assertEqual((p / "data.json").read_text(encoding="utf-8"), data)
            report = json.loads((p / "report.json").read_text(encoding="utf-8"))
            self.assertTrue(report["dryRun"])
            self.assertEqual(report["sources"][0]["status"], "would_update")


if __name__ == "__main__":
    unittest.main()

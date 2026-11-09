"""Synthetic source fixtures; never access nursery websites or real catalogue data."""
from __future__ import annotations

import copy
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

MODULE = Path(__file__).resolve().parents[1] / "update_photos.py"
spec = importlib.util.spec_from_file_location("demetra_update_photos", MODULE)
photos = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = photos
spec.loader.exec_module(photos)

PAGE = "https://nursery.example/product/acer-palmatum-bloodgood/"
OLD_IMAGE = "https://media.nursery.example/old.png"
NEW_IMAGE = "https://media.nursery.example/bloodgood.png"
NAME = "Acer palmatum 'Bloodgood'"


def bitmap(color=(30, 100, 60, 255), size=(160, 200), fmt="PNG", exif=None):
    image = Image.new("RGBA", size, color)
    if fmt == "JPEG":
        image = image.convert("RGB")
    output = BytesIO()
    image.save(output, format=fmt, **({"exif": exif} if exif else {}))
    return output.getvalue()


def product_page(name=NAME, image_url=NEW_IMAGE, extra=""):
    product = {"@type": "Product", "url": PAGE, "name": name, "image": image_url}
    return ('<html><head><title>' + name + '</title><link rel="canonical" href="' + PAGE +
            '"><script type="application/ld+json">' + json.dumps(product) +
            '</script></head><body><main><h1>' + name + '</h1>' + extra + '</main></body></html>')


class FakeSources:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs["kind"]))
        value = self.routes[url]
        if isinstance(value, Exception):
            raise value
        if isinstance(value, photos.FetchResult):
            return value
        return photos.FetchResult(value.encode() if isinstance(value, str) else value, url,
                                  "text/html" if kwargs["kind"] == "page" else "image/png")


class PhotoUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in ("data", "docs", "assets/biljke"):
            (self.root / folder).mkdir(parents=True)
        self.policy = {"nurseryId": "nursery", "resolver": "product", "fillMissing": True,
                       "pageHosts": ["nursery.example"], "imageHosts": ["media.nursery.example"],
                       "pagePathPattern": r"/product/[a-z0-9-]+/?"}
        self.config = {"schemaVersion": 1, "sources": [self.policy]}
        self.offer = {"id": "offer-1", "plantId": "plant-1", "nurseryId": "nursery",
                      "price": 12.5, "currency": "EUR", "taxStatus": "Bez PDV-a",
                      "height": "100-125", "circumference": "10/12", "crownWidth": "",
                      "rootBall": "", "potSize": "CLT 20", "rootType": "Kontejner",
                      "matureHeight": "5-8 m", "matureCrownWidth": "3-5 m",
                      "sourceDate": "2025-10-20", "checkedAt": "2026-10-01",
                      "availability": "Proveriti", "sourceUrl": PAGE, "imageSourceUrl": PAGE,
                      "image": "assets/biljke/old.jpg", "imageKind": "Kataloška fotografija rasadnika"}
        self.record = {"offerId": "offer-1", "plantId": "plant-1", "nurseryId": "nursery",
                       "sourceUrl": OLD_IMAGE, "sourcePage": PAGE, "localPath": self.offer["image"],
                       "status": "saved"}
        self.write("data/biljke.json", {"schemaVersion": 1, "plants": [{"id": "plant-1", "latinName": NAME}]})
        self.write("data/rasadnici.json", {"schemaVersion": 1, "nurseries": [{"id": "nursery"}]})
        self.write("data/kataloske-stavke.json", {"schemaVersion": 1, "updatedAt": "2026-10-01", "offers": [self.offer]})
        self.write("docs/fotografije.json", {"snapshotAt": "2026-10-01", "photos": [self.record]})
        self.old_bytes = photos.to_jpeg(bitmap(), photos.DEFAULT_LIMITS)
        (self.root / self.offer["image"]).write_bytes(self.old_bytes)
        self.new_bitmap = bitmap((160, 30, 90, 200), (1600, 800))

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def read(self, name):
        return json.loads((self.root / name).read_text(encoding="utf-8"))

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def run_update(self, routes=None, **kwargs):
        source = FakeSources(routes or {PAGE: product_page(), NEW_IMAGE: self.new_bitmap})
        report = photos.run_update(self.root, config=self.config, fetcher=source,
                                   now=kwargs.pop("now", "2026-11-09T12:00:00Z"), **kwargs)
        return report, source

    def test_identity_requires_same_species_and_cultivar(self):
        for wrong in ["Acer palmatum 'Atropurpureum'", "Acer pseudoplatanus 'Bloodgood'", "Acer palmatum"]:
            with self.subTest(wrong=wrong):
                before = self.snapshot()
                report, source = self.run_update({PAGE: product_page(wrong)})
                self.assertEqual(report["sources"][0]["reason"], "plant_identity_mismatch")
                self.assertEqual(source.calls, [(PAGE, "page")])
                self.assertEqual(self.snapshot(), before)
        self.assertTrue(photos.identity_matches("PHOTINIA × fraseri ‘Red Robin’", "Photinia x fraseri 'Red Robin'"))
        self.assertFalse(photos.identity_matches("Acer palmatum 'Bloodgood'", "Acer palmatum"))

    def test_another_nursery_host_and_redirect_are_rejected(self):
        before = self.snapshot()
        report, source = self.run_update({PAGE: product_page(image_url="https://other-nursery.example/tree.jpg")})
        self.assertEqual(report["sources"][0]["reason"], "unapproved_url")
        self.assertEqual(source.calls, [(PAGE, "page")])
        report, _ = self.run_update({PAGE: product_page(), NEW_IMAGE:
                                    photos.FetchResult(self.new_bitmap, "https://other-nursery.example/tree.png", "image/png")})
        self.assertEqual(report["sources"][0]["reason"], "unapproved_url")
        self.assertEqual(self.snapshot(), before)
        report, _ = self.run_update({PAGE: product_page(), NEW_IMAGE:
                                    photos.FetchResult(self.new_bitmap, "https://media.nursery.example/placeholder.png", "image/png")})
        self.assertEqual(report["sources"][0]["reason"], "placeholder_image")
        self.assertEqual(self.snapshot(), before)

    def test_failed_page_or_image_preserves_every_old_byte(self):
        for routes in [{PAGE: photos.PhotoError("http_error", "HTTP 503")},
                       {PAGE: product_page(), NEW_IMAGE: photos.PhotoError("http_error", "HTTP 404")}]:
            with self.subTest(routes=list(routes)):
                before = self.snapshot()
                report, source = self.run_update(routes)
                self.assertEqual(report["status"], "failed")
                self.assertTrue(report["sources"][0]["photoPreserved"])
                self.assertEqual(self.snapshot(), before)
                self.assertNotIn((OLD_IMAGE, "image"), source.calls)

    def test_update_writes_real_resized_jpeg_and_preserves_prices_and_dimensions(self):
        report, _ = self.run_update()
        self.assertEqual(report["updated"], 1)
        after = self.read("data/kataloske-stavke.json")
        row = after["offers"][0]
        self.assertEqual({k: v for k, v in row.items() if k not in photos.PHOTO_FIELDS},
                         {k: v for k, v in self.offer.items() if k not in photos.PHOTO_FIELDS})
        self.assertEqual(after["updatedAt"], "2026-11-09T12:00:00Z")
        self.assertNotEqual(row["image"], self.offer["image"])
        self.assertEqual((self.root / self.offer["image"]).read_bytes(), self.old_bytes)
        with Image.open(self.root / row["image"]) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.size, (1200, 600))
        record = self.read("docs/fotografije.json")["photos"][0]
        self.assertEqual(record["sourceUrl"], NEW_IMAGE)
        self.assertEqual(record["localPath"], row["image"])
        self.assertEqual(record["resolutionMode"], "product_page")

    def test_exif_orientation_is_applied_and_pixel_and_byte_limits_are_enforced(self):
        exif = Image.Exif()
        exif[274] = 6
        jpeg = photos.to_jpeg(bitmap(size=(160, 80), fmt="JPEG", exif=exif), photos.DEFAULT_LIMITS)
        with Image.open(BytesIO(jpeg)) as image:
            self.assertEqual(image.size, (80, 160))
            self.assertNotIn(274, image.getexif())
        limits = {**photos.DEFAULT_LIMITS, "maxPixels": 100}
        with self.assertRaises(photos.PhotoError):
            photos.to_jpeg(self.new_bitmap, limits)
        with self.assertRaises(photos.PhotoError):
            photos.to_jpeg(self.new_bitmap, {**photos.DEFAULT_LIMITS, "maxImageBytes": 20})
        with self.assertRaises(photos.PhotoError):
            photos.to_jpeg(b"<svg/>", photos.DEFAULT_LIMITS)

    def test_unchanged_second_run_has_no_timestamp_or_file_churn(self):
        self.run_update()
        before = self.snapshot()
        report, _ = self.run_update(now="2026-12-20T12:00:00Z")
        self.assertEqual(report["verifiedUnchanged"], 1)
        self.assertFalse(report["dataChanged"])
        self.assertFalse(report["manifestChanged"])
        self.assertEqual(report["imageFilesChanged"], 0)
        self.assertEqual(self.snapshot(), before)

    def test_dry_run_reports_but_changes_no_files(self):
        before = self.snapshot()
        report, _ = self.run_update(dry_run=True)
        self.assertEqual(report["updated"], 1)
        self.assertTrue(report["dryRun"])
        self.assertEqual(self.snapshot(), before)

    def test_missing_image_filled_only_for_supported_exact_product(self):
        self.offer.update(image="", imageSourceUrl="", price=None, currency="")
        self.write("data/kataloske-stavke.json", {"schemaVersion": 1, "offers": [self.offer]})
        self.write("docs/fotografije.json", {"snapshotAt": "2026-10-01", "photos": []})
        report, _ = self.run_update()
        self.assertEqual(report["added"], 1)
        row = self.read("data/kataloske-stavke.json")["offers"][0]
        self.assertIsNone(row["price"])
        self.assertEqual(row["currency"], "")
        self.assertEqual(self.read("docs/fotografije.json")["photos"][0]["offerId"], self.offer["id"])

    def test_archive_photo_binding_preserves_type_transplants_and_accuracy_notes(self):
        self.offer.update(sourceUrl='', photoSourcePage=PAGE, imageSourceUrl=PAGE, image='',
                          dataOrigin='rasadnici-ponude-zip', seedlingType='multistem',
                          seedlingTypeCode='MSTEM', transplantCount=4,
                          transplantNote='Broj presađivanja prema ponudi: 4xv.',
                          dataAccuracyNote='Obim nije naveden; 300–350 je izvorna visina.',
                          traitsEvidence={'sourceSha256': 'abc', 'row': 7, 'raw': 'MSTEM 4xv'})
        policy = {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']}
        self.write('data/kataloske-stavke.json', {'schemaVersion': 1, 'sourcePolicy': policy, 'offers': [self.offer]})
        self.write('docs/fotografije.json', {'photos': []})
        before = json.dumps({k:v for k,v in self.offer.items() if k not in photos.PHOTO_FIELDS}, ensure_ascii=False, sort_keys=True).encode()
        misleading_web_values = '<p>Price 9999 EUR; height 900 cm; standard; transplanted 9 times</p>'
        report, source = self.run_update({PAGE: product_page(extra=misleading_web_values), NEW_IMAGE: self.new_bitmap})
        self.assertEqual(report['added'], 1)
        self.assertEqual(source.calls, [(PAGE, 'page'), (NEW_IMAGE, 'image')])
        catalogue = self.read('data/kataloske-stavke.json')
        row = catalogue['offers'][0]
        after = json.dumps({k:v for k,v in row.items() if k not in photos.PHOTO_FIELDS}, ensure_ascii=False, sort_keys=True).encode()
        self.assertEqual(after, before)
        self.assertEqual(catalogue['sourcePolicy'], policy)

    def test_direct_mode_uses_only_confirmed_url_and_does_not_claim_page_refresh(self):
        self.policy["resolver"] = "direct"
        self.policy["fillMissing"] = False
        self.offer["price"] = 0
        self.write("data/kataloske-stavke.json", {"schemaVersion": 1, "offers": [self.offer]})
        report, source = self.run_update({OLD_IMAGE: self.new_bitmap})
        self.assertEqual(source.calls, [(OLD_IMAGE, "image")])
        self.assertEqual(report["directChecks"], 1)
        self.assertEqual(report["pageResolved"], 0)
        self.assertEqual(report["sources"][0]["mode"], "confirmed_direct")
        self.assertEqual(self.read("data/kataloske-stavke.json")["offers"][0]["price"], 0)
        self.offer.update(image="", imageSourceUrl="")
        self.write("data/kataloske-stavke.json", {"schemaVersion": 1, "offers": [self.offer]})
        self.write("docs/fotografije.json", {"snapshotAt": "2026-10-01", "photos": []})
        report, source = self.run_update()
        self.assertEqual(source.calls, [])
        self.assertEqual(report["skipped"], 1)

    def test_manifest_mismatch_and_local_traversal_fail_before_network(self):
        for changes in [{"nurseryId": "other"}, {"localPath": "assets/biljke/../../secret.jpg"}]:
            with self.subTest(changes=changes):
                record = {**self.record, **changes}
                self.write("docs/fotografije.json", {"snapshotAt": "2026-10-01", "photos": [record]})
                source = FakeSources({})
                with self.assertRaises(photos.PhotoError):
                    photos.run_update(self.root, config=self.config, fetcher=source)
                self.assertEqual(source.calls, [])

    def test_shared_old_file_and_other_offer_remain_untouched_under_offer_filter(self):
        second_offer = {**self.offer, "id": "offer-2", "price": 18.0, "potSize": "C35"}
        second_photo = {**self.record, "offerId": "offer-2"}
        self.write("data/kataloske-stavke.json", {"schemaVersion": 1, "offers": [self.offer, second_offer]})
        self.write("docs/fotografije.json", {"snapshotAt": "2026-10-01", "photos": [self.record, second_photo]})
        report, _ = self.run_update(offer_id="offer-1", limit=1)
        self.assertEqual(report["checked"], 1)
        self.assertEqual(self.read("data/kataloske-stavke.json")["offers"][1], second_offer)
        self.assertEqual(self.read("docs/fotografije.json")["photos"][1], second_photo)
        self.assertEqual((self.root / self.offer["image"]).read_bytes(), self.old_bytes)

    def test_product_reference_and_main_wp_image_avoid_related_and_logo_images(self):
        graph = [{"@type": "Product", "url": PAGE, "name": NAME, "image": {"@id": NEW_IMAGE}},
                 {"@type": "ImageObject", "@id": NEW_IMAGE, "url": NEW_IMAGE}]
        page = '<h1>' + NAME + '</h1><script type="application/ld+json">' + json.dumps({"@graph": graph}) + '</script>'
        self.assertEqual(photos.resolve_product_image(page, PAGE, NAME, self.policy), (NEW_IMAGE, "product_jsonld"))
        page = ('<h1>' + NAME + '</h1><section class="related products"><img class="wp-post-image" src="' +
                OLD_IMAGE + '"></section><div class="woocommerce-product-gallery"><img class="wp-post-image" src="' +
                OLD_IMAGE + '" data-large_image="' + NEW_IMAGE + '"></div>')
        self.assertEqual(photos.resolve_product_image(page, PAGE, NAME, self.policy), (NEW_IMAGE, "featured_product_image"))
        page = '<h1>' + NAME + '</h1><meta property="og:title" content="' + NAME + '"><meta property="og:image" content="https://media.nursery.example/social-default.jpg">'
        with self.assertRaises(photos.PhotoError):
            photos.resolve_product_image(page, PAGE, NAME, self.policy)

    def test_webpage_primary_image_and_og_need_confirmed_identity(self):
        graph = [{"@type": "WebPage", "url": PAGE, "primaryImageOfPage": {"@id": PAGE + "#primary"}},
                 {"@type": "ImageObject", "@id": PAGE + "#primary", "contentUrl": NEW_IMAGE}]
        page = '<h1>' + NAME + '</h1><script type="application/ld+json">' + json.dumps(graph) + '</script>'
        self.assertEqual(photos.resolve_product_image(page, PAGE, NAME, self.policy), (NEW_IMAGE, "page_primary_image"))
        # Real WordPress graphs can define the full object before its bare ref.
        page = '<h1>' + NAME + '</h1><script type="application/ld+json">' + json.dumps(list(reversed(graph))) + '</script>'
        self.assertEqual(photos.resolve_product_image(page, PAGE, NAME, self.policy), (NEW_IMAGE, "page_primary_image"))
        page = '<h1>' + NAME + '</h1><meta property="og:title" content="' + NAME + '"><meta property="og:image" content="' + NEW_IMAGE + '">'
        self.assertEqual(photos.resolve_product_image(page, PAGE, NAME, self.policy), (NEW_IMAGE, "product_og_image"))


if __name__ == "__main__":
    unittest.main()

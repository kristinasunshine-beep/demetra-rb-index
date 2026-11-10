"""Synthetic provider responses: no network requests or catalogue mutations."""
from __future__ import annotations

import copy
from io import BytesIO
import json
from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs, urlsplit

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import open_photo_sources as sources
from update_photos import FetchResult, PhotoError

NAME = "Acer campestre 'Elsrijk'"
IMAGE = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Acer_campestre_Elsrijk.jpg"


def commons_page(name=NAME, license="CC0"):
    return {"title": f"File:{name} 2024.jpg", "imageinfo": [{"url": IMAGE, "thumburl": IMAGE,
        "descriptionurl": "https://commons.wikimedia.org/wiki/File:Acer_campestre_Elsrijk.jpg",
        "mime": "image/jpeg", "width": 1600, "height": 1200,
        "extmetadata": {"ImageDescription": {"value": name}, "LicenseShortName": {"value": license},
                        "AttributionRequired": {"value": "false"}}}]}


class FakeApi:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, FetchResult):
            return value
        return FetchResult(json.dumps(value).encode(), url, "application/json")


def gbif_match():
    return {"matchType": "EXACT", "rank": "SPECIES", "kingdom": "Plantae",
            "canonicalName": "Acer campestre", "usageKey": 123}


def gbif_record(name=NAME, media_license="https://creativecommons.org/publicdomain/zero/1.0/"):
    return {"key": 456, "speciesKey": 123, "species": "Acer campestre", "scientificName": "Acer campestre L.",
            "verbatimScientificName": name, "issues": [], "license": "CC0_1_0",
            "media": [{"type": "StillImage", "format": "image/jpeg", "identifier": "https://example.org/photo.jpg",
                       "license": media_license}]}


class IdentityTests(unittest.TestCase):
    def test_exact_cultivar_and_formatting(self):
        self.assertTrue(sources.identity_evidence(NAME, ["File:Acer_campestre_Elsrijk_2024.jpg"]))
        self.assertTrue(sources.identity_evidence(NAME, ["<i>Acer campestre</i> ‘Elsrijk’"]))

    def test_species_is_not_cultivar(self):
        self.assertFalse(sources.identity_evidence(NAME, ["Acer campestre leaves.jpg"]))

    def test_conflicting_cultivar_rejected_even_if_expected_is_present(self):
        self.assertFalse(sources.identity_evidence(NAME, [NAME, "Acer campestre 'Queen Elizabeth'"]))

    def test_conflicting_species_rejected(self):
        self.assertFalse(sources.identity_evidence(NAME, [NAME, "Acer rubrum 'Elsrijk'"]))

    def test_unquoted_conflicting_cultivar_rejected(self):
        self.assertFalse(sources.identity_evidence(NAME, [NAME, "File:Acer campestre Queen Elizabeth.jpg"]))

    def test_unquoted_catalogue_cultivar_matches_quoted_evidence(self):
        self.assertTrue(sources.identity_evidence("Acer campestre Elsrijk", [NAME]))

    def test_species_request_rejects_cultivar(self):
        self.assertFalse(sources.identity_evidence("Acer campestre", [NAME]))
        self.assertFalse(sources.identity_evidence("Acer campestre", ["Acer campestre Elsrijk.jpg"]))

    def test_partial_cultivar_rejected(self):
        self.assertFalse(sources.identity_evidence("Acer platanoides 'Crimson'", ["Acer platanoides Crimson King.jpg"]))

    def test_unknown_name_rejected(self):
        self.assertFalse(sources.identity_evidence("Acer spp.", ["Acer spp."]))


class CommonsTests(unittest.TestCase):
    def test_eb1911_raster_drawing_title_rejected(self):
        page = commons_page()
        page["title"] = f"File:EB1911 {NAME} 2024.jpg"
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_non_photo_object_name_and_description_rejected(self):
        for field in ("ObjectName", "ImageDescription"):
            for marker in ("illustration", "drawing", "diagram", "engraving", "botanical plate"):
                with self.subTest(field=field, marker=marker):
                    page = commons_page()
                    page["imageinfo"][0]["extmetadata"][field] = {"value": f"{marker}: {NAME}"}
                    self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_non_photo_categories_rejected_without_title_hint(self):
        for category in ("Herbarium specimens", "Maps of plants", "Botanical_plates", "Logos"):
            with self.subTest(category=category):
                page = commons_page()
                page["imageinfo"][0]["extmetadata"]["Categories"] = {"value": "Acer campestre|" + category}
                self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_exact_cc0_candidate(self):
        fake = FakeApi({"query": {"pages": [commons_page()]}})
        found = sources.commons_candidates(NAME, fetcher=fake)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["license"], "CC0-1.0")
        self.assertEqual(found[0]["imageHosts"], ["upload.wikimedia.org"])
        query = parse_qs(urlsplit(fake.calls[0][0]).query)
        self.assertEqual(query["gsrnamespace"], ["6"])

    def test_by_license_and_attribution_requirement_rejected(self):
        for field, value in [("LicenseShortName", "CC BY 4.0"), ("AttributionRequired", "true")]:
            page = commons_page()
            page["imageinfo"][0]["extmetadata"][field] = {"value": value}
            self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_missing_attribution_signal_rejected(self):
        page = commons_page()
        del page["imageinfo"][0]["extmetadata"]["AttributionRequired"]
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_contradictory_license_fields_rejected(self):
        page = commons_page(license="CC BY 4.0")
        page["imageinfo"][0]["extmetadata"]["LicenseUrl"] = {"value": "https://creativecommons.org/publicdomain/zero/1.0/"}
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_public_domain_requires_copyright_flag(self):
        page = commons_page(license="Public domain")
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])
        page["imageinfo"][0]["extmetadata"]["Copyrighted"] = {"value": "False"}
        self.assertEqual(len(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}}))), 1)

    def test_bad_image_host_rejected(self):
        page = commons_page()
        page["imageinfo"][0]["thumburl"] = "https://upload.wikimedia.org.evil.example/photo.jpg"
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_deletion_candidate_rejected(self):
        page = commons_page()
        page["imageinfo"][0]["extmetadata"]["DeletionReason"] = {"value": "disputed source"}
        self.assertEqual(sources.commons_candidates(NAME, fetcher=FakeApi({"query": {"pages": [page]}})), [])

    def test_api_error_is_failure_not_empty_coverage(self):
        with self.assertRaises(PhotoError):
            sources.commons_candidates(NAME, fetcher=FakeApi({"error": {"code": "maxlag"}}))


class GbifTests(unittest.TestCase):
    def test_cultivar_evidence_and_per_media_cc0(self):
        found = sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [gbif_record()]}))
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0]["imageUrl"].startswith("https://api.gbif.org/v1/image/cache/1200x/occurrence/456/media/"))
        self.assertEqual(found[0]["sourceUrl"], "https://www.gbif.org/occurrence/456")

    def test_record_license_cannot_authorize_media(self):
        for license in ("", "https://creativecommons.org/licenses/by/4.0/", "CC BY-NC 4.0"):
            found = sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [gbif_record(media_license=license)]}))
            self.assertEqual(found, [])

    def test_species_only_does_not_fill_cultivar(self):
        found = sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [gbif_record(name="Acer campestre L.")]}))
        self.assertEqual(found, [])

    def test_other_cultivar_rejected(self):
        record = gbif_record()
        record["media"][0]["title"] = "Acer campestre 'Queen Elizabeth'"
        self.assertEqual(sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [record]})), [])

    def test_fuzzy_match_stops_before_search(self):
        match = gbif_match()
        match["matchType"] = "FUZZY"
        fake = FakeApi(match)
        self.assertEqual(sources.gbif_candidates(NAME, fetcher=fake), [])
        self.assertEqual(len(fake.calls), 1)

    def test_bad_occurrence_flags_rejected(self):
        record = gbif_record()
        record["issues"] = ["TAXON_MATCH_HIGHERRANK"]
        self.assertEqual(sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [record]})), [])

    def test_wrong_species_key_rejected(self):
        record = gbif_record()
        record["speciesKey"] = 789
        self.assertEqual(sources.gbif_candidates(NAME, fetcher=FakeApi(gbif_match(), {"results": [record]})), [])


class DownloadTests(unittest.TestCase):
    def test_download_decodes_real_bitmap(self):
        output = BytesIO()
        Image.new("RGB", (400, 300), "green").save(output, "PNG")
        candidate = {"provider": "commons", "imageUrl": IMAGE}
        fake = FakeApi(FetchResult(output.getvalue(), IMAGE, "image/png"))
        result = sources.download_candidate(candidate, fetcher=fake)
        self.assertTrue(result.startswith(b"\xff\xd8"))

    def test_candidate_cannot_override_host_policy(self):
        candidate = {"provider": "commons", "imageUrl": "https://evil.example/photo.jpg", "imageHosts": ["evil.example"]}
        with self.assertRaises(PhotoError):
            sources.download_candidate(candidate, fetcher=FakeApi())

    def test_redirect_to_unknown_host_rejected(self):
        candidate = {"provider": "commons", "imageUrl": IMAGE}
        fake = FakeApi(FetchResult(b"bad", "https://evil.example/photo.jpg", "image/jpeg"))
        with self.assertRaises(PhotoError):
            sources.download_candidate(candidate, fetcher=fake)

    def test_html_disguised_as_image_rejected(self):
        candidate = {"provider": "commons", "imageUrl": IMAGE}
        fake = FakeApi(FetchResult(b"<html>oops</html>", IMAGE, "image/jpeg"))
        with self.assertRaises(PhotoError):
            sources.download_candidate(candidate, fetcher=fake)

    def test_malformed_json_rejected(self):
        fake = FakeApi(FetchResult(b"not json", sources.COMMONS, "application/json"))
        with self.assertRaises(PhotoError):
            sources.commons_candidates(NAME, fetcher=fake)


if __name__ == "__main__":
    unittest.main()

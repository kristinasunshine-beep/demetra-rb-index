"""Exact Vannucci identities, independent proof, robots and source boundaries."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vannucci_photo_catalog as source
from update_photos import FetchResult, PhotoError

NAME = "Cornus florida 'Rubra'"


class VannucciCatalogueTests(unittest.TestCase):
    def fixture(self, *, index=None, detail=None, redirect=False):
        rows = index if index is not None else [{'id': 123, 'gen': 'Cornus', 'n': 'florida',
                                                'v': "'Rubra'", 'img': 'cornus florida rubra.jpg'}]
        product = detail if detail is not None else {'id': 123, 'genreName': 'Cornus',
            'speciesName': 'florida', 'speciesVariety': "'Rubra'", 'images': ['cornus florida rubra.jpg'],
            'variants': [{'price': '999', 'height': '123'}]}
        calls = []
        def fetch(url, **kwargs):
            calls.append(url)
            body = rows if url == source.INDEX else product
            return FetchResult(json.dumps(body).encode(), url + '?other' if redirect else url, 'application/json')
        return fetch, calls

    def test_exact_binding_and_no_online_prices_or_dimensions(self):
        fetch, calls = self.fixture()
        rows = source.candidates(NAME, fetcher=fetch, robots_rules=[])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['imageUrl'], source.BASE + '/images/cornus%20florida%20rubra.jpg')
        self.assertEqual(rows[0]['identityEvidence']['name'], NAME)
        self.assertNotIn('999', json.dumps(rows))
        self.assertNotIn('variants', json.dumps(rows))
        self.assertEqual(len(calls), 2)

    def test_species_never_uses_cultivar_and_wrong_cultivar_never_matches(self):
        fetch, calls = self.fixture()
        self.assertEqual(source.candidates('Cornus florida', fetcher=fetch), [])
        self.assertEqual(source.candidates("Cornus florida 'Cherokee Chief'", fetcher=fetch), [])
        self.assertEqual(calls, [source.INDEX])

    def test_detail_identity_is_independently_verified(self):
        for detail in ({'id': 124, 'genreName': 'Cornus', 'speciesName': 'florida', 'speciesVariety': "'Rubra'"},
                       {'id': 123, 'genreName': 'Cornus', 'speciesName': 'florida', 'speciesVariety': "'Alba'"}):
            fetch, _ = self.fixture(detail=detail)
            with self.assertRaises(PhotoError) as ctx:
                source.candidates(NAME, fetcher=fetch)
            self.assertEqual(ctx.exception.code, 'plant_identity_mismatch')

    def test_shared_cross_cultivar_image_is_rejected(self):
        rows = [{'id': 123, 'gen': 'Cornus', 'n': 'florida', 'v': "'Rubra'", 'img': 'cornus florida rubra.jpg'},
                {'id': 124, 'gen': 'Cornus', 'n': 'florida', 'v': "'Alba'", 'img': 'cornus florida rubra.jpg'}]
        fetch, _ = self.fixture(index=rows)
        self.assertEqual(source.candidates(NAME, fetcher=fetch), [])

    def test_unsafe_filenames_and_placeholder_are_never_returned(self):
        detail = {'id': 123, 'genreName': 'Cornus', 'speciesName': 'florida', 'speciesVariety': "'Rubra'",
                  'images': ['https://outsider.test/x.jpg', '../x.jpg', 'folder\\x.jpg', 'logo.jpg', 'x.svg']}
        fetch, _ = self.fixture(detail=detail)
        self.assertEqual(source.candidates(NAME, fetcher=fetch), [])

    def test_robots_and_redirects_fail_closed(self):
        fetch, calls = self.fixture()
        with self.assertRaises(PhotoError) as ctx:
            source.candidates(NAME, fetcher=fetch, robots_rules=['User-agent: *', 'Disallow: /data/'])
        self.assertEqual(ctx.exception.code, 'robots_disallowed')
        self.assertEqual(calls, [])
        fetch, _ = self.fixture(redirect=True)
        with self.assertRaises(PhotoError) as ctx:
            source.candidates(NAME, fetcher=fetch)
        self.assertEqual(ctx.exception.code, 'page_identity_mismatch')

    def test_index_cached_once_per_fetcher_not_across_sessions(self):
        fetch, calls = self.fixture()
        source.candidates(NAME, fetcher=fetch)
        source.candidates(NAME, fetcher=fetch)
        self.assertEqual(calls.count(source.INDEX), 1)
        other, other_calls = self.fixture()
        source.candidates(NAME, fetcher=other)
        self.assertEqual(other_calls.count(source.INDEX), 1)

    def test_filename_cannot_hide_a_different_cultivar_or_composite(self):
        self.assertFalse(source.filename_supports_identity('hibiscus syriacus pink chiffon.jpg', 'Hibiscus syriacus'))
        self.assertFalse(source.filename_supports_identity('DRYOPTERIS FILIX MAS LINEARIS ET FILIX MAS.jpg', 'Dryopteris filix-mas'))
        self.assertTrue(source.filename_supports_identity('cornus florida rubra (2)_AVX2000208.jpg', NAME))
        self.assertFalse(source.filename_supports_identity('cornus florida rubra Cherokee Chief.jpg', NAME))


if __name__ == '__main__':
    unittest.main()

"""All-plant coverage, identity, resumption and mutation boundary regressions."""
from __future__ import annotations

import copy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import full_photo_coverage as coverage
from update_photos import FetchResult, PhotoError

NOW = '2026-11-10T12:00:00Z'
LATER = '2026-11-11T12:00:00Z'


def bitmap(color=(20, 80, 30)):
    stream = BytesIO()
    Image.new('RGB', (300, 200), color).save(stream, format='PNG')
    return stream.getvalue()


def candidate(name):
    return {'provider': 'commons', 'imageUrl': 'https://images.example.org/' + name.replace(' ', '_') + '.png',
            'sourceUrl': 'https://example.org/photo/' + name.replace(' ', '_'),
            'imageHosts': ['images.example.org'], 'license': 'CC0', 'matchedName': name,
            'identityEvidence': {'method': 'exact_name', 'canonicalName': name}}


class FullCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plants = [{'id': 'a', 'latinName': "Acer campestre 'Elsrijk'", 'commonName': 'Maple', 'synonyms': []},
                       {'id': 'b', 'latinName': 'Quercus robur', 'commonName': 'Oak', 'synonyms': []},
                       {'id': 'c', 'latinName': 'Tilia cordata', 'commonName': 'Lime', 'synonyms': []}]
        self.write('data/biljke.json', {'schemaVersion': 1, 'updatedAt': NOW, 'plants': self.plants})
        self.write('data/kataloske-stavke.json', {'schemaVersion': 1, 'offers': []})
        self.write('data/rasadnici.json', {'schemaVersion': 1, 'nurseries': []})
        self.write('scripts/photo-sources.json', {'schemaVersion': 1, 'sources': []})
        self.write('scripts/photo-discovery.json', {'schemaVersion': 1, 'sources': []})
        self.write('scripts/full-photo-policy.json', {'schemaVersion': 1, 'scope': 'all_catalog_plants',
                   'allowSpeciesFallback': False, 'maxNurseryCandidates': 1, 'retryDays': 7})

    def write(self, path, value):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(coverage.encoded(value))

    def read(self, path):
        return json.loads((self.root / path).read_text(encoding='utf-8'))

    def run_job(self, **options):
        return coverage.run(self.root, refresh_index=False, now=NOW, **options)

    @staticmethod
    def fetch_image(url, **kwargs):
        # Each taxon's mock photograph must be distinct, just like production
        # assets; identical cross-taxon placeholders are deliberately rejected.
        color = tuple(hashlib.sha256(url.encode()).digest()[:3])
        return FetchResult(bitmap(color), url, 'image/png')

    @staticmethod
    def exact_provider(name, **kwargs):
        yield candidate(name)

    def test_all_619_plants_inventoried_without_offers_or_bindings(self):
        plants = [{'id': str(i), 'latinName': 'Acer test' + str(i)} for i in range(619)]
        self.write('data/biljke.json', {'schemaVersion': 1, 'updatedAt': NOW, 'plants': plants})
        report = self.run_job(audit_only=True)
        self.assertEqual(report['coverage']['plantsInventoried'], 619)
        self.assertEqual(len(report['coverage']['plantsWithoutPhoto']), 619)
        self.assertEqual(set(self.read(coverage.STATE)['plants']), {p['id'] for p in plants})
        self.assertEqual(report['requests'], 0)

    def test_unlinked_plants_searched_by_full_name_and_saved_compactly(self):
        seen = []
        def provider(name, **kwargs):
            seen.append(name)
            yield candidate(name)
        before = self.read('data/biljke.json')
        other = (self.root/'data/kataloske-stavke.json').read_bytes()
        report = self.run_job(providers=[provider], fetcher=self.fetch_image)
        self.assertEqual(seen, [p['latinName'] for p in self.plants])
        self.assertEqual(report['coverage']['plantsWithPhoto'], 3)
        after = self.read('data/biljke.json')
        coverage.protect(before, after)
        self.assertEqual(other, (self.root/'data/kataloske-stavke.json').read_bytes())
        for plant in after['plants']:
            self.assertEqual(set(plant['photo']), {'image', 'sourceUrl'})
            self.assertTrue(coverage.valid_image(self.root, plant['photo']['image']))
            record = self.read(coverage.MANIFEST)['plants'][plant['id']]
            self.assertEqual(record['latinName'], plant['latinName'])

    def test_cultivar_never_uses_broad_species_alias_for_nursery_photo(self):
        plant = {**self.plants[0], 'synonyms': ['Acer campestre'], 'searchAliases': ['Acer campestre']}
        item = {'pageUrl': 'https://nursery.example.org/acer', 'nurseryId': 'nursery', 'tier': 0}
        policy = {'pageHosts': ['nursery.example.org'], 'imageHosts': ['nursery.example.org'],
                  'pagePathPattern': '/.*', 'resolver': 'product'}
        html = '<h1>Acer campestre</h1><img class="wp-post-image" src="/tree.jpg">'
        def fetch(url, **kwargs):
            return FetchResult(html.encode(), url, 'text/html')
        session = coverage.Session(fetch, 10, 30)
        with self.assertRaises(PhotoError):
            coverage.nursery_candidate(plant, item, policy, {}, session)

    def test_bounded_run_resumes_and_inventories_unvisited_tail(self):
        first = self.run_job(providers=[self.exact_provider], fetcher=self.fetch_image, request_budget=1)
        self.assertEqual(first['coverage']['plantsWithPhoto'], 1)
        self.assertEqual(len(self.read(coverage.STATE)['plants']), 3)
        second = coverage.run(self.root, refresh_index=False, now=LATER,
                              providers=[self.exact_provider], fetcher=self.fetch_image, request_budget=2)
        self.assertEqual(second['coverage']['plantsWithPhoto'], 3)
        self.assertEqual(second['coverage']['status'], 'complete')

    def test_provider_failure_preserves_verified_assets_and_nonphoto_data(self):
        self.run_job(providers=[self.exact_provider], fetcher=self.fetch_image, request_budget=1)
        before = self.read('data/biljke.json')
        saved = before['plants'][0]['photo']
        asset = (self.root/saved['image']).read_bytes()
        def offline(name, **kwargs):
            raise PhotoError('download_failed', 'offline fixture')
        result = coverage.run(self.root, refresh_index=False, now=LATER, providers=[offline])
        after = self.read('data/biljke.json')
        self.assertEqual(after['plants'][0]['photo'], saved)
        self.assertEqual((self.root/saved['image']).read_bytes(), asset)
        coverage.protect(before, after)
        self.assertEqual(result['coverage']['plantsWithPhoto'], 1)
        self.assertEqual(self.read(coverage.STATE)['plants']['b']['failures'][0]['reason'], 'download_failed')

    def test_old_species_reference_retired_into_internal_manifest(self):
        before = self.read('data/biljke.json')
        old_photo = {'image': 'assets/biljke/reference-0123456789abcdef.jpg',
                     'sourceUrl': 'https://commons.wikimedia.org/wiki/File:Acer.jpg',
                     'taxon': 'Acer campestre', 'matchLevel': 'species_reference',
                     'status': 'verified', 'license': 'CC BY-SA 4.0', 'author': 'Photographer'}
        before['plants'][0]['photo'] = old_photo
        self.write('data/biljke.json', before)
        self.run_job(audit_only=True)
        after = self.read('data/biljke.json')
        self.assertNotIn('photo', after['plants'][0])
        self.assertEqual(self.read(coverage.MANIFEST)['retiredReferences']['a'], old_photo)
        coverage.protect(before, after)

    def test_renamed_taxon_invalidates_photo_and_future_retry(self):
        self.run_job(providers=[self.exact_provider], fetcher=self.fetch_image, request_budget=1)
        data = self.read('data/biljke.json')
        data['plants'] = [data['plants'][0]]
        data['plants'][0]['latinName'] = "Acer campestre 'Red Shine'"
        self.write('data/biljke.json', data)
        state = self.read(coverage.STATE)
        state['plants']['a']['retryAt'] = '2099-01-01T00:00:00Z'
        self.write(coverage.STATE, state)
        seen = []
        def provider(name, **kwargs):
            seen.append(name)
            return iter(())
        self.run_job(providers=[provider])
        self.assertEqual(seen, ["Acer campestre 'Red Shine'"])
        self.assertNotIn('photo', self.read('data/biljke.json')['plants'][0])
        self.assertEqual(self.read(coverage.STATE)['plants']['a']['latinName'], seen[0])

    def test_concurrent_nonphoto_edit_aborts_before_asset_and_data_writes(self):
        before = (self.root/'data/biljke.json').read_bytes()
        def fetch(url, **kwargs):
            self.write('data/rasadnici.json', {'schemaVersion': 1, 'nurseries': [], 'edit': 'outside run'})
            return FetchResult(bitmap(), url, 'image/png')
        with self.assertRaises(PhotoError) as caught:
            self.run_job(providers=[self.exact_provider], fetcher=fetch)
        self.assertEqual(caught.exception.code, 'concurrent_edit')
        self.assertEqual((self.root/'data/biljke.json').read_bytes(), before)
        self.assertFalse((self.root/'assets').exists())

    def test_candidate_hierarchy_uses_suppliers_before_other_nurseries(self):
        plant = self.plants[0]
        policies = {name: {'pageHosts': [name + '.example.org']} for name in ('supplier', 'other')}
        refs = [{'plantId': 'a', 'nurseryId': name, 'sourcePage': 'https://' + name + '.example.org/acer'}
                for name in ('other', 'supplier')]
        offers = [{'id': 'offer', 'plantId': 'a', 'nurseryId': 'supplier'}]
        candidates = coverage.candidates_for(plant, offers, refs, policies, {})
        self.assertEqual([c['nurseryId'] for c in candidates], ['supplier', 'other'])
        self.assertEqual([c['tier'] for c in candidates], [0, 1])

    def test_failed_first_provider_falls_through_to_next(self):
        called = []
        def commons(name, **kwargs):
            called.append(('commons', name))
            raise PhotoError('download_failed', 'Commons unavailable')
        def gbif(name, **kwargs):
            called.append(('gbif', name))
            yield candidate(name)
        result = self.run_job(providers=[commons, gbif], fetcher=self.fetch_image)
        self.assertEqual(result['coverage']['plantsWithPhoto'], 3)
        self.assertEqual([x[0] for x in called], ['commons', 'gbif']*3)

    def test_identical_image_cannot_be_saved_for_different_taxa(self):
        def same_image(url, **kwargs):
            return FetchResult(bitmap(), url, 'image/png')
        session = coverage.Session(same_image, 5, 30)
        pending, manifest = {}, {'plants': {}}
        first, second = copy.deepcopy(self.plants[:2])
        coverage.save_candidate(self.root, first, candidate(first['latinName']), session, pending, manifest)
        with self.assertRaises(PhotoError):
            coverage.save_candidate(self.root, second, candidate(second['latinName']), session, pending, manifest)
        self.assertNotIn('photo', second)
        self.assertEqual(set(manifest['plants']), {first['id']})
        self.assertEqual(len(pending), 1)

    def test_same_exact_taxon_can_reuse_identical_image(self):
        session = coverage.Session(self.fetch_image, 5, 30)
        pending, manifest = {}, {'plants': {}}
        first = copy.deepcopy(self.plants[0])
        second = {**copy.deepcopy(first), 'id': 'same-taxon-another-record'}
        coverage.save_candidate(self.root, first, candidate(first['latinName']), session, pending, manifest)
        coverage.save_candidate(self.root, second, candidate(second['latinName']), session, pending, manifest)
        self.assertEqual(first['photo']['image'], second['photo']['image'])
        self.assertEqual(len(pending), 1)
        self.assertEqual(len(manifest['plants']), 2)

    def test_remaining_offers_does_not_assume_one_native_photo_covers_all(self):
        image = 'assets/biljke/native-a.jpg'
        path = self.root/image
        path.parent.mkdir(parents=True)
        path.write_bytes(bitmap())
        offers = [{'id': 'a-native', 'plantId': 'a', 'image': image},
                  {'id': 'a-empty', 'plantId': 'a'},
                  {'id': 'b-empty', 'plantId': 'b'},
                  {'id': 'c-hidden', 'plantId': 'c', 'recordStatus': 'needs_review'}]
        report = coverage.inventory(self.root, self.plants, offers)
        self.assertEqual(report['plantsWithPhoto'], 1)
        self.assertEqual(report['activeOffers'], 3)
        self.assertEqual(report['remainingOffers'], 2)
        plants = copy.deepcopy(self.plants)
        reference = 'assets/biljke/reference-0123456789abcdef.jpg'
        (self.root/reference).write_bytes(bitmap())
        plants[0]['photo'] = {'image': reference, 'sourceUrl': 'https://example.org/photo'}
        report = coverage.inventory(self.root, plants, offers)
        self.assertEqual(report['remainingOffers'], 1)

    def test_provider_cursor_resumes_at_gbif_after_commons_finishes(self):
        self.write('data/biljke.json', {'schemaVersion': 1, 'updatedAt': NOW, 'plants': self.plants[:1]})
        calls = []
        def commons(name, *, fetcher):
            calls.append('commons')
            fetcher('https://images.example.org/search', hosts=['images.example.org'],
                    timeout=5, max_bytes=100000, kind='page')
            return iter(())
        def gbif(name, **kwargs):
            calls.append('gbif')
            yield candidate(name)
        first = self.run_job(providers=[commons, gbif], fetcher=self.fetch_image, request_budget=1)
        self.assertEqual(first['coverage']['plantsWithPhoto'], 0)
        self.assertEqual(self.read(coverage.STATE)['plants']['a']['nextProvider'], 1)
        calls.clear()
        second = coverage.run(self.root, refresh_index=False, now=LATER, providers=[commons, gbif],
                              fetcher=self.fetch_image, request_budget=1)
        self.assertEqual(calls, ['gbif'])
        self.assertEqual(second['coverage']['plantsWithPhoto'], 1)
        self.assertNotIn('nextProvider', self.read(coverage.STATE)['plants']['a'])


if __name__ == '__main__':
    unittest.main()

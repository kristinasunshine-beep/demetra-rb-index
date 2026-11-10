"""Transactional photo-only pipeline, binding trust, coverage and source policy."""
import copy
from io import BytesIO
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_photo_pipeline as pipeline
from update_photos import FetchResult, PhotoError, supported_page


def raster():
    output = BytesIO()
    Image.new('RGB', (240, 200), (40, 100, 60)).save(output, format='PNG')
    return output.getvalue()


def binding(plant='p1', nursery='n1', name='Acer campestre', offer='o1', path=None):
    url = 'https://nursery.example' + (path or '/plants/' + plant)
    return {'plantId': plant, 'nurseryId': nursery, 'offerIds': [offer],
            'canonicalName': name, 'matchedName': name,
            'pageUrl': url, 'imageUrl': 'https://nursery.example/images/' + plant + '.png',
            'policy': {'nurseryId': nursery, 'pageHosts': ['nursery.example'],
                       'imageHosts': ['nursery.example']},
            'evidence': {'identity': 'exact_full_botanical_name', 'method': 'product_jsonld'}}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.plants = {'schemaVersion': 1, 'sourceDescription': 'archive', 'plants': [
            {'id': 'p1', 'latinName': 'Acer campestre', 'searchAliases': []},
            {'id': 'p2', 'latinName': 'Acer platanoides', 'searchAliases': []}]}
        self.offers = {'schemaVersion': 1, 'sourcePolicy': copy.deepcopy(pipeline.SOURCE_POLICY), 'offers': [
            {'id': 'o1', 'plantId': 'p1', 'nurseryId': 'n1', 'image': '', 'price': 450, 'circumference': '25–30'},
            {'id': 'o2', 'plantId': 'p2', 'nurseryId': 'n1', 'image': '', 'price': 280, 'circumference': '16–18'},
            {'id': 'o3', 'plantId': 'p1', 'nurseryId': 'n2', 'image': '', 'price': 310, 'height': '200–250'}]}
        self.config = {'schemaVersion': 1, 'sources': [
            {'nurseryId': 'n1', 'resolver': 'direct', 'fillMissing': False,
             'pageHosts': ['nursery.example'], 'imageHosts': ['nursery.example']}]}
        self.put('data/biljke.json', self.plants)
        self.put('data/kataloske-stavke.json', self.offers)
        self.put('data/rasadnici.json', {'nurseries': [
            {'id': 'n1', 'website': 'https://nursery.example/', 'verificationStatus': 'verified'},
            {'id': 'n2', 'website': 'https://other.example/', 'verificationStatus': 'verified'}]})
        self.put('scripts/photo-sources.json', self.config)
        self.put('scripts/photo-discovery.json', {'schemaVersion': 1, 'sources': []})
        self.put('docs/fotografije.json', {'photos': []})
        (self.root/'assets/biljke').mkdir(parents=True)

    def put(self, path, obj, root=None):
        pipeline.write((root or self.root)/path, obj)

    def get(self, path):
        return pipeline.read(self.root/path)

    def fetch(self, url, **kwargs):
        return FetchResult(raster(), url, 'image/png')

    def run_small(self, **kwargs):
        return pipeline.run_pipeline(self.root, refresh=False, discovery_budget=0, reference_budget=0, **kwargs)

    def test_multiple_discovered_paths_remain_valid_on_future_refresh(self):
        result = pipeline.apply_discovered_bindings(self.root, [binding(), binding('p2', name='Acer platanoides', offer='o2')], self.fetch)
        self.assertEqual(result['added'], 2)
        policy = self.get('scripts/photo-sources.json')['sources'][0]
        self.assertTrue(supported_page(policy, 'https://nursery.example/plants/p1'))
        self.assertTrue(supported_page(policy, 'https://nursery.example/plants/p2'))
        self.assertFalse(supported_page(policy, 'https://nursery.example/plants/unknown'))
        self.assertEqual(len(policy['discoveredPagePatterns']), 2)
        after = self.get('data/kataloske-stavke.json')
        self.assertEqual([x['price'] for x in after['offers']], [450, 280, 310])
        self.assertEqual(after['offers'][2]['image'], '')
        pipeline.photo_only_guard(self.offers, after, self.plants, self.get('data/biljke.json'))

    def test_policy_merge_preserves_reviewed_pattern_and_cdn_prefix(self):
        old = {'nurseryId': 'n1', 'resolver': 'product', 'fillMissing': True,
               'pageHosts': ['nursery.example'], 'imageHosts': ['cdn.example'],
               'pagePathPattern': '/product/[a-z-]+/', 'imagePathPrefixes': {'cdn.example': ['/1298/']}}
        new = {'nurseryId': 'n1', 'pageHosts': ['nursery.example'],
               'imageHosts': ['nursery.example', 'cdn.example']}
        merged = pipeline.merge_policy(old, new, 'https://nursery.example/plants/p1')
        again = pipeline.merge_policy(merged, new, 'https://nursery.example/plants/p1')
        self.assertEqual(merged, again)
        self.assertEqual(merged['imagePathPrefixes'], {'cdn.example': ['/1298/']})
        self.assertTrue(supported_page(merged, 'https://nursery.example/product/acer/'))
        self.assertTrue(supported_page(merged, 'https://nursery.example/plants/p1'))

    def test_binding_cannot_grant_arbitrary_cdn_permissions(self):
        bad = binding()
        bad['imageUrl'] = 'https://foreign.example/image.png'
        bad['policy']['imageHosts'].append('foreign.example')
        calls = []
        def forbidden(*args, **kwargs):
            calls.append(args)
            return self.fetch(*args, **kwargs)
        result = pipeline.apply_discovered_bindings(self.root, [bad], forbidden)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['requests'], 0)
        self.assertFalse(calls)
        self.assertEqual(self.get('data/kataloske-stavke.json'), self.offers)

    def test_binding_must_preserve_exact_cultivar_and_nursery(self):
        bads = []
        bad = binding(); bad['offerIds'] = ['o3']; bads.append(bad)
        bad = binding(); bad['matchedName'] = 'campestre'; bads.append(bad)
        bad = binding(); bad['canonicalName'] = "Acer campestre 'Elsrijk'"; bads.append(bad)
        bad = binding(); bad['policy']['nurseryId'] = 'n2'; bads.append(bad)
        for bad in bads:
            result = pipeline.apply_discovered_bindings(self.root, [bad], self.fetch)
            self.assertEqual(result['sources'][0]['reason'], 'binding_identity')
            self.assertEqual(result['requests'], 0)

    def test_network_failure_preserves_existing_files_and_photos(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        def failure(*args, **kwargs):
            raise PhotoError('http_error', '503')
        result = pipeline.apply_discovered_bindings(self.root, [binding()], failure)
        self.assertEqual(result['failed'], 1)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_photo_guard_checks_envelopes_order_duplicate_ids_and_nested_prices(self):
        changes = [
            lambda o,p: o['offers'][0].update(price=1),
            lambda o,p: o['offers'].reverse(),
            lambda o,p: o['offers'].append(copy.deepcopy(o['offers'][0])),
            lambda o,p: p.update(sourceDescription='web'),
            lambda o,p: p['plants'][0].update(latinName='Acer rubrum'),
            lambda o,p: o['sourcePolicy'].update(onlineUpdates=['prices']),
        ]
        for change in changes:
            with self.subTest(change=change):
                offers, plants = copy.deepcopy(self.offers), copy.deepcopy(self.plants)
                change(offers, plants)
                with self.assertRaises(PhotoError):
                    pipeline.photo_only_guard(self.offers, offers, self.plants, plants)

    def test_pipeline_integrity_failure_never_reaches_repository(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        def damaging(path):
            doc = pipeline.read(path/'data/kataloske-stavke.json')
            doc['offers'][0]['price'] = 1
            self.put('data/kataloske-stavke.json', doc, path)
            return {'added': 1}
        with patch.object(pipeline, 'propagate_same_pair', damaging):
            with self.assertRaises(PhotoError) as error:
                self.run_small()
        self.assertEqual(error.exception.code, 'non_photo_change')
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_stage_failure_rolls_back_and_later_reference_stage_can_finish(self):
        def failed_discovery(path, **kwargs):
            self.put('docs/photo-discovery-state.json', {'partial': 'must not survive'}, path)
            raise OSError('Source unavailable')
        def reference(path, **kwargs):
            doc = pipeline.read(path/'data/biljke.json')
            doc['plants'][0]['photo'] = {'status': 'verified', 'image': 'assets/biljke/reference.jpg'}
            (path/'assets/biljke/reference.jpg').write_bytes(raster())
            self.put('data/biljke.json', doc, path)
            return {'status': 'completed', 'added': 1}
        with patch('discover_nursery_photos.discover', failed_discovery), patch('reference_photos.run_reference_update', reference):
            result = pipeline.run_pipeline(self.root, refresh=False, discovery_budget=3, reference_budget=3)
        self.assertEqual(result['stages']['discovery']['status'], 'failed')
        self.assertTrue(result['stages']['discovery']['rolledBack'])
        self.assertEqual(result['stages']['references']['added'], 1)
        self.assertTrue(result['committed'])
        self.assertEqual(result['status'], 'partial_failure')
        self.assertFalse((self.root/'docs/photo-discovery-state.json').exists())
        self.assertEqual(self.get('data/kataloske-stavke.json'), self.offers)
        self.assertEqual(result['coverage']['referencePhotos'], 2)

    def test_concurrent_catalogue_edit_is_not_overwritten(self):
        def concurrent(path):
            changed = copy.deepcopy(self.offers)
            changed['offers'][0]['price'] = 999
            self.put('data/kataloske-stavke.json', changed)
            return {'added': 0}
        with patch.object(pipeline, 'propagate_same_pair', concurrent):
            with self.assertRaises(PhotoError) as error:
                self.run_small()
        self.assertEqual(error.exception.code, 'concurrent_edit')
        self.assertEqual(self.get('data/kataloske-stavke.json')['offers'][0]['price'], 999)
        self.assertFalse((self.root/'docs/photo-pipeline-report.json').exists())

    def test_report_exposes_worker_source_failures_even_without_an_exception(self):
        with patch('discover_nursery_photos.discover', return_value={'status': 'partial_failure', 'bindings': [], 'errors': [{'reason': 'http_error'}]}):
            result = pipeline.run_pipeline(self.root, refresh=False, discovery_budget=2, reference_budget=0)
        self.assertEqual(result['status'], 'partial_failure')
        self.assertEqual(result['stagesWithSourceErrors'], ['discovery'])
        self.assertTrue(result['committed'])

    def test_dry_run_has_no_repository_writes(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.run_small(dry_run=True)
        self.assertFalse(result['committed'])
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_same_pair_copy_does_not_cross_nursery_or_copy_hidden_offers(self):
        self.offers['offers'].append({**copy.deepcopy(self.offers['offers'][0]), 'id': 'o4'})
        self.offers['offers'].append({**copy.deepcopy(self.offers['offers'][0]), 'id': 'o5', 'recordStatus': 'needs_review'})
        donor = self.offers['offers'][0]
        donor.update(image='assets/biljke/donor.jpg', imageKind='Kataloška fotografija rasadnika', imageSourceUrl='https://nursery.example/p1')
        (self.root/'assets/biljke/donor.jpg').write_bytes(raster())
        self.put('data/kataloske-stavke.json', self.offers)
        result = pipeline.propagate_same_pair(self.root)
        offers = {o['id']:o for o in self.get('data/kataloske-stavke.json')['offers']}
        self.assertEqual(result['added'], 1)
        self.assertEqual(offers['o4']['image'], donor['image'])
        self.assertEqual(offers['o3']['image'], '')
        self.assertEqual(offers['o5']['image'], '')

    def test_coverage_does_not_count_a_missing_local_asset(self):
        self.offers['offers'][0]['image'] = 'assets/biljke/missing.jpg'
        self.plants['plants'][0]['photo'] = {'status': 'verified', 'image': 'assets/biljke/also-missing.jpg'}
        self.put('data/kataloske-stavke.json', self.offers)
        self.put('data/biljke.json', self.plants)
        result = pipeline.coverage(self.root)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['remainingOffers'], 3)
        self.assertEqual(result['plantsWithPhoto'], 0)

    def test_refresh_cursor_reaches_later_records_and_preserves_catalogue_order(self):
        self.put('docs/fotografije.json', {'photos': [
            {'offerId': 'o1', 'sourcePage': 'https://nursery.example/plants/p1'},
            {'offerId': 'o2', 'sourcePage': 'https://nursery.example/plants/p2'}]})
        batches = []
        before = (self.root/'data/kataloske-stavke.json').read_bytes()
        def updater(path, **kwargs):
            doc = pipeline.read(path/'data/kataloske-stavke.json')
            selected = doc['offers'][:kwargs['limit']]
            batches.append([o['id'] for o in selected])
            return {'status': 'completed', 'sources': [{'offerId': o['id'], 'status': 'verified_unchanged'} for o in selected]}
        with patch.object(pipeline, 'run_update', updater):
            first = pipeline.refresh_connected(self.root, limit=1)
            second = pipeline.refresh_connected(self.root, limit=1)
        self.assertEqual(batches, [['o1'], ['o2']])
        self.assertEqual(first['nextOfferId'], 'o2')
        self.assertEqual(second['nextOfferId'], 'o1')
        self.assertEqual((self.root/'data/kataloske-stavke.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

"""Source restrictions, saved-cache migration and official-catalogue refresh."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import full_photo_coverage as core
import parallel_photo_coverage as parallel
import photo_source_policy as policy
import test_full_photo_coverage as fixtures
from update_photos import PhotoError, FetchResult, to_jpeg, DEFAULT_LIMITS


class OfferPhotoPolicyTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.FullCoverageTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.root = self.f.root

    def seed(self):
        self.f.run_job(providers=[self.f.exact_provider], fetcher=self.f.fetch_image)

    def test_configured_nursery_without_any_offer_is_not_a_photo_source(self):
        config = self.f.read('data/rasadnici.json')
        config['nurseries'].append({'id':'outsider','website':'https://outside.example.org','verificationStatus':'verified'})
        self.f.write('data/rasadnici.json', config)
        self.assertNotIn('outsider', policy.allowed_policies(self.root))

    def test_source_page_image_host_and_cdn_prefix_are_all_checked(self):
        candidate = fixtures.candidate('Acer campestre')
        policies = policy.allowed_policies(self.root)
        self.assertTrue(policy.candidate_allowed(candidate, policies))
        for changes in ({'sourceUrl':'https://example.org.evil.test/photo'},
                        {'imageUrl':'https://outside.example.org/a.jpg'},
                        {'nurseryId':'outsider'}, {'provider':'commons'}, {'provider':'gbif'}):
            self.assertFalse(policy.candidate_allowed({**candidate, **changes}, policies))
        policies['fixture']['imagePathPrefixes']={'images.example.org':['/catalogue/']}
        self.assertFalse(policy.candidate_allowed(candidate, policies))

    def test_unapproved_candidate_is_rejected_before_network_or_storage(self):
        candidate = {**fixtures.candidate('Acer campestre'), 'provider':'gbif'}
        def forbidden(*args, **kwargs):
            self.fail('An excluded source must never be contacted')
        session = core.Session(forbidden, 10, 10)
        with self.assertRaisesRegex(PhotoError, 'Only official'):
            core.save_candidate(self.root, self.f.plants[0], candidate, session, {}, {'plants':{}})
        self.assertEqual(session.requests, 0)

    def test_old_public_reference_is_rejected_then_retired_without_other_changes(self):
        self.seed()
        manifest = self.f.read(core.MANIFEST)
        manifest['plants']['a']['provider']='gbif'
        self.f.write(core.MANIFEST, manifest)
        before = self.f.read('data/biljke.json')
        with self.assertRaises(ValueError):
            policy.validate_sources(self.root)
        self.f.run_job(audit_only=True)
        after = self.f.read('data/biljke.json')
        core.protect(before, after)
        self.assertNotIn('photo', after['plants'][0])
        self.assertEqual(self.f.read(core.MANIFEST)['sourcePolicyRetirements']['a']['reason'], 'outside_offer_nurseries')
        self.assertEqual(policy.validate_sources(self.root)['plantPhotos'], 2)

    def test_disallowed_saved_cache_cannot_reintroduce_a_photo(self):
        cache = self.root/'cache'; cache.mkdir()
        candidate = {**fixtures.candidate(self.f.plants[0]['latinName']), 'provider':'commons'}
        body = to_jpeg(fixtures.bitmap(), DEFAULT_LIMITS)
        (cache/'a.jpg').write_bytes(body)
        self.f.write('cache/a.json', {'candidate':candidate,'catalogueName':self.f.plants[0]['latinName'],'sha256':core.digest(body)})
        parallel.run(self.root, cache_dir=cache, request_budget=0, max_seconds=10)
        self.assertTrue(all(not p.get('photo') for p in self.f.read('data/biljke.json')['plants']))

    def test_offline_offer_requires_verified_archive_evidence(self):
        offer = {'nurseryId':'fixture','dataOrigin':'rasadnici-ponude-zip','sourceEvidence':{'archiveVerified':True,'sourceFile':'offer.xlsx','sourceSha256':'a'*64}}
        policies=policy.allowed_policies(self.root)
        self.assertTrue(policy.offer_allowed(offer, policies, {'fixture'}))
        self.assertFalse(policy.offer_allowed({**offer,'sourceEvidence':{}}, policies, {'fixture'}))
        self.assertFalse(policy.offer_allowed({**offer,'imageSourceUrl':'https://outside.test/a.jpg'}, policies, {'fixture'}))

    def stale_photo(self):
        self.seed()
        manifest = self.f.read(core.MANIFEST)
        manifest['plants']['a']['checkedAt']='2000-01-01T00:00:00Z'
        self.f.write(core.MANIFEST, manifest)
        return self.f.read('data/biljke.json')['plants'][0]['photo']

    def test_existing_photograph_refreshes_from_exact_official_product_page(self):
        before = self.stale_photo()
        name = self.f.plants[0]['latinName']
        calls=[]
        def fetch(url, **kwargs):
            calls.append(url)
            if kwargs['kind']=='page':
                html='<h1>'+name+'</h1><img class="wp-post-image" src="https://images.example.org/new.jpg">'
                return FetchResult(html.encode(), url, 'text/html')
            return FetchResult(fixtures.bitmap((190,20,90)), url, 'image/png')
        report = parallel.run(self.root, fetcher=fetch, cache_dir=self.root/'cache', max_seconds=30)
        after = self.f.read('data/biljke.json')['plants'][0]['photo']
        self.assertNotEqual(before['image'], after['image'])
        self.assertEqual(before['sourceUrl'], after['sourceUrl'])
        self.assertEqual(report['refreshCandidates'], 1)
        self.assertEqual(len(calls), 2)

    def test_failed_refresh_preserves_previous_verified_photo(self):
        before = self.stale_photo()
        def offline(*args, **kwargs):
            raise PhotoError('download_failed','Source temporarily unavailable')
        parallel.run(self.root, fetcher=offline, cache_dir=self.root/'cache', max_seconds=10)
        self.assertEqual(before, self.f.read('data/biljke.json')['plants'][0]['photo'])

    def test_parallel_candidate_cursor_advances_beyond_first_thirty(self):
        items=[{'nurseryId':'fixture','pageUrl':'https://example.org/'+str(i),'tier':0} for i in range(35)]
        seen=[]
        def candidate(plant,item,*args):
            seen.append(item['pageUrl'])
            raise PhotoError('identity_missing','Not this cultivar')
        with patch.object(core,'candidates_for',return_value=items), patch.object(core,'nursery_candidate',side_effect=candidate):
            parallel.run(self.root, plant_ids={'a'},cache_dir=self.root/'cache',max_seconds=10)
            self.assertEqual(len(seen),30)
            seen.clear()
            parallel.run(self.root, plant_ids={'a'},cache_dir=self.root/'cache',max_seconds=10)
        self.assertEqual(seen,[i['pageUrl'] for i in items[30:]])


if __name__ == '__main__':
    unittest.main()

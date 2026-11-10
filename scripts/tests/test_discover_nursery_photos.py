import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discover_nursery_photos import discover, names_for, sitemap_links, STATE_PATH
from update_photos import FetchResult, PhotoError


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for name in ['data', 'scripts', 'docs']:
            (self.root / name).mkdir()
        self.plant = {'id': 'acer-red', 'latinName': "Acer palmatum 'Red Dragon'",
                      'synonyms': [], 'searchAliases': ['Red Dragon']}
        self.offers = [{'id': 'o1', 'plantId': 'acer-red', 'nurseryId': 'n1', 'image': '',
                        'price': 250, 'height': '200 cm', 'recordStatus': 'active'},
                       {'id': 'o2', 'plantId': 'acer-red', 'nurseryId': 'n1', 'image': '',
                        'price': 300, 'height': '300 cm', 'recordStatus': 'active'}]
        self.write('data/biljke.json', {'plants': [self.plant]})
        self.write('data/rasadnici.json', {'nurseries': [{'id': 'n1', 'website': 'https://nursery.test/',
                                                        'verificationStatus': 'verified'}]})
        self.write('data/kataloske-stavke.json', {'offers': self.offers})
        self.write('scripts/photo-sources.json', {'sources': []})
        self.calls = []
        self.product = 'https://nursery.test/acer-palmatum-red-dragon'
        self.routes = {
            'https://nursery.test/robots.txt': ('text/plain', 'User-agent: *\nSitemap: https://nursery.test/map.xml'),
            'https://nursery.test/map.xml': ('application/xml', self.sitemap([self.product])),
            'https://nursery.test/': ('text/html', '<html><h1>Nursery</h1></html>'),
            self.product: ('text/html', self.html(self.plant['latinName'])),
        }

    def write(self, path, doc):
        (self.root / path).write_text(json.dumps(doc))

    def sitemap(self, urls):
        return '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join('<url><loc>' + u + '</loc></url>' for u in urls) + '</urlset>'

    def html(self, name, image='https://nursery.test/images/acer.jpg'):
        data = json.dumps({'@type': 'Product', 'name': name, 'image': image})
        return '<html><h1>' + name + '</h1><script type="application/ld+json">' + data + '</script></html>'

    def fetch(self, url, **kwargs):
        self.calls.append(url)
        if url not in self.routes:
            raise PhotoError('http_error', 'Source returned HTTP 404.')
        content_type, text = self.routes[url]
        if isinstance(text, Exception):
            raise text
        return FetchResult(text.encode(), url, content_type)

    def run_discovery(self, **kwargs):
        return discover(self.root, fetcher=self.fetch, now='2026-11-09T15:00:00Z', **kwargs)

    def test_exact_cultivar_groups_all_offer_sizes_and_protects_non_photo_data(self):
        before = (self.root / 'data/kataloske-stavke.json').read_bytes()
        r = self.run_discovery(budget=20)
        self.assertEqual(r['confirmedPairs'], 1)
        self.assertEqual(r['bindings'][0]['offerIds'], ['o1', 'o2'])
        self.assertEqual(r['bindings'][0]['matchedName'], "Acer palmatum 'Red Dragon'")
        self.assertEqual(r['bindings'][0]['policy']['pagePathPattern'], '/acer\\-palmatum\\-red\\-dragon')
        self.assertEqual((self.root / 'data/kataloske-stavke.json').read_bytes(), before)
        self.assertEqual(self.calls.count(self.product), 1)

    def test_different_cultivar_is_not_a_match_even_if_url_mentions_expected_name(self):
        self.routes[self.product] = ('text/html', self.html("Acer palmatum 'Bloodgood'"))
        r = self.run_discovery(budget=20)
        self.assertEqual(r['bindings'], [])
        self.assertEqual(r['pending'][0]['candidates'][0]['reason'], 'plant_identity_mismatch')

    def test_short_alias_never_matches_by_cultivar_alone(self):
        self.assertEqual(names_for(self.plant), [self.plant['latinName']])
        self.routes[self.product] = ('text/html', self.html('Red Dragon'))
        self.assertEqual(self.run_discovery(budget=20)['bindings'], [])

    def test_external_nursery_links_and_unreviewed_cdn_are_rejected(self):
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap([
            'https://competitor.test/acer-palmatum-red-dragon', self.product]))
        self.routes[self.product] = ('text/html', self.html(self.plant['latinName'], 'https://other-cdn.test/acer.jpg'))
        r = self.run_discovery(budget=20)
        self.assertEqual(r['bindings'], [])
        self.assertFalse(any('competitor' in c for c in self.calls))
        self.assertEqual(r['pending'][0]['candidates'][0]['reason'], 'unapproved_url')

    def test_budget_state_resumes_without_repeating_robots(self):
        first = self.run_discovery(budget=1)
        self.assertEqual(first['requests'], 1)
        self.assertEqual(first['confirmedPairs'], 0)
        self.assertTrue((self.root / STATE_PATH).exists())
        second = self.run_discovery(budget=20)
        self.assertEqual(second['confirmedPairs'], 1)
        self.assertEqual(self.calls.count('https://nursery.test/robots.txt'), 1)
        self.assertEqual(self.calls.count(self.product), 1)

    def test_confirmed_binding_is_reused_without_network_until_index_refresh(self):
        self.run_discovery(budget=20)
        self.calls.clear()
        second = self.run_discovery(budget=20)
        self.assertEqual(second['confirmedPairs'], 1)
        self.assertEqual(second['requests'], 0)
        self.assertEqual(self.calls, [])

    def test_expired_binding_rechecks_product_page_for_replaced_image_url(self):
        self.run_discovery(budget=20)
        self.calls.clear()
        self.routes[self.product] = ('text/html', self.html(self.plant['latinName'], 'https://nursery.test/images/new.jpg'))
        again = discover(self.root, fetcher=self.fetch, now='2026-11-17T15:00:00Z', budget=20)
        self.assertEqual(self.calls, [self.product])
        self.assertEqual(again['bindings'][0]['imageUrl'], 'https://nursery.test/images/new.jpg')

    def test_bot_block_stops_other_requests_to_same_host(self):
        self.routes['https://nursery.test/robots.txt'] = ('text/html', '<title>Just a moment</title><h1>Verify you are human</h1>')
        r = self.run_discovery(budget=20)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(r['errors'][0]['reason'], 'site_blocked')
        self.assertEqual(r['bindings'], [])

    def test_robots_disallow_is_respected(self):
        self.routes['https://nursery.test/robots.txt'] = ('text/plain', 'User-agent: *\nDisallow: /\nSitemap: https://nursery.test/map.xml')
        r = self.run_discovery(budget=20)
        self.assertEqual(self.calls, ['https://nursery.test/robots.txt'])
        self.assertEqual(r['bindings'], [])

    def test_dry_run_does_not_write_discovery_state(self):
        r = self.run_discovery(budget=20, dry_run=True)
        self.assertEqual(r['confirmedPairs'], 1)
        self.assertFalse((self.root / STATE_PATH).exists())

    def test_unknown_nursery_does_not_guess_a_website(self):
        self.write('data/rasadnici.json', {'nurseries': [{'id': 'n1', 'website': '', 'verificationStatus': 'unresolved'}]})
        r = self.run_discovery(budget=20)
        self.assertEqual(self.calls, [])
        self.assertEqual(r['pending'][0]['reason'], 'nursery_identity_or_website_unverified')

    def test_sitemap_nested_image_location_is_not_a_product_url(self):
        text = '<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://nursery.test/acer</loc><image:image><image:loc>https://nursery.test/image.jpg</image:loc></image:image></url></urlset>'
        _, urls = sitemap_links(text.encode(), 'https://nursery.test/map.xml', ['nursery.test'], 100)
        self.assertEqual(urls, ['https://nursery.test/acer'])

    def test_failed_candidate_is_retried_after_retry_window(self):
        self.routes[self.product] = ('text/html', self.html("Acer palmatum 'Bloodgood'"))
        self.run_discovery(budget=20)
        self.routes[self.product] = ('text/html', self.html(self.plant['latinName']))
        self.calls.clear()
        r = discover(self.root, fetcher=self.fetch, now='2026-11-17T15:00:00Z', budget=20)
        self.assertEqual(r['confirmedPairs'], 1)
        self.assertEqual(self.calls, [self.product])

    def test_later_candidate_resumes_next_run_without_retrying_first_three(self):
        urls = ['https://nursery.test/' + prefix + '-acer-palmatum-red-dragon'
                for prefix in ('a', 'b', 'c', 'd')]
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap(urls))
        for url in urls[:3]:
            self.routes[url] = ('text/html', self.html("Acer palmatum 'Bloodgood'"))
        self.routes[urls[3]] = ('text/html', self.html(self.plant['latinName']))
        first = self.run_discovery(budget=20)
        self.assertEqual(first['confirmedPairs'], 0)
        self.assertEqual(first['status'], 'partial_budget')
        self.assertNotIn(urls[3], self.calls)
        self.calls.clear()
        second = self.run_discovery(budget=20)
        self.assertEqual(second['confirmedPairs'], 1)
        self.assertEqual(self.calls, [urls[3]])
        self.assertEqual(second['bindings'][0]['matchedName'], self.plant['latinName'])

    def test_candidate_cursor_resumes_after_global_request_budget(self):
        urls = ['https://nursery.test/' + prefix + '-acer-palmatum-red-dragon'
                for prefix in ('a', 'b', 'c', 'd')]
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap(urls))
        for url in urls[:3]:
            self.routes[url] = ('text/html', self.html("Acer palmatum 'Bloodgood'"))
        self.routes[urls[3]] = ('text/html', self.html(self.plant['latinName']))
        first = self.run_discovery(budget=4)
        self.assertEqual(first['requests'], 4)
        self.assertEqual([url for url in self.calls if url in urls], urls[:2])
        self.calls.clear()
        second = self.run_discovery(budget=4)
        self.assertLessEqual(second['requests'], 4)
        self.assertEqual(second['confirmedPairs'], 1)
        self.assertEqual([url for url in self.calls if url in urls], urls[2:])

    def test_new_candidate_beyond_failed_batch_invalidates_retry_fingerprint(self):
        urls = ['https://nursery.test/' + prefix + '-acer-palmatum-red-dragon'
                for prefix in ('a', 'b', 'c', 'd')]
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap(urls[:3]))
        for url in urls[:3]:
            self.routes[url] = ('text/html', self.html("Acer palmatum 'Bloodgood'"))
        self.routes[urls[3]] = ('text/html', self.html(self.plant['latinName']))
        first = self.run_discovery(budget=20)
        self.assertEqual(first['pending'][0]['reason'], 'candidate_not_confirmed')
        state = json.loads((self.root / STATE_PATH).read_text())
        state['nurseries']['n1']['pages'].append(urls[3])
        self.write(STATE_PATH, state)
        self.calls.clear()
        self.run_discovery(budget=20)
        final = self.run_discovery(budget=20)
        self.assertEqual(final['confirmedPairs'], 1)
        self.assertEqual(self.calls, urls)

    def test_product_sitemap_precedes_taxonomies_with_small_budget(self):
        root_map = '<sitemapindex>' + ''.join('<sitemap><loc>https://nursery.test/' + u + '</loc></sitemap>'
            for u in ['author-sitemap.xml', 'category-sitemap.xml', 'product-sitemap.xml']) + '</sitemapindex>'
        self.routes['https://nursery.test/map.xml'] = ('application/xml', root_map)
        self.routes['https://nursery.test/product-sitemap.xml'] = ('application/xml', self.sitemap([self.product]))
        self.routes['https://nursery.test/author-sitemap.xml'] = ('application/xml', self.sitemap([]))
        self.routes['https://nursery.test/category-sitemap.xml'] = ('application/xml', self.sitemap([]))
        r = self.run_discovery(budget=8)
        self.assertEqual(r['confirmedPairs'], 1)
        self.assertLess(self.calls.index('https://nursery.test/product-sitemap.xml'),
                        self.calls.index('https://nursery.test/author-sitemap.xml'))

    def test_large_official_xml_map_has_separate_bounded_byte_budget(self):
        self.routes['https://nursery.test/map.xml'] = ('application/xml',
            self.sitemap([self.product]).replace('<urlset ', '<!--' + ' ' * 3_100_000 + '--><urlset ', 1))
        r = self.run_discovery(budget=20)
        self.assertEqual(r['confirmedPairs'], 1)

    def test_bot_block_is_paused_across_immediate_runs(self):
        self.routes['https://nursery.test/robots.txt'] = ('text/html', '<title>Just a moment</title>')
        self.run_discovery(budget=20)
        self.calls.clear()
        self.run_discovery(budget=20)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

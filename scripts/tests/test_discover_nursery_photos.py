import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discover_nursery_photos import discover, names_for, sitemap_links, candidate_rank, STATE_PATH, INDEX_VERSION
from update_photos import FetchResult, PhotoError


class DiscoveryTests(unittest.TestCase):
    def test_observed_botanical_slug_before_numeric_product_id_is_ranked(self):
        url = 'https://www.lve-baumschule.de/fagus-sylvatica-riversii/6353661'
        self.assertEqual(candidate_rank(url, ["Fagus sylvatica 'Riversii'"]), 100)
        self.assertEqual(candidate_rank(url, ["Fagus sylvatica 'Dawyck'"]), 0)

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

    def test_legacy_consumed_failed_sitemap_reenters_index_queue(self):
        old_map = 'https://nursery.test/old-map.xml'
        self.routes[old_map] = ('application/xml', self.sitemap([self.product]))
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap([]))
        self.write(STATE_PATH, {'schemaVersion': 1, 'pairs': {}, 'nurseries': {'n1': {
            'indexedAt': '2026-11-08T12:00:00Z', 'frontier': [], 'visited': [old_map],
            'pages': [], 'robots': {}, 'failedResources': {},
            'lastError': {'url': old_map, 'reason': 'timeout', 'at': '2026-11-08T12:00:00Z'}}}})
        result = self.run_discovery(budget=20, index_only=True)
        saved = json.loads((self.root / STATE_PATH).read_text())['nurseries']['n1']
        self.assertIn(old_map, self.calls)
        self.assertIn(self.product, saved['pages'])
        self.assertNotIn(old_map, saved['failedResources'])
        self.assertNotIn('lastError', saved)
        self.assertEqual(result['bindings'], [])
        self.assertNotIn(self.product, self.calls, 'Indexing must not fetch product candidates')

    def test_transport_resource_retry_is_one_day_without_refreshing_successful_index(self):
        failed = 'https://nursery.test/retry.xml'
        self.routes[failed] = ('application/xml', self.sitemap([self.product]))
        failure = {'url': failed, 'reason': 'download_failed', 'at': '2026-11-08T12:00:00Z'}
        self.write(STATE_PATH, {'schemaVersion': 1, 'pairs': {}, 'nurseries': {'n1': {
            'indexVersion': INDEX_VERSION, 'indexedAt': '2026-11-08T12:00:00Z',
            'frontier': [], 'visited': [failed], 'pages': [], 'robots': {},
            'failedResources': {failed: failure}}}})
        result = self.run_discovery(budget=20, index_only=True)
        self.assertEqual(self.calls, [failed])
        self.assertEqual(result['indexedPages'], 1)
        self.calls.clear()
        self.run_discovery(budget=20, index_only=True)
        self.assertEqual(self.calls, [])

    def test_index_follows_observed_catalogue_and_pagination_not_external_or_action_links(self):
        catalogue = 'https://nursery.test/plants'
        page_two = catalogue + '?page=2'
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap([]))
        self.routes['https://nursery.test/'] = ('text/html', '<a href="/plants">Catalogue</a>')
        self.routes[catalogue] = ('text/html', '<a rel="next" href="?page=2">Next</a>'
                                 '<a href="https://competitor.test/plants">Other</a>'
                                 '<a href="/shop?add-to-cart=42">Buy</a>')
        self.routes[page_two] = ('text/html', '<a href="' + self.product + '">Red Dragon</a>')
        result = self.run_discovery(budget=20, index_only=True)
        saved = json.loads((self.root / STATE_PATH).read_text())['nurseries']['n1']
        self.assertIn(catalogue, self.calls)
        self.assertIn(page_two, self.calls)
        self.assertIn(self.product, saved['pages'])
        self.assertNotIn(self.product, self.calls)
        self.assertFalse(any('competitor.test' in url or 'add-to-cart' in url for url in self.calls))
        self.assertFalse(result['coverageComplete'], 'An index alone does not confirm plant photographs')

    def test_index_only_uses_full_budget_and_retains_sitemap_continuation(self):
        maps = ['https://nursery.test/product-sitemap-' + str(i) + '.xml' for i in range(4)]
        self.routes['https://nursery.test/map.xml'] = ('application/xml', '<sitemapindex>' + ''.join(
            '<sitemap><loc>' + url + '</loc></sitemap>' for url in maps) + '</sitemapindex>')
        for i, url in enumerate(maps):
            self.routes[url] = ('application/xml', self.sitemap([self.product + '-' + str(i)]))
        result = self.run_discovery(budget=4, index_only=True)
        self.assertEqual(result['requests'], 4)
        self.assertEqual(result['indexedPages'], 2)
        self.assertGreater(result['queuedResources'], 0)
        self.assertEqual(result['status'], 'partial_budget')
        self.calls.clear()
        again = self.run_discovery(budget=20, index_only=True)
        self.assertEqual(again['indexedPages'], 4)
        self.assertNotIn('https://nursery.test/robots.txt', self.calls)

    def test_visited_frontier_head_does_not_hide_new_resource(self):
        stale = 'https://nursery.test/already.xml'
        self.write(STATE_PATH, {'schemaVersion': 1, 'pairs': {}, 'nurseries': {'n1': {
            'indexVersion': INDEX_VERSION, 'indexedAt': '2026-11-09T12:00:00Z',
            'frontier': [stale, 'https://nursery.test/map.xml'], 'visited': [stale], 'pages': [], 'robots': {}}}})
        self.run_discovery(budget=20, index_only=True)
        self.assertEqual(self.calls, ['https://nursery.test/map.xml'])

    def test_blocked_frontier_head_does_not_starve_other_approved_host(self):
        other = 'https://catalogue.nursery.test/map.xml'
        self.write('scripts/photo-discovery.json', {'sources': [{'nurseryId': 'n1',
                   'pageHosts': ['catalogue.nursery.test']}]})
        self.routes[other] = ('application/xml', self.sitemap([self.product]))
        self.write(STATE_PATH, {'schemaVersion': 1, 'pairs': {}, 'nurseries': {'n1': {
            'indexVersion': INDEX_VERSION, 'indexedAt': '2026-11-09T12:00:00Z',
            'frontier': ['https://nursery.test/map.xml', other], 'visited': [], 'pages': [], 'robots': {},
            'blockedHosts': {'nursery.test': '2026-11-09T12:00:00Z'}}}})
        self.run_discovery(budget=20, index_only=True)
        self.assertEqual(self.calls, [other])

    def test_http_access_refusal_remains_paused_despite_short_resource_retry(self):
        self.routes['https://nursery.test/robots.txt'] = ('text/plain', PhotoError('http_error', 'Source returned HTTP 403.'))
        self.run_discovery(budget=20, index_only=True)
        self.assertEqual(self.calls, ['https://nursery.test/robots.txt'])
        self.calls.clear()
        discover(self.root, fetcher=self.fetch, now='2026-11-11T15:00:00Z', budget=20, index_only=True)
        self.assertEqual(self.calls, [], '403 cooldown must not be shortened to transport retry')

    def test_catalogue_crawl_respects_robots_for_observed_navigation(self):
        self.routes['https://nursery.test/robots.txt'] = ('text/plain', 'User-agent: *\nDisallow: /plants\nSitemap: https://nursery.test/map.xml')
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap([]))
        self.routes['https://nursery.test/'] = ('text/html', '<a href="/plants">Catalogue</a>')
        self.run_discovery(budget=20, index_only=True)
        self.assertNotIn('https://nursery.test/plants', self.calls)

    def test_utf8_catalogue_names_work_on_windows_system_encodings(self):
        data = {'nurseries': [{'id': 'n1', 'name': 'Rasadnik Čačak – drveće i žbunje',
                              'website': 'https://nursery.test/', 'verificationStatus': 'verified'}]}
        (self.root / 'data/rasadnici.json').write_bytes(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        result = self.run_discovery(budget=20)
        self.assertEqual(result['confirmedPairs'], 1)

    def test_observed_tree_categories_and_english_assortment_are_crawled(self):
        trees = 'https://nursery.test/our-trees/'
        category = trees + 'field-grown/'
        assortment = 'https://nursery.test/en/assortment/'
        self.routes['https://nursery.test/map.xml'] = ('application/xml', self.sitemap([]))
        self.routes['https://nursery.test/'] = ('text/html', '<a href="/our-trees/">Trees</a><a href="/en/assortment/">Assortment</a>')
        self.routes[trees] = ('text/html', '<a href="' + category + '">Field grown</a>')
        self.routes[category] = ('text/html', '<a href="' + self.product + '">Red Dragon</a>')
        self.routes[assortment] = ('text/html', '<h1>Assortment</h1>')
        self.run_discovery(budget=20, index_only=True)
        for page in [trees, category, assortment]:
            self.assertIn(page, self.calls)
        self.assertNotIn(self.product, self.calls)
        saved = json.loads((self.root / STATE_PATH).read_text())['nurseries']['n1']
        self.assertIn(self.product, saved['pages'])


if __name__ == '__main__':
    unittest.main()

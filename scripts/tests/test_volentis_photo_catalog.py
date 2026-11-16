import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_photos import FetchResult, PhotoError
import volentis_photo_catalog as source

PAGE = 'https://portal.volentis.com/en/offers/1?SearchText=Acer'
PHOTO = 'https://cdn.volentis.com/d/observed/acer-palmatum-seiryu.jpg?width=600&height=350'


def card(name="Acer palmatum 'Seiryu'", image=PHOTO, extra_class='', extra=''):
    return ('<figure class="card card-product offer" data-link="/en/offers/details/acer-palmatum-seiryu">'
            '<div class="zoom-image '+extra_class+'" style="background-image:url(\''+image+'\');"></div>'
            '<div class="col h4 title">'+name+'</div>'+extra+'</figure>')


class VolentisTests(unittest.TestCase):
    def test_full_card_identity_and_paired_photo(self):
        rows = source.parse_cards(card(), PAGE, "Acer palmatum ‘Seiryu’")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['imageUrl'], PHOTO)
        self.assertEqual(rows[0]['sourceUrl'], 'https://portal.volentis.com/en/offers/details/acer-palmatum-seiryu')
        self.assertEqual(rows[0]['identityEvidence']['pageUrl'], PAGE)

    def test_does_not_take_adjacent_cultivar_photo(self):
        html = card('Acer palmatum', 'https://cdn.volentis.com/logos/logo.png', 'default')+card()
        self.assertEqual(source.parse_cards(html, PAGE, 'Acer palmatum'), [])
        self.assertEqual(source.parse_cards(card(), PAGE, "Acer palmatum 'Bloodgood'"), [])

    def test_rejects_logo_external_host_and_ambiguous_images(self):
        for image in ('https://cdn.volentis.com/logos/a.png', 'https://evil.example/d/a.jpg',
                      'https://cdn.volentis.com/d/placeholder.jpg', 'http://cdn.volentis.com/d/a.jpg'):
            self.assertEqual(source.parse_cards(card(image=image), PAGE, "Acer palmatum 'Seiryu'"), [])
        extra = '<div class="zoom-image" style="background-image:url(https://cdn.volentis.com/d/other.jpg)"></div>'
        self.assertEqual(source.parse_cards(card(extra=extra), PAGE, "Acer palmatum 'Seiryu'"), [])

    def test_rejects_multiple_titles_and_external_detail(self):
        self.assertEqual(source.parse_cards(card(extra='<div class="title">Acer rubrum</div>'), PAGE,
                                           "Acer palmatum 'Seiryu'"), [])
        html = card().replace('/en/offers/details/acer-palmatum-seiryu', 'https://evil.example/en/offers/details/foo')
        self.assertEqual(source.parse_cards(html, PAGE, "Acer palmatum 'Seiryu'"), [])

    def test_injected_fetch_and_budget(self):
        calls = []
        def fetch(url, **kwargs):
            calls.append((url, kwargs))
            return FetchResult(card().encode(), url, 'text/html')
        plants = [{'plantId': 'a', 'latinName': "Acer palmatum 'Seiryu'"},
                  {'plantId': 'b', 'latinName': "Acer palmatum 'Bloodgood'"}]
        result = source.discover(plants, fetcher=fetch, request_budget=1, workers=1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['candidates'][0]['plantId'], 'a')
        self.assertEqual(result['results'][1]['status'], 'budget_exhausted')
        self.assertEqual(calls[0][1]['hosts'], source.PAGE_HOSTS)

    def test_stops_after_http_block(self):
        calls = []
        def fetch(url, **kwargs):
            calls.append(url)
            raise PhotoError('http_error', 'Source returned HTTP 429.')
        result = source.discover([{'id': str(i), 'latinName': 'Acer palmatum'} for i in range(3)],
                                 fetcher=fetch, workers=1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result['requests'], 1)

    def test_shared_robots_rules_prevent_request(self):
        def fetch(*args, **kwargs):
            self.fail('Disallowed search must not fetch')
        with self.assertRaisesRegex(PhotoError, 'disallowed'):
            source.candidates('Acer palmatum', fetcher=fetch,
                              robots_rules='User-agent: *\nDisallow: /en/offers/')

    def test_matched_name_preserves_requested_format(self):
        rows = source.parse_cards(card('ACER PALMATUM SEIRYU'), PAGE, "Acer palmatum 'Seiryu'")
        self.assertEqual(rows[0]['matchedName'], "Acer palmatum 'Seiryu'")
        self.assertEqual(rows[0]['identityEvidence']['name'], 'ACER PALMATUM SEIRYU')


if __name__ == '__main__':
    unittest.main()

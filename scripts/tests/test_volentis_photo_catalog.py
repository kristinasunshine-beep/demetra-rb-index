import sys
from pathlib import Path
import unittest
from urllib.parse import urlencode

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

    def test_observed_later_page_exact_photo_is_returned(self):
        name="Acer palmatum 'Seiryu'"
        later='https://portal.volentis.com/en/offers/2?'+urlencode({'SearchText':name})
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            body=(card(image='https://cdn.volentis.com/logos/a.png',extra_class='default')+
                  '<a class="page-link" href="'+later+'">2</a>') if len(calls)==1 else card()
            return FetchResult(body.encode(),url,'text/html')
        rows=source.candidates(name,fetcher=fetch)
        self.assertEqual(calls,[source.search_url(name),later])
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['identityEvidence']['pageUrl'],later)

    def test_pagination_rejects_wrong_query_host_path_and_extra_parameters(self):
        name='Acer palmatum'
        bad=['https://evil.example/en/offers/2?SearchText=Acer+palmatum',
             'https://portal.volentis.com/en/offers/2?SearchText=Acer',
             'https://portal.volentis.com/en/offers/2?SearchText=Acer+palmatum&ShapeType=Other',
             'https://portal.volentis.com/en/dashboard?SearchText=Acer+palmatum',
             'https://portal.volentis.com/en/offers/2',
             'http://portal.volentis.com/en/offers/2?SearchText=Acer+palmatum']
        body=''.join('<a class="page-link" href="'+url+'">2</a>' for url in bad)
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            return FetchResult(body.encode(),url,'text/html')
        self.assertEqual(source.candidates(name,fetcher=fetch),[])
        self.assertEqual(len(calls),1)

    def test_later_wrong_cultivar_and_placeholder_stay_rejected(self):
        name="Acer palmatum 'Seiryu'"
        later='https://portal.volentis.com/en/offers/2?'+urlencode({'SearchText':name})
        def fetch(url,**kwargs):
            body=('<a class="page-link" href="'+later+'">2</a>') if '/1?' in url else (
                  card(name="Acer palmatum 'Bloodgood'")+card(image='https://cdn.volentis.com/logos/a.png'))
            return FetchResult(body.encode(),url,'text/html')
        self.assertEqual(source.candidates(name,fetcher=fetch),[])

    def test_page_cap_and_each_observed_page_robots(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            page=int(url.split('/offers/')[1].split('?')[0])
            link='https://portal.volentis.com/en/offers/'+str(page+1)+'?SearchText=Acer+palmatum'
            return FetchResult(('<a class="page-link" href="'+link+'">next</a>').encode(),url,'text/html')
        source.candidates('Acer palmatum',fetcher=fetch)
        self.assertEqual(len(calls),10)
        calls.clear()
        source.candidates('Acer palmatum',fetcher=fetch,robots_rules='User-agent: *\nDisallow: /en/offers/2')
        self.assertEqual(len(calls),1)

    def test_shared_budget_exception_propagates_without_extra_page_requests(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            if len(calls)==2:raise PhotoError('budget_exhausted','Shared budget exhausted')
            return FetchResult(b'<a class="page-link" href="/en/offers/2?SearchText=Acer+palmatum">2</a>',url,'text/html')
        with self.assertRaisesRegex(PhotoError,'budget'):
            source.candidates('Acer palmatum',fetcher=fetch)
        self.assertEqual(len(calls),2)


if __name__ == '__main__':
    unittest.main()

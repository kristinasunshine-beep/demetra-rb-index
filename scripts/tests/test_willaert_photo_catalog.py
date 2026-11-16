import html
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_photos import FetchResult, PhotoError
import willaert_photo_catalog as w

PAGE = w.search_url('Cotoneaster dammeri')
IMAGE = 'https://www.willaert.be/websites/1/uploads/image/PRODUCTIMAGES/CODAMMER.jpg'


def card(name='Cotoneaster dammeri', image=IMAGE):
    return '<div class="item" href="/nl/plant/cotoneaster-dammeri/codammer/"><img src="'+image+'"><div class="naam">'+name+'</div><div class="latijn">Dutch common name</div></div>'


def xml(source):
    return ('<xmlresponse><plants>'+html.escape(source)+'</plants><ammount>1</ammount></xmlresponse>').encode()


class WillaertTests(unittest.TestCase):
    def test_exact_card(self):
        rows=w.parse_cards(xml(card()), PAGE, 'Cotoneaster dammeri')
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['imageUrl'], IMAGE)
        self.assertEqual(rows[0]['matchedName'], 'Cotoneaster dammeri')

    def test_different_cultivar_and_neighbor_do_not_fill_species(self):
        source=card(image='/websites/1/uploads/image/no_photo_available.jpg')+card("Cotoneaster dammeri 'Major'")
        self.assertEqual(w.parse_cards(xml(source),PAGE,'Cotoneaster dammeri'),[])
        self.assertEqual(w.parse_cards(xml(card()),PAGE,"Cotoneaster dammeri 'Major'"),[])

    def test_external_and_placeholder_images_rejected(self):
        for image in ('https://evil.example/websites/1/uploads/image/PRODUCTIMAGES/a.jpg',
                      'https://www.willaert.be/websites/1/uploads/image/no_photo_available.jpg',
                      'https://www.willaert.be/websites/1/uploads/image/PRODUCTIMAGES/no_image.jpg'):
            self.assertEqual(w.parse_cards(xml(card(image=image)),PAGE,'Cotoneaster dammeri'),[])

    def test_xml_entities_rejected(self):
        with self.assertRaisesRegex(PhotoError,'entities'):
            w.parse_cards('<!DOCTYPE x [<!ENTITY a "x">]><xmlresponse/>',PAGE,'Cotoneaster dammeri')

    def test_formatting_retry_is_observed_exact_and_base_fetch_cached(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            if url==w.GUIDE:
                body=b"var availableTags = ['Cotoneaster  dammeri', 'Cotoneaster dammeri Major'];"
            elif 'Cotoneaster++dammeri' in url:
                body=xml(card())
            else:body=xml('')
            return FetchResult(body,url,'text/xml')
        self.assertEqual(len(w.candidates('Cotoneaster dammeri',fetcher=fetch)),1)
        w.candidates('Cotoneaster dammeri',fetcher=fetch)
        self.assertEqual(calls.count(w.GUIDE),1)
        self.assertFalse(any('Major' in url for url in calls))

    def test_no_fuzzy_autocomplete_or_login(self):
        calls=[]
        def fetch(url,**kwargs):
            calls.append(url)
            return FetchResult(xml(''),url,'text/xml')
        rows=w.candidates("Acer palmatum 'Seiryu'",fetcher=fetch,
                          autocomplete_names=["Acer palmatum 'Seryu'",'Acer palmatum'])
        self.assertEqual(rows,[])
        self.assertEqual(len(calls),1)

    def test_robots_prevents_fetch(self):
        def fetch(*args,**kwargs):self.fail('disallowed request')
        with self.assertRaisesRegex(PhotoError,'disallowed'):
            w.candidates('Acer palmatum',fetcher=fetch,robots_rules='User-agent: *\nDisallow: /nl/plantengids')

    def test_literal_apostrophe_read_without_execution(self):
        parsed=w.parse_autocomplete("var availableTags = ['Ajuga reptans \\'Catlin\\'s Giant\\'', 'Other'];")
        self.assertEqual(parsed[0],"Ajuga reptans 'Catlin's Giant'")


if __name__=='__main__':unittest.main()

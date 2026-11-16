"""Dynamic nursery integration: source priority, bounds and mutation safety."""
import copy
import html
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parallel_photo_coverage as pipeline
from update_photos import FetchResult, PhotoError

NAME = "Acer palmatum 'Seiryu'"
PLANT = {'id': 'a', 'latinName': NAME, 'commonName': 'Protected name', 'description': 'Protected text'}
POLICIES = {
    'willaert': {'pageHosts': ['www.willaert.be'], 'imageHosts': ['www.willaert.be']},
    'volentis': {'pageHosts': ['portal.volentis.com'], 'imageHosts': ['cdn.volentis.com'],
                 'imagePathPrefixes': {'cdn.volentis.com': ['/d/']}}
}


def picture(size=(300,220)):
    stream = BytesIO()
    # Nonuniform pixels avoid testing only a trivial placeholder-like bitmap.
    image = Image.new('RGB', size, (60, 120, 40))
    for x in range(size[0]):
        image.putpixel((x, x % size[1]), (x % 255, 180, 90))
    image.save(stream, format='PNG')
    return stream.getvalue()


def search_xml(name=NAME,second=False):
    card = '<div class="item" href="/nl/plant/acer-palmatum-seiryu/acseiryu/"><div class="naam">'+name+'</div><img src="/websites/1/uploads/image/PRODUCTIMAGES/SEIRYU.jpg"></div>'
    if second:
        card += card.replace('acseiryu/','acseiryu2/').replace('SEIRYU.jpg','SECOND.jpg')
    return ('<xmlresponse><plants>'+html.escape(card)+'</plants></xmlresponse>').encode()


class DynamicIntegrationTests(unittest.TestCase):
    def test_own_pages_and_dynamic_before_any_other_nursery(self):
        generic = [dict(nurseryId='willaert', tier=0, pageUrl='own-offer'),
                   dict(nurseryId='willaert', tier=0, pageUrl='own-index'),
                   dict(nurseryId='volentis', tier=1, pageUrl='other-index')]
        offers = [{'plantId':'a','nurseryId':'willaert'}]
        plan = pipeline.lookup_plan(PLANT, offers, generic, POLICIES, [NAME])
        self.assertEqual([r['pageUrl'] for r in plan[:2]], ['own-offer', 'own-index'])
        self.assertEqual([r['nurseryId'] for r in plan], ['willaert','willaert','willaert','volentis','volentis'])
        self.assertEqual([r['tier'] for r in plan], [0,0,0,1,1])

    def test_excluded_nursery_or_unconfigured_host_is_not_queried(self):
        policies = {'volentis': {'pageHosts':['www.volentis.com'], 'imageHosts':['www.volentis.com']}}
        self.assertEqual(pipeline.lookup_plan(PLANT, [], [], policies, [NAME]), [])
        self.assertEqual(pipeline.lookup_plan(PLANT, [], [], {}, [NAME]), [])

    def test_alias_requires_evidence_and_not_search_alias(self):
        plant = {**PLANT, 'searchAliases': ['Acer palmatum'], 'synonyms': ['Acer palmatum']}
        config = {'exactNameAliases': {'a': [{'name':'Acer palmatum'},
                   {'name':"Acer palmatum 'Seiryu'",'evidenceUrls':['https://nursery.example/proof']}]}}
        self.assertEqual(pipeline.lookup_names(plant, config), [NAME])

    def test_robots_404_checked_once_and_protected_host_fails_closed(self):
        calls = []
        def fetch(url, **kwargs):
            calls.append(url)
            if url.endswith('/robots.txt'):
                raise PhotoError('http_error','Source returned HTTP 404.')
            return FetchResult(search_xml(),url,'text/xml')
        session = pipeline.ParallelSession(10,10,fetch)
        manager = pipeline.DynamicCatalogues(session,POLICIES,{})
        item = {'nurseryId':'willaert','name':NAME,'tier':0}
        self.assertEqual(manager.find(PLANT,item)[0]['provider'],'supplying_nursery')
        manager.find(PLANT,item)
        self.assertEqual(sum(u.endswith('/robots.txt') for u in calls),1)
        for code in (403,429):
            blocked_calls=[]
            def blocked(url,**kwargs):
                blocked_calls.append(url)
                raise PhotoError('http_error','Source returned HTTP '+str(code)+'.')
            blocked_manager=pipeline.DynamicCatalogues(pipeline.ParallelSession(10,10,blocked),POLICIES,{})
            for _ in range(2):
                with self.assertRaises(PhotoError):blocked_manager.find(PLANT,item)
            self.assertEqual(len(blocked_calls),1)
            self.assertTrue(blocked_calls[0].endswith('/robots.txt'))

    def test_known_partial_index_robots_disallow_without_fetch(self):
        def fetch(*args,**kwargs):self.fail('robots disallowed request')
        manager=pipeline.DynamicCatalogues(pipeline.ParallelSession(10,10,fetch),POLICIES,
            {'nurseries':{'willaert':{'robots':{'www.willaert.be':['User-agent: *','Disallow: /nl/plantengids']}}}})
        with self.assertRaisesRegex(PhotoError,'disallowed'):
            manager.find(PLANT,{'nurseryId':'willaert','name':NAME,'tier':0})

    def test_manager_revalidates_wrong_cultivar_and_external_image(self):
        raw={'nurseryId':'willaert','matchedName':NAME,
             'sourceUrl':'https://www.willaert.be/nl/plant/seiryu/id/',
             'imageUrl':'https://www.willaert.be/websites/1/uploads/image/PRODUCTIMAGES/a.jpg',
             'identityEvidence':{'name':"Acer palmatum 'Bloodgood'"}}
        fake=SimpleNamespace(PAGE_HOSTS={'www.willaert.be'},IMAGE_HOSTS={'www.willaert.be'},
                            search_url=lambda name:'https://www.willaert.be/nl/plantengids',
                            candidates=lambda *args,**kwargs:[copy.deepcopy(raw)])
        manager=pipeline.DynamicCatalogues(pipeline.ParallelSession(0,10),POLICIES,
                    {'nurseries':{'willaert':{'robots':{'www.willaert.be':[]}}}},providers={'willaert':fake})
        item={'nurseryId':'willaert','name':NAME,'tier':0}
        with self.assertRaises(PhotoError) as caught:manager.find(PLANT,item)
        self.assertEqual(caught.exception.code,'identity_missing')
        raw['identityEvidence']['name']=NAME
        raw['imageUrl']='https://unapproved.example/seiryu.jpg'
        with self.assertRaises(PhotoError) as caught:manager.find(PLANT,item)
        self.assertEqual(caught.exception.code,'outside_offer_nurseries')


class DynamicRunTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.write('data/biljke.json',{'schemaVersion':1,'plants':[PLANT]})
        self.write('data/kataloske-stavke.json',{'offers':[{'id':'offer','plantId':'a','nurseryId':'willaert','purchasePrice':12.5}]})
        self.write('data/rasadnici.json',{'nurseries':[{'id':'willaert','website':'https://www.willaert.be/','verificationStatus':'verified'}]})
        self.write('scripts/photo-sources.json',{'sources':[]})
        self.write('scripts/photo-discovery.json',{'sources':[]})
        self.write('scripts/full-photo-policy.json',{'scope':'all_catalog_plants','allowSpeciesFallback':False,'refreshDays':0,'refreshPerRun':1})
        self.calls=[]

    def write(self,name,value):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(pipeline.core.encoded(value))

    def read(self,name):return json.loads((self.root/name).read_text(encoding='utf8'))

    def fetch(self,url,**kwargs):
        self.calls.append(url)
        if url.endswith('/robots.txt'):return FetchResult(b'User-agent: *\nDisallow: /resendorders',url,'text/plain')
        if 'PRODUCTIMAGES' in url:return FetchResult(picture(),url,'image/png')
        if '?ajax=' in url:return FetchResult(search_xml(),url,'text/xml')
        return FetchResult(b'<h1>Other cultivar</h1>',url,'text/html')

    def run_job(self,**kwargs):
        return pipeline.run(self.root,workers=1,max_seconds=20,cache_dir=self.root/'private-cache',fetcher=self.fetch,**kwargs)

    def test_end_to_end_protects_prices_names_and_public_panel_fields(self):
        before=self.read('data/biljke.json')
        offers=(self.root/'data/kataloske-stavke.json').read_bytes()
        report=self.run_job(request_budget=8)
        after=self.read('data/biljke.json')
        self.assertEqual(report['newlyVerified'],1)
        pipeline.core.protect(before,after)
        self.assertEqual(offers,(self.root/'data/kataloske-stavke.json').read_bytes())
        self.assertEqual(set(after['plants'][0]['photo']),{'image','sourceUrl'})
        record=self.read(pipeline.core.MANIFEST)['plants']['a']
        self.assertEqual(record['license'],'existing_catalogue_source_policy')
        self.assertEqual(record['identityEvidence']['canonicalName'],NAME)

    def test_budget_exhaustion_preserves_current_dynamic_cursor_then_resumes(self):
        first=self.run_job(request_budget=1)
        self.assertEqual(first['newlyVerified'],0)
        entry=self.read(pipeline.core.STATE)['plants']['a']
        self.assertEqual(entry['nextCandidate'],0)
        self.assertIn({'reason':'budget_exhausted'},entry['failures'])
        second=self.run_job(request_budget=8)
        self.assertEqual(second['newlyVerified'],1)

    def test_reviewed_image_url_exclusion_does_not_create_photo(self):
        config=self.read('scripts/full-photo-policy.json')
        config['excludedImageUrls']=['https://www.willaert.be/websites/1/uploads/image/PRODUCTIMAGES/SEIRYU.jpg']
        self.write('scripts/full-photo-policy.json',config)
        report=self.run_job(request_budget=8)
        self.assertEqual(report['newlyVerified'],0)
        self.assertFalse(any('PRODUCTIMAGES' in url for url in self.calls))
        self.assertNotIn('photo',self.read('data/biljke.json')['plants'][0])

    def test_small_first_photo_continues_to_full_size_alternative(self):
        original=self.fetch
        def fetch(url,**kwargs):
            if '?ajax=' in url:return FetchResult(search_xml(second=True),url,'text/xml')
            if url.endswith('SEIRYU.jpg'):return FetchResult(picture((100,100)),url,'image/png')
            return original(url,**kwargs)
        self.fetch=fetch
        report=self.run_job(request_budget=8)
        self.assertEqual(report['newlyVerified'],1)
        record=self.read(pipeline.core.MANIFEST)['plants']['a']
        self.assertTrue(record['imageUrl'].endswith('SECOND.jpg'))
        self.assertTrue(self.read('private-cache/a.json')['candidate']['imageUrl'].endswith('SECOND.jpg'))

    def test_small_cached_photo_cannot_block_future_lookup(self):
        self.run_job(request_budget=8)
        data=self.read('data/biljke.json');data['plants'][0].pop('photo');self.write('data/biljke.json',data)
        body=pipeline.to_jpeg(picture((100,100)),pipeline.DEFAULT_LIMITS)
        metadata=self.read('private-cache/a.json');metadata['sha256']=pipeline.core.digest(body)
        self.write('private-cache/a.json',metadata);(self.root/'private-cache/a.jpg').write_bytes(body)
        self.calls.clear()
        report=self.run_job(request_budget=8)
        self.assertEqual(report['newlyVerified'],1)
        self.assertTrue(any('?ajax=' in url for url in self.calls))
        with Image.open(self.root/self.read('data/biljke.json')['plants'][0]['photo']['image']) as image:
            self.assertGreaterEqual(min(image.size),128)

    def test_known_cross_taxon_hash_and_cache_try_another_photo(self):
        self.run_job(request_budget=8)
        data=self.read('data/biljke.json');data['plants'][0].pop('photo');self.write('data/biljke.json',data)
        manifest=self.read(pipeline.core.MANIFEST)
        record=manifest['plants'].pop('a')
        record.update(latinName="Acer palmatum 'Bloodgood'",taxonKey="Acer palmatum 'Bloodgood'")
        manifest['plants']['other']=record;self.write(pipeline.core.MANIFEST,manifest)
        original=self.fetch
        def fetch(url,**kwargs):
            if '?ajax=' in url:return FetchResult(search_xml(second=True),url,'text/xml')
            if url.endswith('SECOND.jpg'):return FetchResult(picture((300,230)),url,'image/png')
            return original(url,**kwargs)
        self.fetch=fetch
        report=self.run_job(request_budget=8)
        self.assertEqual(report['newlyVerified'],1)
        self.assertTrue(self.read(pipeline.core.MANIFEST)['plants']['a']['imageUrl'].endswith('SECOND.jpg'))

    def test_serialized_collision_discards_cache_and_preserves_cursor(self):
        original=pipeline.core.store_jpeg
        def conflict(*args,**kwargs):
            raise PhotoError('image_identity_conflict','A concurrent plant used this photograph.')
        with patch.object(pipeline.core,'store_jpeg',side_effect=conflict):
            report=self.run_job(request_budget=8)
        self.assertEqual(report['newlyVerified'],0)
        self.assertFalse((self.root/'private-cache/a.json').exists())
        self.assertFalse((self.root/'private-cache/a.jpg').exists())
        self.assertEqual(self.read(pipeline.core.STATE)['plants']['a']['nextCandidate'],0)
        self.assertTrue(any(e['reason']=='image_identity_conflict' for e in report['events']))
        self.assertEqual(self.run_job(request_budget=8)['newlyVerified'],1)


if __name__=='__main__':unittest.main()

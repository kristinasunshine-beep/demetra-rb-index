import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unittest
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from parallel_photo_coverage import ParallelSession
from full_photo_coverage import taxonomy_keys, Exhausted
from update_photos import FetchResult, PhotoError, resolve_product_image, identity_matches

class ParallelPhotoTests(unittest.TestCase):
    def test_named_product_image_without_structured_metadata(self):
        policy={'nurseryId':'test','resolver':'product','pageHosts':['example.com'],'imageHosts':['example.com'],'pagePathPattern':r'/.*'}
        page='<h1>Acer campestre Elsrijk</h1><main><img alt="Acer campestre Elsrijk" src="/elsrijk.jpg"></main>'
        image,method=resolve_product_image(page,'https://example.com/elsrijk',"Acer campestre 'Elsrijk'",policy)
        self.assertEqual(image,'https://example.com/elsrijk.jpg')
        self.assertEqual(method,'exact_product_image_alt')

    def test_related_product_image_is_not_primary(self):
        policy={'nurseryId':'test','resolver':'product','pageHosts':['example.com'],'imageHosts':['example.com'],'pagePathPattern':r'/.*'}
        page='<h1>Acer campestre Elsrijk</h1><aside><img alt="Acer campestre Elsrijk" src="/elsrijk.jpg"></aside>'
        with self.assertRaises(PhotoError):resolve_product_image(page,'https://example.com/elsrijk',"Acer campestre 'Elsrijk'",policy)

    def test_repeated_name_must_repeat_the_whole_cultivar(self):
        self.assertTrue(identity_matches('Acer campestre Elsrijk Acer campestre Elsrijk',"Acer campestre 'Elsrijk'"))
        self.assertFalse(identity_matches('Acer campestre Elsrijk Acer campestre Green Column',"Acer campestre 'Elsrijk'"))

    def test_host_concurrency_is_bounded(self):
        lock=threading.Lock(); active=0; peak=0
        def fetch(url,**kwargs):
            nonlocal active,peak
            with lock:active+=1; peak=max(peak,active)
            time.sleep(.01)
            with lock:active-=1
            return FetchResult(b'{}',url,'application/json')
        session=ParallelSession(20,10,fetch)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i:session.get('https://example.com/'+str(i),hosts=['example.com'],max_bytes=10,timeout=1,kind='api'),range(12)))
        self.assertEqual(session.requests,12)
        self.assertLessEqual(peak,2)

    def test_global_budget_is_atomic(self):
        session=ParallelSession(3,10,lambda url,**kw:FetchResult(b'{}',url,'application/json'))
        def request(i):
            try:session.get('https://example.com/'+str(i),hosts=['example.com'],max_bytes=10,timeout=1,kind='api'); return True
            except Exhausted:return False
        with ThreadPoolExecutor(max_workers=8) as pool:success=list(pool.map(request,range(20)))
        self.assertEqual(sum(success),3)
        self.assertEqual(session.requests,3)

    def test_retry_after_failure_stops_host_for_run(self):
        def fetch(url,**kw):raise PhotoError('http_error','Source returned HTTP 429.')
        session=ParallelSession(10,10,fetch)
        for i in range(2):
            with self.assertRaises(PhotoError):session.get('https://example.com/'+str(i),hosts=['example.com'],max_bytes=10,timeout=1,kind='api')
        self.assertEqual(session.requests,1)

    def test_only_documented_full_synonym_shares_taxon(self):
        plants=[{'id':'a','latinName':"Acer freemanii 'Jeffersred'"},
                {'id':'b','latinName':"Acer x freemanii 'Autumn Blaze'"},
                {'id':'c','latinName':'Acer x freemanii','searchAliases':["Acer x freemanii 'Autumn Blaze'"]}]
        plain=taxonomy_keys(plants,{})
        self.assertNotEqual(plain['a'],plain['b'])
        config={'exactNameAliases':{'a':[{'name':plants[1]['latinName'],'evidenceUrls':['https://example.com/breeder']} ]}}
        reviewed=taxonomy_keys(plants,config)
        self.assertEqual(reviewed['a'],reviewed['b'])
        self.assertNotEqual(reviewed['a'],reviewed['c'])

    def test_alias_without_evidence_is_not_used(self):
        plants=[{'id':'a','latinName':"Acer campestre 'Elsrijk'"},{'id':'b','latinName':'Acer campestre'}]
        keys=taxonomy_keys(plants,{'exactNameAliases':{'a':[{'name':'Acer campestre'}]}})
        self.assertNotEqual(keys['a'],keys['b'])

if __name__=='__main__':unittest.main()

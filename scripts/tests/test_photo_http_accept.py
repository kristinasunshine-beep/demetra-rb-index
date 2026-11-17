"""Strict content negotiation used by Willaert's public robots/sitemaps."""
from email.message import Message
from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import update_photos as photos


class PhotoHttpAcceptTests(unittest.TestCase):
    def request(self,url,kind):
        return photos.fetch_resource(url,hosts={'www.willaert.be'},max_bytes=1024,timeout=5,kind=kind)

    def test_text_robots_xml_sitemap_and_ajax_pass_strict_mime_negotiation(self):
        cases=[('/robots.txt','text/plain',b'User-agent: *\nDisallow: /private'),
               ('/websites/1/sitemap.xml','application/xml',b'<urlset/>'),
               ('/nl/plantengids?ajax=1','text/xml',b'<xmlresponse/>'),
               ('/nl/plantengids','text/html',b'<html/>')]
        for path,mime,body in cases:
            with self.subTest(mime=mime):
                def open_request(request,timeout):
                    accepted={x.strip().split(';')[0] for x in request.get_header('Accept').split(',')}
                    if mime not in accepted:
                        raise HTTPError(request.full_url,406,'MIME type not acceptable',{},None)
                    self.assertIn('DemetraPhotoBot',request.get_header('User-agent'))
                    response=BytesIO(body);response.url=request.full_url
                    response.headers=Message();response.headers['Content-Type']=mime
                    return response
                with patch.object(photos,'build_opener',return_value=SimpleNamespace(open=open_request)):
                    result=self.request('https://www.willaert.be'+path,'page')
                self.assertEqual(result.body,body)
                self.assertEqual(result.content_type,mime)

    def test_images_and_apis_keep_their_separate_accept_types(self):
        for kind,required,excluded in [('image','image/jpeg','text/html'),('api','application/json','text/html')]:
            def open_request(request,timeout):
                accept=request.get_header('Accept')
                self.assertIn(required,accept);self.assertNotIn(excluded,accept)
                response=BytesIO(b'x');response.url=request.full_url
                response.headers=Message();response.headers['Content-Type']=required
                return response
            with patch.object(photos,'build_opener',return_value=SimpleNamespace(open=open_request)):
                self.request('https://www.willaert.be/resource',kind)

    def test_true_access_denial_is_preserved(self):
        def denied(request,timeout):
            raise HTTPError(request.full_url,403,'Forbidden',{},None)
        with patch.object(photos,'build_opener',return_value=SimpleNamespace(open=denied)):
            with self.assertRaises(photos.PhotoError) as caught:
                self.request('https://www.willaert.be/robots.txt','page')
        self.assertEqual(caught.exception.code,'http_error')
        self.assertIn('HTTP 403',str(caught.exception))


if __name__=='__main__':unittest.main()

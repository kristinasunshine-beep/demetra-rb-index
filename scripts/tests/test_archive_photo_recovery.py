"""Offline archive recovery must not turn aliases or shared images into proof."""
from __future__ import annotations

import copy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image, PngImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive_photo_recovery import recover_candidates, rejected_jpeg_hashes, rejected_source_urls
from update_photos import DEFAULT_LIMITS, to_jpeg


def bitmap(color=(40, 90, 20), comment=None):
    output = BytesIO()
    metadata = PngImagePlugin.PngInfo()
    if comment:
        metadata.add_text('Comment', comment)
    Image.new('RGB', (240, 180), color).save(output, format='PNG', pnginfo=metadata)
    return output.getvalue()


class ArchivePhotoRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plants = [{'id': 'elsrijk', 'latinName': "Acer campestre 'Elsrijk'", 'searchAliases': ['Acer campestre']},
                       {'id': 'red-shine', 'latinName': "Acer campestre 'Red Shine'"}]
        self.write('data/biljke.json', {'plants': self.plants})
        self.write('data/kataloske-stavke.json', {'offers': []})
        self.write('data/rasadnici.json', {'nurseries': [
            {'id': nid, 'website': 'https://'+nid+'.example.org', 'verificationStatus': 'verified'}
            for nid in ('a-other', 'z-supplier')]})
        self.write('scripts/photo-sources.json', {'sources': []})
        self.write('scripts/photo-discovery.json', {'sources': []})

    def write(self, relative, value):
        path = self.root/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def reference(self, plant='elsrijk', nursery='a-other', tail=None, image='one', body=None):
        tail = tail or ('acer-campestre-elsrijk' if plant == 'elsrijk' else 'acer-campestre-red-shine')
        page = 'https://'+nursery+'.example.org/en/'+tail+'/'
        relative = 'assets/biljke/'+image+'.jpg'
        path = self.root/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body or bitmap())
        return {'id': 'ref-'+image, 'plantId': plant, 'nurseryId': nursery,
                'image': relative, 'photoSourcePage': page,
                'manifest': {'plantId': plant, 'nurseryId': nursery, 'status': 'saved',
                             'localPath': relative, 'sourcePage': page,
                             'sourceUrl': 'https://'+nursery+'.example.org/photos/'+image+'.jpg'}}

    def recover(self, refs):
        self.write('docs/photo-reference-catalog.json', {'references': refs})
        return recover_candidates(self.root)

    def test_missing_archive_returns_empty(self):
        self.assertEqual(recover_candidates(self.root), {})
        self.assertEqual(rejected_jpeg_hashes(self.root), set())
        self.assertEqual(rejected_source_urls(self.root), set())

    def test_rejected_original_image_url_blocks_a_different_encoded_download(self):
        ref = self.reference(image='cec7c1beedcd4a94db1e')
        another = self.reference(image='another-encoding', body=bitmap((60, 70, 80)))
        another['manifest']['sourceUrl'] = ref['manifest']['sourceUrl']
        self.assertEqual(self.recover([ref, another]), {})
        self.assertEqual(rejected_source_urls(self.root), {ref['manifest']['sourceUrl']})
        self.assertNotIn(ref['photoSourcePage'], rejected_source_urls(self.root))

    def test_visually_uncertain_archive_image_and_same_bytes_are_excluded(self):
        ref = self.reference(image='cec7c1beedcd4a94db1e')
        expected = hashlib.sha256(to_jpeg((self.root/ref['image']).read_bytes(), DEFAULT_LIMITS)).hexdigest()
        self.assertIn(expected, rejected_jpeg_hashes(self.root))
        self.assertEqual(self.recover([ref]), {})
        duplicate = self.reference(image='same-photo-under-another-path')
        self.assertEqual(self.recover([duplicate]), {})

    def test_known_cross_cultivar_duplicate_hashes_are_exposed(self):
        ref = self.reference(image='3ede436075be52311ac4')
        expected = hashlib.sha256(to_jpeg((self.root/ref['image']).read_bytes(), DEFAULT_LIMITS)).hexdigest()
        self.assertIn(expected, rejected_jpeg_hashes(self.root))
        self.assertEqual(self.recover([ref]), {})

    def test_exact_saved_association_becomes_offline_candidate_without_mutation(self):
        ref = self.reference()
        self.write('docs/photo-reference-catalog.json', {'references': [ref]})
        before = {p.relative_to(self.root): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.root.rglob('*') if p.is_file()}
        result = recover_candidates(self.root)
        after = {p.relative_to(self.root): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(set(result), {'elsrijk'})
        photo = result['elsrijk']
        self.assertEqual(photo['provider'], 'archived_nursery')
        self.assertEqual(photo['matchedName'], self.plants[0]['latinName'])
        self.assertFalse(photo['identityEvidence']['freshRemotePageValidation'])
        self.assertEqual(photo['sourceUrl'], ref['photoSourcePage'])
        with Image.open(BytesIO(photo['jpeg'])) as image:
            self.assertEqual(image.format, 'JPEG')

    def test_supplier_prioritized_over_other_nursery(self):
        refs = [self.reference(image='other', body=bitmap((10, 20, 30))),
                self.reference(nursery='z-supplier', image='supplier', body=bitmap((30, 40, 50)))]
        self.write('data/kataloske-stavke.json', {'offers': [
            {'id': 'offer', 'plantId': 'elsrijk', 'nurseryId': 'z-supplier'}]})
        self.assertEqual(self.recover(refs)['elsrijk']['nurseryId'], 'z-supplier')

    def test_species_alias_and_substring_url_are_not_exact_cultivar_proof(self):
        for tail in ('acer-campestre', 'acer-campestre-elsrijk-buy', 'acer-campestre-red-shine'):
            with self.subTest(tail=tail):
                self.assertEqual(self.recover([self.reference(tail=tail)]), {})

    def test_all_manifest_links_must_match_the_archived_association(self):
        for key, value in [('plantId', 'red-shine'), ('nurseryId', 'z-supplier'),
                           ('localPath', 'assets/biljke/different.jpg'),
                           ('sourcePage', 'https://a-other.example.org/en/acer-campestre/'),
                           ('status', 'pending')]:
            with self.subTest(key=key):
                ref = self.reference()
                ref['manifest'][key] = value
                self.assertEqual(self.recover([ref]), {})

    def test_page_and_original_image_hosts_must_be_approved(self):
        ref = self.reference()
        ref['manifest']['sourceUrl'] = 'https://unapproved.example.org/photo.jpg'
        self.assertEqual(self.recover([ref]), {})
        ref = self.reference()
        ref['photoSourcePage'] = ref['manifest']['sourcePage'] = 'https://unapproved.example.org/acer-campestre-elsrijk/'
        self.assertEqual(self.recover([ref]), {})

    def test_different_taxa_with_identical_bytes_are_rejected_on_both_sides(self):
        refs = [self.reference(image='first'), self.reference(plant='red-shine', image='second')]
        self.assertEqual(self.recover(refs), {})
        # An invalid URL on one side must not let its equally ambiguous peer in.
        refs[1]['photoSourcePage'] = 'https://a-other.example.org/generic'
        self.assertEqual(self.recover(refs), {})

    def test_identical_pixels_with_different_metadata_are_rejected_on_both_sides(self):
        first, second = bitmap(comment='one'), bitmap(comment='two')
        self.assertNotEqual(first, second)
        refs = [self.reference(image='first', body=first),
                self.reference(plant='red-shine', image='second', body=second)]
        self.assertEqual(self.recover(refs), {})

    def test_same_taxon_can_have_duplicate_images(self):
        refs = [self.reference(image='first'), self.reference(nursery='z-supplier', image='second')]
        self.assertEqual(set(self.recover(refs)), {'elsrijk'})

    def test_images_that_collide_only_after_resize_are_both_rejected(self):
        sources = []
        for size in [(2400, 1800), (1200, 900)]:
            stream = BytesIO()
            Image.new('RGB', size, (40, 90, 20)).save(stream, format='PNG')
            sources.append(stream.getvalue())
        self.assertNotEqual(sources[0], sources[1])
        self.assertEqual(to_jpeg(sources[0], DEFAULT_LIMITS), to_jpeg(sources[1], DEFAULT_LIMITS))
        refs = [self.reference(image='large', body=sources[0]),
                self.reference(plant='red-shine', image='smaller', body=sources[1])]
        self.assertEqual(self.recover(refs), {})

    def test_missing_corrupt_and_unsafe_local_images_are_rejected(self):
        ref = self.reference()
        (self.root/ref['image']).unlink()
        self.assertEqual(self.recover([ref]), {})
        ref = self.reference(body=b'not a picture')
        self.assertEqual(self.recover([ref]), {})
        ref['image'] = ref['manifest']['localPath'] = 'assets/biljke/../../data/biljke.json'
        self.assertEqual(self.recover([ref]), {})


if __name__ == '__main__':
    unittest.main()

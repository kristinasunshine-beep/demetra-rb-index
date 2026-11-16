import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import apply_reviewed_offer_photos as reviewed
from update_photos import PhotoError


class ReviewedOfferPhotoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for folder in ['data', 'docs', 'assets/biljke']:
            (self.root / folder).mkdir(parents=True)
        self.photo = 'assets/biljke/offer-reviewed-fixture.jpg'
        self.body = self.bitmap()
        (self.root / self.photo).write_bytes(self.body)
        self.plants = [{'id': 'p1', 'latinName': "Acer campestre 'Elsrijk'"},
                       {'id': 'p2', 'latinName': "Acer campestre 'Elegant'"}]
        self.offer = {'id': 'o1', 'plantId': 'p1', 'nurseryId': 'n1', 'image': '', 'imageSourceUrl': '',
                      'dataOrigin': 'rasadnici-ponude-zip', 'recordStatus': 'active',
                      'price': 92.5, 'currency': 'EUR', 'height': '200–250', 'circumference': '18–20',
                      'sourceEvidence': {'archiveVerified': True, 'sourceFile': 'ponuda-Čačak.pdf',
                                         'sourceSha256': 'a' * 64, 'page': 2, 'row': '8'}}
        self.document = {'schemaVersion': 1, 'updatedAt': '2026-11-16T08:46:39Z',
                         'sourcePolicy': {'nonPhoto': 'rasadnici-ponude-zip'}, 'offers': [self.offer]}
        self.entry = {'plantId': 'p1', 'latinName': self.plants[0]['latinName'], 'nurseryId': 'n1',
                      'offerIds': ['o1'], 'sourceSha256': 'a' * 64, 'image': self.photo,
                      'imageSha256': hashlib.sha256(self.body).hexdigest(),
                      'provenance': {'sourceFile': 'ponuda-Čačak.pdf', 'page': 2, 'sourceRow': '8',
                                     'pdfImageIndexZeroBased': 3, 'reviewedAt': '2026-11-16T10:00:00Z',
                                     'identityEvidence': 'Image appears inside the exact named original offer row.'}}
        self.registry = {'schemaVersion': 1, 'sourcePolicy': 'original_supplied_offer', 'entries': [self.entry]}
        self.write('data/biljke.json', {'plants': self.plants})
        self.write('data/rasadnici.json', {'nurseries': [{'id': 'n1', 'name': 'Čačak'}]})
        self.write('data/kataloske-stavke.json', self.document)
        self.write(reviewed.REGISTRY, self.registry)

    def bitmap(self, size=(160, 180), color=(14, 102, 31), format='JPEG'):
        output = io.BytesIO()
        Image.new('RGB', size, color).save(output, format=format)
        return output.getvalue()

    def write(self, relative, value):
        (self.root / relative).write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))

    def read(self, relative):
        return json.loads((self.root / relative).read_text(encoding='utf-8'))

    def catalogue_bytes(self):
        return (self.root / 'data/kataloske-stavke.json').read_bytes()

    def assert_rejected_without_write(self):
        before = self.catalogue_bytes()
        with self.assertRaises((PhotoError, OSError, ValueError)):
            reviewed.run(self.root, apply=True)
        self.assertEqual(self.catalogue_bytes(), before)

    def test_exact_original_offer_only_changes_three_photo_fields_and_is_idempotent(self):
        report = reviewed.run(self.root, apply=True)
        self.assertEqual(report['changedOffers'], 1)
        after = self.read('data/kataloske-stavke.json')
        reviewed.protect(self.document, after)
        self.assertEqual(after['updatedAt'], self.document['updatedAt'])
        self.assertEqual(after['offers'][0]['image'], self.photo)
        self.assertEqual(after['offers'][0]['imageEvidence']['sourceSha256'], 'a' * 64)
        self.assertNotIn('imageSourceUrl', after['offers'][0]['imageEvidence'])
        self.assertEqual(after['offers'][0]['imageSourceUrl'], '')
        saved = self.catalogue_bytes()
        second = reviewed.run(self.root, apply=True)
        self.assertEqual(second['changedOffers'], 0)
        self.assertEqual(second['alreadyApplied'], 1)
        self.assertEqual(self.catalogue_bytes(), saved)

    def test_validate_only_does_not_write_any_catalogue_bytes(self):
        before = self.catalogue_bytes()
        report = reviewed.run(self.root)
        self.assertEqual(report['changedOffers'], 1)
        self.assertFalse(report['applied'])
        self.assertEqual(self.catalogue_bytes(), before)

    def test_wrong_identity_nursery_hash_archive_status_and_original_row_fail_closed(self):
        for field, value in [('plantId', 'p2'), ('latinName', self.plants[1]['latinName']),
                             ('nurseryId', 'n2'), ('sourceSha256', 'b' * 64), ('offerIds', ['absent'])]:
            with self.subTest(field=field):
                entry = {**self.entry, field: value}
                self.write(reviewed.REGISTRY, {**self.registry, 'entries': [entry]})
                self.assert_rejected_without_write()
        self.write(reviewed.REGISTRY, self.registry)
        for field, value in [('archiveVerified', False), ('sourceSha256', 'b' * 64), ('page', 3), ('row', '9')]:
            with self.subTest(evidence=field):
                changed = copy.deepcopy(self.document)
                changed['offers'][0]['sourceEvidence'][field] = value
                self.write('data/kataloske-stavke.json', changed)
                self.assert_rejected_without_write()

    def test_invalid_second_entry_cannot_partially_apply_first_entry(self):
        bad = {**self.entry, 'offerIds': ['unknown-offer']}
        self.write(reviewed.REGISTRY, {**self.registry, 'entries': [self.entry, bad]})
        self.assert_rejected_without_write()

    def test_existing_image_or_online_source_is_preserved(self):
        for changes, counter in [({'image': self.photo}, 'skippedExistingImage'),
                                 ({'imageSourceUrl': 'https://nursery.test/existing.jpg'}, 'skippedOnlineSource'),
                                 ({'photoSourcePage': 'https://nursery.test/existing'}, 'skippedOnlineSource')]:
            with self.subTest(changes=changes):
                changed = copy.deepcopy(self.document)
                changed['offers'][0].update(changes)
                self.write('data/kataloske-stavke.json', changed)
                before = self.catalogue_bytes()
                result = reviewed.run(self.root, apply=True)
                self.assertEqual(result[counter], 1)
                self.assertEqual(result['changedOffers'], 0)
                self.assertEqual(self.catalogue_bytes(), before)

    def test_hidden_offer_is_never_restored(self):
        for status in ['superseded', 'needs_review']:
            changed = copy.deepcopy(self.document)
            changed['offers'][0]['recordStatus'] = status
            self.write('data/kataloske-stavke.json', changed)
            self.assert_rejected_without_write()

    def test_asset_hash_size_format_and_traversal_are_checked(self):
        for body in [self.bitmap(size=(127, 180)), self.bitmap(format='PNG')]:
            (self.root / self.photo).write_bytes(body)
            entry = {**self.entry, 'imageSha256': hashlib.sha256(body).hexdigest()}
            self.write(reviewed.REGISTRY, {**self.registry, 'entries': [entry]})
            self.assert_rejected_without_write()
        (self.root / self.photo).write_bytes(self.body)
        for changes in [{'imageSha256': 'b' * 64}, {'image': 'assets/biljke/../../private.jpg'},
                        {'image': 'https://nursery.test/photo.jpg'}]:
            self.write(reviewed.REGISTRY, {**self.registry, 'entries': [{**self.entry, **changes}]})
            self.assert_rejected_without_write()

    def test_same_image_cannot_be_attached_to_different_cultivars(self):
        other = {**self.offer, 'id': 'o2', 'plantId': 'p2'}
        self.write('data/kataloske-stavke.json', {**self.document, 'offers': [self.offer, other]})
        second = {**self.entry, 'plantId': 'p2', 'latinName': self.plants[1]['latinName'], 'offerIds': ['o2']}
        self.write(reviewed.REGISTRY, {**self.registry, 'entries': [self.entry, second]})
        self.assert_rejected_without_write()

    def test_same_pixels_already_on_other_plant_cannot_be_reused(self):
        # A different filename and format can still contain the same decoded pixels.
        with Image.open(io.BytesIO(self.body)) as image:
            output = io.BytesIO()
            image.save(output, format='PNG')
        png = 'assets/biljke/other-existing.png'
        (self.root / png).write_bytes(output.getvalue())
        plants = copy.deepcopy(self.plants)
        plants[1]['photo'] = {'image': png, 'sourceUrl': 'https://nursery.test/other'}
        self.write('data/biljke.json', {'plants': plants})
        self.assert_rejected_without_write()

    def test_same_plant_multiple_explicit_variants_can_share_reviewed_image(self):
        other = {**self.offer, 'id': 'o2', 'height': '250–300'}
        self.write('data/kataloske-stavke.json', {**self.document, 'offers': [self.offer, other]})
        self.write(reviewed.REGISTRY, {**self.registry, 'entries': [{**self.entry, 'offerIds': ['o1', 'o2']}]})
        self.assertEqual(reviewed.run(self.root, apply=True)['changedOffers'], 2)

    def test_private_paths_and_out_of_bounds_crops_are_rejected(self):
        for changes in [{'sourceFile': 'C:\\private\\offer.pdf'}, {'originalPath': '/private/offer.pdf'},
                        {'identityEvidence': 'C:\\private\\source.pdf'},
                        {'crop': {'left': 0, 'top': 0, 'right': 300, 'bottom': 200, 'unit': 'pixels'},
                         'originalDimensions': [200, 200]}]:
            entry = {**self.entry, 'provenance': {**self.entry['provenance'], **changes}}
            self.write(reviewed.REGISTRY, {**self.registry, 'entries': [entry]})
            self.assert_rejected_without_write()

    def test_concurrent_input_change_is_detected_before_write(self):
        original = reviewed.fingerprints
        concurrent = copy.deepcopy(self.document)
        concurrent['offers'][0]['price'] = 93
        changed = False
        def replacing(body, **kwargs):
            nonlocal changed
            if not changed:
                changed = True
                self.write('data/kataloske-stavke.json', concurrent)
            return original(body, **kwargs)
        with patch.object(reviewed, 'fingerprints', side_effect=replacing):
            with self.assertRaisesRegex(PhotoError, 'Input changed'):
                reviewed.run(self.root, apply=True)
        self.assertEqual(self.read('data/kataloske-stavke.json'), concurrent)

    def supplemental(self):
        document = copy.deepcopy(self.document)
        document['offers'][0]['sourceDate'] = '2025-09-12'
        document['offers'][0]['sourceEvidence']['sourceFile'] = 'Angebot-Nr 309236.pdf'
        self.write('data/kataloske-stavke.json', document)
        entry = copy.deepcopy(self.entry)
        entry['provenance']['sourceFile'] = 'Angebot-Nr 309236.pdf'
        entry['supplementalProof'] = {'photoSourceFile': 'fotos.pdf', 'photoSourceSha256': 'b' * 64,
                                      'quoteNumber': '309236', 'quoteDate': '2025-09-12', 'position': '8'}
        return document, entry

    def test_supplement_keeps_priced_source_hash_and_separate_photo_source_hash(self):
        original, entry = self.supplemental()
        self.write(reviewed.REGISTRY, {**self.registry, 'entries': [entry]})
        self.assertEqual(reviewed.run(self.root, apply=True)['changedOffers'], 1)
        after = self.read('data/kataloske-stavke.json')
        reviewed.protect(original, after)
        offer = after['offers'][0]
        self.assertEqual(offer['sourceEvidence']['sourceSha256'], 'a' * 64)
        self.assertEqual(offer['imageEvidence']['sourceSha256'], 'a' * 64)
        self.assertEqual(offer['imageEvidence']['supplementalProof']['photoSourceSha256'], 'b' * 64)

    def test_unlinked_supplement_is_rejected_for_wrong_quote_date_position_or_hash(self):
        for field, value in [('quoteNumber', '309237'), ('quoteDate', '2025-09-13'), ('position', '9'),
                             ('photoSourceSha256', 'a' * 64), ('photoSourceFile', '/private/fotos.pdf')]:
            with self.subTest(field=field):
                _, entry = self.supplemental()
                entry['supplementalProof'][field] = value
                self.write(reviewed.REGISTRY, {**self.registry, 'entries': [entry]})
                self.assert_rejected_without_write()


if __name__ == '__main__':
    unittest.main()

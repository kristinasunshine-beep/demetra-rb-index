"""Regression checks for reviewed archive axes and source-safe migrations."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from extract_offer_parameters import extract_offer_parameters

spec = importlib.util.spec_from_file_location('axis_panel_migration', ROOT / 'scripts/migrate-panel-data.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class ReviewedMeasurementAxesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalogue = json.loads((ROOT / 'data/kataloske-stavke.json').read_text())
        cls.offers = {o['id']: o for o in cls.catalogue['offers']}

    def row(self, record_id):
        return copy.deepcopy(self.offers[record_id])

    def migrate_one(self, row):
        doc = {'sourcePolicy': {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']},
               'updatedAt': '2026-11-10T00:00:00Z', 'offers': [row]}
        return migration.migrate(doc)[0]['offers'][0]

    def test_aesculus_vestita_girth_price_container_and_no_generic_duplicate(self):
        row = self.row('record-537f5680ca6acf')
        before = copy.deepcopy(row)
        after = self.migrate_one(row)
        self.assertEqual(after['circumference'], '18–20')
        self.assertEqual(after['height'], '')
        self.assertEqual(after['price'], 80.5)
        self.assertEqual(after['currency'], 'EUR')
        self.assertEqual(after['rootType'], 'Kontejner (cont)')
        self.assertFalse(any(p['label'] == 'Dimenzija iz ponude' for p in after.get('additionalParameters', [])))
        self.assertEqual(row, before, 'Migration must not mutate its input.')

    def test_photo_and_price_refreshes_survive_semantic_correction(self):
        row = self.row('record-537f5680ca6acf')
        row.update(image='assets/biljke/newer-photo.jpg', imageSourceUrl='https://example.org/newer-photo',
                   imageKind='Kataloška fotografija rasadnika', price=81.75)
        after = self.migrate_one(row)
        self.assertEqual(after['circumference'], '18–20')
        for key in ('image', 'imageSourceUrl', 'imageKind', 'price', 'currency', 'priceEvidence',
                    'plantId', 'nurseryId', 'specification', 'sourceEvidence', 'seedlingType'):
            self.assertEqual(after.get(key), row.get(key), key)

    def test_changed_source_hash_cannot_receive_reviewed_axis(self):
        row = self.row('record-537f5680ca6acf')
        row['circumference'] = ''
        row['sourceEvidence']['sourceSha256'] = '0' * 64
        result = extract_offer_parameters(row)
        self.assertNotIn('circumference', result['set'])

    def test_changed_source_row_text_cannot_receive_reviewed_axis(self):
        row = self.row('record-537f5680ca6acf')
        row['circumference'] = ''
        row['specification'] = "Aesculus flava 'Vestita'; 25-30 Cont."
        self.assertNotIn('circumference', extract_offer_parameters(row)['set'])

    def test_a_similar_unreviewed_container_range_is_not_blanket_girth(self):
        row = self.row('record-537f5680ca6acf')
        row.update(id='unreviewed-other-source-row', nurseryId='unreviewed-nursery', circumference='')
        result = extract_offer_parameters(row)
        self.assertNotIn('circumference', result['set'])
        self.assertNotIn('height', result['set'])

    def test_unexpected_existing_axis_is_not_overwritten_or_silently_retired(self):
        row = self.row('record-537f5680ca6acf')
        row['circumference'] = '99–100'
        row['additionalParameters'] = [{'label': 'Dimenzija iz ponude', 'value': '18-20'}]
        after = self.migrate_one(row)
        self.assertEqual(after['circumference'], '99–100')
        self.assertTrue(any(p['label'] == 'Dimenzija iz ponude' and '18-20' in p['value']
                            for p in after.get('additionalParameters', [])))

    def test_magnolia_requested_height_is_not_promoted_to_offered_height(self):
        row = self.row('record-02d49f2a062ef4')
        original_girth = row['circumference']
        after = self.migrate_one(row)
        self.assertEqual(after['height'], row['height'])
        self.assertEqual(after['circumference'], original_girth)
        self.assertFalse(any(p['label'] == 'Dimenzija iz ponude' and '4/5' in p['value']
                             for p in after.get('additionalParameters', [])))
        self.assertEqual(after['specification'], row['specification'])
        self.assertEqual(after['priceEvidence'], row['priceEvidence'])

    def test_source_form_fraction_is_not_a_dimension(self):
        row = self.row('record-70f7663ca63df2')
        after = self.migrate_one(row)
        self.assertFalse(any(p['label'] == 'Dimenzija iz ponude' and '1/2' in p['value']
                             for p in after.get('additionalParameters', [])))
        self.assertEqual(after['height'], row['height'])
        self.assertEqual(after['circumference'], row['circumference'])

    def test_two_explicit_arbor_axes_do_not_use_nearest_STD_number_as_girth(self):
        row = self.row('record-64fdece00237f3')
        after = self.migrate_one(row)
        self.assertEqual(after['circumference'], '40–45')
        self.assertEqual(after['height'], '500+')
        self.assertEqual(after['dataAccuracyNote'], 'Podaci se odnose na ovu izvornu varijantu ponude.')
        self.assertFalse(any(character.isdigit() for character in after['dataAccuracyNote']))
        self.assertEqual(self.migrate_one(after), after)
        self.assertTrue(any(p['label'] == 'Visina čistog debla' and p['value'] == '200'
                            for p in after.get('additionalParameters', [])))

    def test_unlabelled_second_STD_size_does_not_become_total_height(self):
        row = self.row('record-b933c63839c7f4')
        after = self.migrate_one(row)
        self.assertEqual(after['circumference'], '20–25')
        self.assertEqual(after['height'], row['height'])
        self.assertTrue(any(p['label'] == 'Oznaka veličine uz STD' and p['value'] == '150+'
                            for p in after.get('additionalParameters', [])))

    def test_legitimate_large_girth_and_plus_grade_stay_girth(self):
        for record_id in ('record-fffade1d616474', 'record-2ff9815951ab38'):
            row = self.row(record_id)
            after = self.migrate_one(row)
            self.assertEqual(after['circumference'], row['circumference'])
            self.assertEqual(after['height'], row['height'])

    def test_aesculus_migration_is_idempotent(self):
        first = self.migrate_one(self.row('record-537f5680ca6acf'))
        self.assertEqual(self.migrate_one(first), first)


if __name__ == '__main__':
    unittest.main()

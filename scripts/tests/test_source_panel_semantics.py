import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from classify_offer_traits import classify_offer
from extract_offer_parameters import extract_offer_parameters
from recover_ods_prices import recover, EXPECTED_SHA
from materialize_source_rows import materialize

module_spec = importlib.util.spec_from_file_location('panel_migration', SCRIPTS/'migrate-panel-data.py')
migration = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(migration)


def request():
    text = "Abies concolor 'Glauca'; Height: 100-150; br/cont/rb: rb"
    return {'id': 'request-glauca', 'plantId': 'glauca', 'nurseryId': 'combinatie-mauritz',
            'price': None, 'priceKind': 'unpublished', 'specification': text,
            'sourceEvidence': {'archiveVerified': True, 'sourceSha256': EXPECTED_SHA,
                'sourceFile': 'ponuda Marina Dorćol.ods', 'sheet': 'Blad1', 'row': 119,
                'multipleVariants': False, 'parameterRole': 'requested',
                'sourceSpecifications': [{'recordRole': 'requested_with_supplier_note',
                    'sheet': 'Blad1', 'row': 119, 'requestedDescription': text,
                    'supplierNote': 'concolor'}]}}


class SourcePanelSemanticsTests(unittest.TestCase):
    def test_isolated_glauca_request_has_its_own_height_and_packaging(self):
        row = request()
        original = copy.deepcopy(row)
        result = extract_offer_parameters(row)
        self.assertEqual(result['set']['height'], '100–150')
        self.assertEqual(result['set']['rootType'], 'Busen (RB)')
        self.assertNotIn('circumference', result['set'])
        self.assertEqual(row, original)
        self.assertIsNone(row['price'])
        self.assertIn('zahtevanom redu', classify_offer(row)['dataAccuracyNote'])

    def test_request_marker_cannot_authorize_a_merged_or_priced_alternative(self):
        variants = []
        merged = request(); merged['sourceEvidence']['sourceSpecifications'].append(
            copy.deepcopy(merged['sourceEvidence']['sourceSpecifications'][0]))
        variants.append(merged)
        priced = request(); priced['price'] = 87.45; variants.append(priced)
        changed = request(); changed['specification'] += '; height 450'; variants.append(changed)
        for row in variants:
            with self.subTest(row=row):
                self.assertNotIn('height', extract_offer_parameters(row)['set'])

    def test_size_retired_from_generic_field_only_after_semantic_mapping(self):
        extras = [{'label': 'Dimenzija iz ponude', 'value': '100-150; 40-60'},
                  {'label': 'Visina čistog debla', 'value': '180 cm'}]
        clean = migration.remove_mapped_generic_dimensions(extras, {'height': '100–150'})
        self.assertEqual(clean, [{'label': 'Dimenzija iz ponude', 'value': '40-60'},
                                 {'label': 'Visina čistog debla', 'value': '180 cm'}])
        self.assertEqual(migration.remove_mapped_generic_dimensions(
            [{'label': 'Dimenzija iz ponude', 'value': '100-150 mm'}], {'height': '100–150 cm'}),
            [{'label': 'Dimenzija iz ponude', 'value': '100-150 mm'}])

    def test_ods_recovery_does_not_give_replacement_price_to_requested_cultivar(self):
        row = request()
        document = {'offers': [row], 'updatedAt': 'unchanged'}
        source_rows = {119: {'B': {'value': "Abies concolor 'Glauca'"},
                            'C': {'value': '100-150'}, 'F': {'value': 'rb'},
                            'G': {'value': 87.45, 'display': '€ 87.45', 'currency': 'EUR'},
                            'H': {'value': 'concolor'}}}
        result, report = recover(document, {'plants': [{'id': 'glauca',
                                    'latinName': "Abies concolor 'Glauca'"}]}, source_rows)
        self.assertEqual(result, document)
        self.assertEqual(report['recoveredPrices'], 0)
        self.assertEqual(len(report['skippedAmendments']), 1)

    def test_original_price_uses_exact_taxon_and_same_row(self):
        row = {'id': 'acer', 'plantId': 'acer', 'price': None,
               'sourceAmount': 5800, 'sourceCurrency': 'RSD',
               'priceConversion': {'status': 'converted', 'originalAmount': 5800},
               'priceRefresh': {'status': 'verified', 'sourceSha256': 'old'},
               'sourceEvidence': {'sourceSha256': EXPECTED_SHA, 'sheet': 'Blad1', 'row': 4}}
        rows = {4: {'B': {'value': 'Acer campestre'}, 'E': {'value': 1},
                    'G': {'value': 42.9, 'display': '€ 42.90', 'currency': 'EUR'}}}
        result, report = recover({'offers': [row]}, {'plants': [
            {'id': 'acer', 'latinName': 'Acer campestre'}]}, rows)
        self.assertEqual(result['offers'][0]['price'], 42.9)
        self.assertEqual(result['offers'][0]['currency'], 'EUR')
        self.assertEqual(result['offers'][0]['sourceAmount'], 42.9)
        self.assertEqual(result['offers'][0]['sourceCurrency'], 'EUR')
        self.assertEqual(result['offers'][0]['sourceCurrencyEvidence']['priceCell'], 'G4')
        self.assertNotIn('priceConversion', result['offers'][0])
        self.assertNotIn('priceRefresh', result['offers'][0])
        self.assertEqual(row['sourceAmount'], 5800, 'Input document must remain unchanged')
        self.assertEqual(result['offers'][0]['priceEvidence']['priceCell'], 'G4')
        self.assertEqual(report['recoveredPrices'], 1)
        with self.assertRaisesRegex(ValueError, 'source_taxon_mismatch'):
            recover({'offers': [row]}, {'plants': [{'id': 'acer', 'latinName': 'Acer platanoides'}]}, rows)

    def test_new_source_rows_cannot_inherit_parent_fx_or_restore_excluded_rows(self):
        payload = b'In-memory source fixture'; sha = hashlib.sha256(payload).hexdigest()
        member = 'Rasadnici ponude/fixture.txt'
        specs = [{'recordRole': 'archive_variant', 'sheet': 'Sheet1', 'row': r,
                  'rawName': 'Acer campestre', 'specification': f'Acer campestre; Height: {r}00'} for r in (2, 3)]
        parent = {'id': 'aggregate', 'plantId': 'acer', 'nurseryId': 'fixture',
                  'source': 'Fixture archive', 'price': None, 'currency': '',
                  'priceKind': 'unpublished', 'image': 'unchanged.jpg',
                  'sourceAmount': 5800, 'sourceCurrency': 'RSD',
                  'sourceCurrencyEvidence': {'currency': 'RSD'},
                  'currencyEvidence': {'currency': 'RSD'},
                  'priceConversion': {'status': 'converted', 'originalAmount': 5800},
                  'priceRefresh': {'status': 'verified'}, 'priceObservation': {'raw': '5800'},
                  'sourceEvidence': {'archivePath': member, 'sourceSha256': sha,
                                     'multipleVariants': True, 'sourceSpecifications': specs}}
        document = {'offers': [parent]}; original = copy.deepcopy(document)
        plants = {'plants': [{'id': 'acer', 'latinName': 'Acer campestre'}]}
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, 'w') as archive:
            archive.writestr(member, payload)
        with tempfile.TemporaryDirectory() as temporary, zipfile.ZipFile(io.BytesIO(archive_bytes.getvalue())) as archive:
            root = Path(temporary)
            result, report = materialize(document, plants, archive, root)
            children = [o for o in result['offers'] if o['id'] != parent['id']]
            self.assertEqual(len(children), 2)
            self.assertEqual(report['summary']['newRows'], 2)
            for child in children:
                self.assertIsNone(child['price'])
                self.assertEqual(child['image'], 'unchanged.jpg')
                for field in ('sourceAmount', 'sourceCurrency', 'sourceCurrencyEvidence',
                              'priceConversion', 'priceRefresh', 'currencyEvidence', 'priceObservation'):
                    self.assertNotIn(field, child, field)
            (root/'scripts').mkdir()
            (root/'scripts/catalog-exclusions.json').write_text(json.dumps({
                'schemaVersion': 1, 'excludedOffers': [{'offerId': 'different-old-id',
                    'sourceSha256': sha, 'sheet': 'Sheet1', 'priceCell': 'D2'}]}), encoding='utf8')
            with self.assertRaisesRegex(ValueError, 'explicitly excluded'):
                materialize(document, plants, archive, root)
        self.assertEqual(document, original)


if __name__ == '__main__':
    unittest.main()

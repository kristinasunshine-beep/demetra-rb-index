import copy
import importlib.util
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from classify_offer_traits import classify_offer
from extract_offer_parameters import extract_offer_parameters
from recover_ods_prices import recover, EXPECTED_SHA

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
               'sourceEvidence': {'sourceSha256': EXPECTED_SHA, 'sheet': 'Blad1', 'row': 4}}
        rows = {4: {'B': {'value': 'Acer campestre'}, 'E': {'value': 1},
                    'G': {'value': 42.9, 'display': '€ 42.90', 'currency': 'EUR'}}}
        result, report = recover({'offers': [row]}, {'plants': [
            {'id': 'acer', 'latinName': 'Acer campestre'}]}, rows)
        self.assertEqual(result['offers'][0]['price'], 42.9)
        self.assertEqual(result['offers'][0]['currency'], 'EUR')
        self.assertEqual(result['offers'][0]['priceEvidence']['priceCell'], 'G4')
        self.assertEqual(report['recoveredPrices'], 1)
        with self.assertRaisesRegex(ValueError, 'source_taxon_mismatch'):
            recover({'offers': [row]}, {'plants': [{'id': 'acer', 'latinName': 'Acer platanoides'}]}, rows)


if __name__ == '__main__':
    unittest.main()

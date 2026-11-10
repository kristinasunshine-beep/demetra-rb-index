import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_catalog_parameters as subject

URL = 'https://innocentiemangonipiante.it/en/berberis-thunbergii-atropurpurea/'
VANNUCCI_URL = 'https://webshop.vannuccipiante.it/product/parrotia-persica/'


def page(height='02,00 &ndash; 03,00 meters', width=None):
    def row(label, value):
        return ('<div class="uk-grid uk-grid-collapse uk-margin"><div><h3>' + label +
                '</h3></div><div><div class="el-content">' + value + '</div></div></div>')
    return ('<html><head><link rel="canonical" href="' + URL + '"></head><body>'
            '<h1>BERBERIS thunbergii ‘Atropurpurea’</h1>' +
            (row('Max height', height) if height is not None else '') +
            (row('Spread', width) if width is not None else '') + '</body></html>')


def offer(nursery=subject.INNOCENTI):
    return {
        'id': 'offer-1', 'plantId': 'plant-1', 'nurseryId': nursery,
        'sourceUrl': URL if nursery == subject.INNOCENTI else VANNUCCI_URL,
        'height': '120–140 cm', 'potSize': '', 'price': 123, 'currency': 'EUR',
        'currencyStatus': 'stated', 'priceEvidence': {'kind': 'historical'},
        'checkedAt': '2026-11-06', 'sourceDate': '2025-11-27',
        'image': 'assets/biljke/existing.jpg', 'priceObservation': {'observedAt': 'old'},
        'specification': '', 'measurementNote': 'Original note.', 'customField': {'kept': True},
    }


def document(row):
    return {'schemaVersion': 1, 'updatedAt': 'old', 'offers': [row], 'otherRootData': {'keep': True}}


class CatalogueParameterTests(unittest.TestCase):
    def test_berberis_height_is_mature_and_source_width_not_invented(self):
        found = subject.innocenti_parameters(page(), URL)['fields']
        self.assertEqual(found['matureHeight']['value'], '2–3 m')
        self.assertNotIn('height', found)
        self.assertNotIn('matureCrownWidth', found)

    def test_spread_requires_its_own_explicit_label_and_unit(self):
        found = subject.innocenti_parameters(page(width='01.50 – 02.00 meters'), URL)['fields']
        self.assertEqual(found['matureCrownWidth']['value'], '1.5–2 m')
        with self.assertRaises(subject.ParameterError):
            subject.innocenti_parameters(page(width='1.5–2'), URL)

    def test_css_height_and_prose_are_not_dimensions(self):
        text = page(None).replace('</body>', '<style>.x{max-height:300px}</style><p>Height: 9 meters</p></body>')
        self.assertEqual(subject.innocenti_parameters(text, URL)['fields'], {})

    def test_conflicting_duplicate_and_reversed_range_are_rejected(self):
        extra = '<div class="uk-grid uk-grid-collapse uk-margin"><h3>Max height</h3><div class="el-content">4 meters</div></div>'
        with self.assertRaises(subject.ParameterError):
            subject.innocenti_parameters(page().replace('</body>', extra + '</body>'), URL)
        with self.assertRaises(subject.ParameterError):
            subject.normalize_dimension('3–2 meters')

    def test_product_redirect_or_canonical_cannot_change_identity(self):
        with self.assertRaises(subject.ParameterError):
            subject.checked_url('https://example.com/en/berberis/', subject.INNOCENTI)
        with self.assertRaises(subject.ParameterError):
            subject.innocenti_parameters(page().replace('href="' + URL, 'href="https://innocentiemangonipiante.it/en/acer-palmatum/'), URL)

    def test_container_codes_are_unique_sorted_and_not_variant_sizes(self):
        spec = 'Shape: Standard; Measures: CLT. 110 16/18, CLT. 35 10/12, CLT. 110 200/250, CLT. 3, CLT. 7.5, RETE 0 350/400, LV 9; Shape: Ball'
        result = subject.vannucci_container_codes(spec)
        self.assertEqual(result['value'], 'CLT 3, 7.5, 35, 110')
        self.assertIn('CLT. 110 200/250', result['raw'])
        self.assertIsNone(subject.vannucci_container_codes('Measures: LV 9, RETE 0 350/400'))

    def test_all_original_prices_dates_images_and_sale_height_survive(self):
        original = document(offer())
        before = copy.deepcopy(original)
        result, report = subject.update_document(original, fetcher=lambda url: page())
        for key, value in original['offers'][0].items():
            self.assertEqual(result['offers'][0][key], value, key)
        self.assertEqual(original, before)
        self.assertEqual(result['offers'][0]['matureHeight'], '2–3 m')
        self.assertEqual(report['updated'], 1)
        self.assertEqual(result['otherRootData'], original['otherRootData'])

    def test_source_failure_keeps_complete_original_row(self):
        original = document(offer())
        def failed(url):
            raise subject.ParameterError('http_error', 'Source unavailable')
        result, report = subject.update_document(original, fetcher=failed)
        self.assertEqual(result, original)
        self.assertEqual(report['failed'], 1)
        self.assertEqual(report['sourceFailures'], 1)

    def test_same_product_is_fetched_once_and_unchanged_run_is_idempotent(self):
        first = offer()
        second = {**offer(), 'id': 'offer-2'}
        original = document(first)
        original['offers'].append(second)
        calls = []
        def fetch(url):
            calls.append(url)
            return page()
        updated, report = subject.update_document(original, fetcher=fetch)
        self.assertEqual(len(calls), 1)
        self.assertEqual(report['updated'], 2)
        again, second_report = subject.update_document(updated, fetcher=fetch, now='2027-01-01T00:00:00Z')
        self.assertEqual(again, updated)
        self.assertEqual(second_report['updated'], 0)

    def test_vannucci_preserves_raw_specification_and_existing_note(self):
        row = offer(subject.VANNUCCI)
        row['specification'] = 'Measures: CLT. 35 10/12, CLT. 10, CLT. 35 200/250, LV 9'
        original = document(row)
        result, report = subject.update_document(original, nursery=subject.VANNUCCI)
        updated = result['offers'][0]
        self.assertEqual(updated['potSize'], 'CLT 10, 35')
        self.assertEqual(updated['height'], row['height'])
        self.assertEqual(updated['specification'], row['specification'])
        self.assertTrue(updated['measurementNote'].startswith('Original note. '))
        self.assertIn(subject.MEASUREMENT_NOTE, updated['measurementNote'])
        self.assertEqual(report['requests'], 0)

    def test_existing_sale_pot_is_not_replaced_by_catalogue_list(self):
        row = offer(subject.VANNUCCI)
        row.update(potSize='C35', specification='Measures: CLT. 10, CLT. 35 10/12')
        original = document(row)
        result, report = subject.update_document(original, nursery=subject.VANNUCCI)
        self.assertEqual(result, original)
        self.assertEqual(report['updated'], 0)

    def test_cli_dry_run_writes_patch_report_but_preserves_catalogue_bytes(self):
        row = offer(subject.VANNUCCI)
        row['specification'] = 'Measures: CLT. 10, CLT. 3'
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            data = base / 'data.json'
            report_path = base / 'report.json'
            data.write_text(json.dumps(document(row)), encoding='utf-8')
            before = data.read_bytes()
            status = subject.main(['--data', str(data), '--report', str(report_path), '--nursery', subject.VANNUCCI, '--dry-run'])
            self.assertEqual(status, 0)
            self.assertEqual(data.read_bytes(), before)
            report = json.loads(report_path.read_text())
            self.assertTrue(report['dataChanged'])
            self.assertFalse(report['catalogueWritten'])
            self.assertEqual(report['changes'][0]['set']['potSize'], 'CLT 3, 10')


if __name__ == '__main__':
    unittest.main()

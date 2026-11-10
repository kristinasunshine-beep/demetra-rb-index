"""Archive-only records must never receive online prices or dimensions."""
import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_prices
import update_catalog_parameters


def archive_catalogue():
    return {
        'schemaVersion': 1, 'updatedAt': '2026-11-09T10:00:00Z',
        'sourcePolicy': {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']},
        'offers': [{
            'id': 'offer-1', 'plantId': 'plant-1', 'nurseryId': 'arbor',
            'price': 450, 'currency': 'EUR', 'priceKind': 'historical',
            'circumference': '25–30', 'height': '', 'seedlingType': 'standard',
            'transplantCount': 3, 'transplantNote': 'U ponudi: 3xv.',
            'dataAccuracyNote': 'Visina nije navedena u ovom redu ponude.',
            'specification': 'Acer campestre Elsrijk 25-30 STD RB',
            'dataOrigin': 'rasadnici-ponude-zip',
        }],
    }


class SourcePolicyTests(unittest.TestCase):
    def test_price_update_is_blocked_before_configuration_or_network(self):
        original = archive_catalogue()
        before = copy.deepcopy(original)
        fetcher = Mock(side_effect=AssertionError('Network must not be called'))
        result, report = update_prices.update_document(original, {'invalid': 'old configuration'}, fetcher)
        fetcher.assert_not_called()
        self.assertEqual(result, before)
        self.assertEqual(original, before)
        self.assertEqual(report['status'], 'disabled_by_source_policy')
        self.assertEqual(report['requests'], 0)
        self.assertFalse(report['dataChanged'])

    def test_online_parameters_are_blocked_even_with_a_supported_url(self):
        original = archive_catalogue()
        original['offers'][0].update(nurseryId='innocenti-mangoni',
                                    sourceUrl='https://innocentiemangonipiante.it/en/acer-campestre/')
        before = copy.deepcopy(original)
        fetcher = Mock(side_effect=AssertionError('Network must not be called'))
        result, report = update_catalog_parameters.update_document(original, fetcher=fetcher)
        fetcher.assert_not_called()
        self.assertEqual(result, before)
        self.assertEqual(report['status'], 'disabled_by_source_policy')
        self.assertEqual(report['requests'], 0)
        self.assertFalse(report['dataChanged'])

    def test_legacy_cli_invocations_keep_original_catalogue_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / 'catalogue.json'
            # Noncanonical formatting proves that the CLI does not rewrite it.
            original_bytes = json.dumps(archive_catalogue(), ensure_ascii=False).encode() + b'\n\n'
            data.write_bytes(original_bytes)
            price_report, parameter_report = root / 'prices.json', root / 'parameters.json'
            with patch.object(update_prices, 'PublicFetcher', side_effect=AssertionError('Fetcher constructed')), redirect_stdout(io.StringIO()):
                result = update_prices.main(['--data', str(data), '--config', str(root / 'absent.json'), '--report', str(price_report)])
            self.assertEqual(result, 0)
            self.assertEqual(data.read_bytes(), original_bytes)
            with patch.object(update_catalog_parameters, 'fetch_page', side_effect=AssertionError('Page fetched')), redirect_stdout(io.StringIO()):
                result = update_catalog_parameters.main(['--data', str(data), '--report', str(parameter_report)])
            self.assertEqual(result, 0)
            self.assertEqual(data.read_bytes(), original_bytes)
            for report in [price_report, parameter_report]:
                result = json.loads(report.read_text())
                self.assertEqual(result['status'], 'disabled_by_source_policy')
                self.assertEqual(result['requests'], 0)
                self.assertFalse(result['dataChanged'])


if __name__ == '__main__':
    unittest.main()

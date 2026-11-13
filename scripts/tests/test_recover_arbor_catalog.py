"""Regression checks for the narrow, historical Arbor import repair."""
import copy
from contextlib import redirect_stdout
from decimal import Decimal
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recover_arbor_catalog as repair

PRODUCT = "Abies concolor 450-500 C500L"
NOW = "2026-11-09T12:00:00Z"


def row(index=4, product=PRODUCT, price="2000", new_inpot="", status=None):
    amount = Decimal(price) if price is not None else None
    return repair.SourceRow(index, product, new_inpot, amount, price or "", status or ("positive" if amount and amount > 0 else "zero" if amount == 0 else "missing"))


def source(rows=None):
    return repair.Source("Arbor-2026-04-15.xlsx", repair.SOURCE_SHA256, rows if rows is not None else [row()])


def offer(identifier="arbor-1", product=PRODUCT):
    return {"id": identifier, "plantId": "plant-abies-concolor", "nurseryId": "arbor", "sourceDate": "2026-04-15", "sourcePeriod": "2026-04-15", "priceKind": "historical", "specification": "Product: " + product, "price": None, "currency": "", "unit": "jedinica iz cenovnika", "priceNote": "Valuta nije navedena u izvornom cenovniku.", "taxStatus": "PDV nije naveden", "availability": "not confirmed", "checkedAt": "", "sourceUrl": "", "image": "assets/catalogue/photo.webp", "imageSourceUrl": "https://example.org/original-image", "height": "", "circumference": "", "crownWidth": "", "rootBall": "", "potSize": "C500L", "rootType": "", "demo": False}


def document(offers=None):
    return {"schemaVersion": 1, "updatedAt": "2026-11-06T00:00:00Z", "offers": offers if offers is not None else [offer()]}


class ArborRepairTests(unittest.TestCase):
    def test_actual_target_amount_and_auditable_evidence(self):
        original = document(); snapshot = copy.deepcopy(original)
        result, report = repair.recover(original, source(), now=NOW)
        actual = result["offers"][0]
        self.assertEqual(original, snapshot)
        self.assertEqual(actual["price"], 2000)
        self.assertEqual(actual["currency"], "")
        self.assertEqual(actual["currencyStatus"], "not_stated")
        self.assertEqual(actual['sourceAmount'], 2000)
        self.assertEqual(actual['sourceCurrency'], '')
        self.assertEqual(actual["priceKind"], "historical")
        self.assertEqual(actual["priceNote"], repair.NO_CURRENCY_NOTE)
        self.assertEqual(actual["priceEvidence"]["priceCell"], "E4")
        self.assertEqual(actual["priceEvidence"]["amount"], 2000)
        self.assertEqual(actual["priceEvidence"]["sourceSha256"], repair.SOURCE_SHA256)
        self.assertEqual(actual["height"], "450–500")
        self.assertEqual(actual["potSize"], "500 L")
        self.assertEqual(actual["rootType"], "Kontejner")
        self.assertEqual(actual["measurementNote"], repair.NO_LENGTH_UNIT_NOTE)
        self.assertEqual(report["counts"]["positiveAmounts"], 1)

    def test_dates_photos_and_other_price_metadata_preserved(self):
        original = document()
        result, _ = repair.recover(original, source(), now=NOW)
        for field in ["sourceDate", "sourcePeriod", "sourceUrl", "checkedAt", "image", "imageSourceUrl", "unit", "taxStatus", "availability", "specification", "plantId", "nurseryId"]:
            self.assertEqual(result["offers"][0][field], original["offers"][0][field], field)

    def test_public_prices_and_other_dates_are_outside_scope(self):
        public = offer("public"); public.update(nurseryId="biojela", priceKind="public", price=4200, currency="RSD")
        previous = offer("previous"); previous["sourceDate"] = "2025-11-27"
        other_kind = offer("arbor-public"); other_kind.update(priceKind="public", price=2500, currency="EUR")
        doc = document([offer(), public, previous, other_kind]); result, report = repair.recover(doc, source(), now=NOW)
        self.assertEqual(result["offers"][1:], doc["offers"][1:])
        self.assertEqual(report["publicPricedRecordsPreserved"], 2)
        self.assertEqual([o["id"] for o in result["offers"]], [o["id"] for o in doc["offers"]])

    def test_only_whitespace_normalization(self):
        doc = document([offer(product="  Abies   concolor  450-500  C500L  ")])
        result, _ = repair.recover(doc, source(), now=NOW)
        self.assertEqual(result["offers"][0]["price"], 2000)
        doc = document([offer(product="Abies concolor 450–500 C500L")])
        result, report = repair.recover(doc, source(), now=NOW)
        self.assertEqual(result, doc)
        self.assertEqual(report["counts"]["unmatched"], 1)

    def test_new_inpot_is_an_exact_separate_column(self):
        old = offer("old")
        new = offer("new"); new["specification"] += "; NEW INPOT: 2026-2027"
        src = source([row(4), row(5, price="0", new_inpot="2026-2027")])
        result, report = repair.recover(document([old, new]), src, now=NOW)
        self.assertEqual(result["offers"][0]["price"], 2000)
        self.assertIsNone(result["offers"][1]["price"])
        self.assertEqual(result["offers"][1]["priceEvidence"]["priceCell"], "E5")
        self.assertEqual(result["offers"][1]["specification"], new["specification"])
        self.assertEqual(report["counts"]["matchedExplicitNewInpot"], 1)

    def test_no_suffix_requires_empty_source_C(self):
        doc = document()
        result, report = repair.recover(doc, source([row(new_inpot="2026-2027")]), now=NOW)
        self.assertEqual(result, doc)
        self.assertEqual(report["counts"]["unmatched"], 1)

    def test_agreeing_duplicates_keep_all_row_evidence(self):
        result, report = repair.recover(document(), source([row(20), row(4, price="2000.00")]), now=NOW)
        evidence = result["offers"][0]["priceEvidence"]
        self.assertEqual(evidence["sourceRows"], [4, 20])
        self.assertEqual(evidence["priceCell"], "E4")
        self.assertEqual(report["counts"]["agreeingDuplicateMatches"], 1)

    def test_conflicting_duplicates_preserve_complete_row(self):
        doc = document()
        result, report = repair.recover(doc, source([row(4), row(20, price="2500")]), now=NOW)
        self.assertEqual(result, doc)
        self.assertEqual(report["counts"]["conflictingDuplicates"], 1)

    def test_zero_is_unknown_price_not_free(self):
        result, report = repair.recover(document(), source([row(price="0")]), now=NOW)
        actual = result["offers"][0]
        self.assertIsNone(actual["price"])
        self.assertEqual(actual["priceNote"], repair.ZERO_NOTE)
        self.assertEqual(actual["priceEvidence"]["amount"], 0)
        self.assertEqual(report["counts"]["zeroAmountsLeftNull"], 1)

    def test_reimport_clears_stale_converted_amount_and_zero_cannot_restore_it(self):
        for raw_price, expected in [('2000', 2000), ('0', None)]:
            with self.subTest(raw_price=raw_price):
                old = offer()
                old.update(price=49.31, currency='EUR', currencyStatus='converted',
                           sourceAmount=5800, sourceCurrency='RSD',
                           sourceCurrencyEvidence={'currency': 'RSD'},
                           priceConversion={'status': 'converted', 'originalAmount': 5800},
                           priceRefresh={'status': 'verified'}, priceObservation={'raw': '5800'})
                original = document([old]); snapshot = copy.deepcopy(original)
                result, _ = repair.recover(original, source([row(price=raw_price)]), now=NOW)
                actual = result['offers'][0]
                self.assertEqual(actual['price'], expected)
                self.assertEqual(actual['sourceAmount'], expected)
                self.assertEqual(actual['sourceCurrency'], '')
                self.assertEqual(actual['currency'], '')
                self.assertEqual(actual['currencyStatus'], 'not_stated')
                for field in ('priceConversion', 'priceRefresh', 'priceObservation'):
                    self.assertNotIn(field, actual)
                self.assertEqual(original, snapshot)

    def test_reimport_preserves_documented_owner_eur_confirmation(self):
        old = offer()
        proof = {'origin': 'catalogue_owner_confirmation', 'reference': 'docs/currency-confirmation.json'}
        old.update(price=80, currency='EUR', currencyStatus='owner_confirmed',
                   sourceAmount=80, sourceCurrency='EUR', currencyEvidence=proof,
                   priceRefresh={'status': 'verified'})
        result, _ = repair.recover(document([old]), source(), now=NOW)
        actual = result['offers'][0]
        self.assertEqual(actual['price'], 2000)
        self.assertEqual(actual['sourceAmount'], 2000)
        self.assertEqual(actual['sourceCurrency'], 'EUR')
        self.assertEqual(actual['currency'], 'EUR')
        self.assertEqual(actual['currencyStatus'], 'owner_confirmed')
        self.assertEqual(actual['sourceCurrencyEvidence'], proof)
        self.assertNotIn('priceRefresh', actual)

    def test_formula_or_missing_price_not_silently_imported(self):
        for status in ["formula_not_evaluated", "missing", "not_numeric_cell", "negative"]:
            with self.subTest(status=status):
                doc = document()
                result, report = repair.recover(doc, source([row(status=status)]), now=NOW)
                self.assertEqual(result, doc)
                self.assertEqual(report["counts"]["unsupportedPrice"], 1)

    def test_RB_and_BR_prevent_container_root_type_inference(self):
        for tag in ["RB", "BR"]:
            fields, _, _ = repair.source_measurements(f"Pinus nigra 250-300 {tag} C110L")
            self.assertEqual(fields["potSize"], "110 L")
            self.assertNotIn("rootType", fields)

    def test_shaped_and_multiple_ranges_are_not_height(self):
        for product in ["Pinus nigra 250-300 STD C110L", "Pinus nigra BALL 250-300 C110L", "Pinus nigra 14-16 350-400 C110L", "Picea abies 175-200 C130L"]:
            with self.subTest(product=product):
                fields, _, _ = repair.source_measurements(product)
                self.assertNotIn("height", fields)
                self.assertNotIn("circumference", fields)

    def test_explicit_labels_preserve_unit_or_mark_unknown(self):
        fields, _, notes = repair.source_measurements("Acer campestre B=150-200 H=300-350 C110L")
        self.assertEqual(fields["crownWidth"], "150–200")
        self.assertEqual(fields["height"], "300–350")
        self.assertIn(repair.NO_LENGTH_UNIT_NOTE, notes)
        fields, _, notes = repair.source_measurements("Acer campestre B=1.5 m HT=300 cm C110L")
        self.assertEqual(fields["height"], "300 cm")
        self.assertEqual(fields["crownWidth"], "1.5 m")
        self.assertNotIn(repair.NO_LENGTH_UNIT_NOTE, notes)

    def test_no_fake_circumference_or_root_ball(self):
        fields, _, _ = repair.source_measurements("Acer campestre 14-16 350-400 FTH C110L")
        self.assertNotIn("height", fields)
        self.assertNotIn("circumference", fields)
        self.assertNotIn("rootBall", fields)

    def test_exact_standard_tree_variant_keeps_girth_separate(self):
        fields, rules, notes = repair.source_measurements("Acer campestre Elsrijk 10-12 STD C80L")
        self.assertEqual(fields['circumference'], '10–12')
        self.assertEqual(fields['potSize'], '80 L')
        self.assertEqual(fields['rootType'], 'Kontejner')
        self.assertNotIn('height', fields)
        self.assertIn(repair.NO_LENGTH_UNIT_NOTE, notes)
        quoted, _, _ = repair.source_measurements("Acer campestre Elsrijk 25-30 STD RB")
        self.assertEqual(quoted['circumference'], '25–30')
        self.assertNotIn('potSize', quoted)

    def test_standard_size_does_not_consume_a_height_or_fragment(self):
        for product in ['Pinus nigra 250-300 STD C110L', 'Acer 125-130 STD', 'Acer 10-12 STD 14-16 STD']:
            self.assertNotIn('circumference', repair.source_measurements(product)[0])

    def test_existing_measurement_is_not_overwritten(self):
        old = offer(); old["height"] = "existing reviewed measurement"
        result, report = repair.recover(document([old]), source(), now=NOW)
        self.assertEqual(result["offers"][0]["height"], old["height"])
        self.assertIn("height", report["records"][0]["preservedMeasurementFields"])

    def test_repair_is_idempotent(self):
        once, _ = repair.recover(document(), source(), now=NOW)
        twice, report = repair.recover(once, source(), now="2026-11-10T12:00:00Z")
        self.assertEqual(twice, once)
        self.assertFalse(report["dataChanged"])

    def test_unknown_source_hash_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "changed-source.bin"; p.write_bytes(b"not the reviewed workbook")
            with self.assertRaises(repair.RepairError):
                repair.read_source(p)

    def test_XML_cell_type_and_formula_are_checked(self):
        xml = '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="B1" t="inlineStr"><is><t>Product</t></is></c><c r="C1" t="inlineStr"><is><t>NEW INPOT</t></is></c><c r="E1" t="inlineStr"><is><t>sales price</t></is></c></row>
        <row r="4"><c r="B4" t="inlineStr"><is><t>Abies concolor 450-500 C500L</t></is></c><c r="E4"><v>2000</v></c></row>
        <row r="5"><c r="B5" t="inlineStr"><is><t>Other plant</t></is></c><c r="E5"><f>2*1000</f><v>2000</v></c></row>
        </sheetData></worksheet>'''
        rows = repair.parse_sheet(xml, [])
        self.assertEqual(rows[0].amount, Decimal("2000"))
        self.assertEqual(rows[1].price_status, "formula_not_evaluated")

    def test_cli_dry_run_does_not_write_catalogue(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); data_path = p / "data.json"; report_path = p / "report.json"
            before = json.dumps(document(), ensure_ascii=False, separators=(",", ":")).encode()
            data_path.write_bytes(before)
            with patch.object(repair, "read_source", return_value=source()), redirect_stdout(io.StringIO()):
                code = repair.main(["--source", str(p / "source.xlsx"), "--data", str(data_path), "--report", str(report_path), "--dry-run"])
            self.assertEqual(code, 0)
            self.assertEqual(data_path.read_bytes(), before)
            report = json.loads(report_path.read_text())
            self.assertTrue(report["dryRun"])
            self.assertFalse(report["dataWritten"])


if __name__ == "__main__":
    unittest.main()

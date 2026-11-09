import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from classify_offer_traits import classify_offer, build_patch


def offer(specification='', **fields):
    return {'id': 'record-test', 'plantId': 'plant-test', 'nurseryId': 'arbor',
            'priceKind': 'historical', 'specification': specification,
            'price': 450, 'currency': 'EUR', 'height': '', 'circumference': '', **fields}


class OfferTraitTests(unittest.TestCase):
    def test_standard_girth_does_not_become_height(self):
        original = offer('Acer campestre Elsrijk 25-30 STD RB', circumference='25–30')
        snapshot = copy.deepcopy(original)
        result = classify_offer(original)
        self.assertEqual(original, snapshot)
        self.assertEqual(result['seedlingType'], 'standard')
        self.assertEqual(result['seedlingTypeCode'], 'STD')
        self.assertNotIn('height', result)
        self.assertNotIn('circumference', result)
        self.assertIn('Visina sadnice nije posebno navedena', result['dataAccuracyNote'])
        self.assertIn('Navedeni obim nije korišćen kao visina', result['dataAccuracyNote'])

    def test_multistem_height_is_not_girth(self):
        result = classify_offer(offer('Magnolia soulangeana MULTISTEM 200-250 RB', height='200–250'))
        self.assertEqual(result['seedlingType'], 'multistem')
        self.assertNotIn('circumference', result)
        self.assertIn('Obim sadnice nije posebno naveden', result['dataAccuracyNote'])
        self.assertIn('Navedena visina nije korišćena kao obim', result['dataAccuracyNote'])

    def test_literal_multistem_markings(self):
        for text in ['300-350 MSTEM CG', 'Parrotia MULTI-STEM H 300-350', 'Schirm 5xv mDb mehrst. 500-600']:
            with self.subTest(text=text):
                self.assertEqual(classify_offer(offer(text))['seedlingType'], 'multistem')

    def test_explicit_standard_source_with_height(self):
        result = classify_offer(offer('Acer platanoides; 12/14; H300–350 cm; standard', height='300–350 cm'))
        self.assertEqual(result['seedlingType'], 'standard')
        self.assertNotIn('nije posebno navedena', result['dataAccuracyNote'])

    def test_hs_or_shaped_forms_are_not_guessed(self):
        for text in ['20-25HS WRB', 'Spiraea 25-30HS C3', 'Schirm 4xv mDb Sth.100-120 200-250', '250-300 FTH WRB', '20-25 SOL']:
            with self.subTest(text=text):
                result = classify_offer(offer(text))
                self.assertEqual(result['seedlingType'], '')
                self.assertIn('bez legende', result['dataAccuracyNote'])

    def test_unknown_is_not_standard_default(self):
        result = classify_offer(offer('Abies concolor 450-500 C500L'))
        self.assertEqual(result['seedlingType'], '')
        self.assertIn('nije pretpostavljen', result['dataAccuracyNote'])

    def test_conflicting_and_negated_type_markers(self):
        self.assertEqual(classify_offer(offer('STD / MULTISTEM'))['seedlingType'], '')
        self.assertEqual(classify_offer(offer('not MULTISTEM'))['seedlingType'], '')

    def test_exact_transplant_note_from_xv(self):
        result = classify_offer(offer('Parrotia Schirm 5xv mDb mehrst. 500-600'))
        self.assertIn('Broj presađivanja: 5', result['transplantNote'])
        self.assertEqual(result['traitsEvidence']['transplants']['count'], 5)
        self.assertNotIn('transplantCount', result)

    def test_lorenz_quotation_42418134_xtr_code_is_not_quantity_or_dimension(self):
        r = offer("Gleditsia triacanthos 'Spectrum'; Specimen, 5xtr, wrb, multistem, 200-300 x 400-500",
                  sourceEvidence={'sourceId': 'src-a085c5c732d3f8',
                                  'sourceSha256': '3516ee9f9f49e919f7ba84806c0ba0ff78ba66463c9d83a2111b2de58702ef47',
                                  'page': 2, 'position': 17})
        result = classify_offer(r)
        self.assertEqual(result['traitsEvidence']['transplants']['count'], 5)
        self.assertEqual(result['traitsEvidence']['transplants']['raw'], ['5xtr'])
        self.assertIn('Broj presađivanja: 5', result['transplantNote'])
        self.assertEqual(result['seedlingType'], 'multistem')
        for text in ['5 x tree', '5xtrunk', '5m', '5 kom', '400-500 x 200-300']:
            with self.subTest(text=text):
                self.assertEqual(classify_offer(offer(text))['transplantNote'], '')

    def test_roman_and_range_transplant_markings(self):
        result = classify_offer(offer('Acer; Broj presađivanja IV'))
        self.assertEqual(result['traitsEvidence']['transplants']['count'], 4)
        ambiguous = classify_offer(offer('Thuja; Broj presađivanja II/III'))
        self.assertIsNone(ambiguous['traitsEvidence']['transplants']['count'])
        self.assertEqual(ambiguous['traitsEvidence']['transplants']['range'], [2, 3])
        self.assertIn('II/III', ambiguous['transplantNote'])

    def test_quantity_age_and_dimensions_are_not_transplant_count(self):
        for text in ['3 x 4 m crown; quantity 20', 'C3 20-30', '3 years; 4 stems', '4x 20-25 STD', '3/4,50 m']:
            with self.subTest(text=text):
                result = classify_offer(offer(text))
                self.assertEqual(result['transplantNote'], '')
                self.assertIsNone(result['traitsEvidence']['transplants']['count'])

    def test_offered_row_not_requested_neighbour(self):
        r = offer('250-300 C110L', priceEvidence={'requestedPlant': {'size': 'MULTISTEM 5xv'}})
        result = classify_offer(r)
        self.assertEqual(result['seedlingType'], '')
        self.assertEqual(result['transplantNote'], '')

    def test_aggregate_cannot_inherit_one_variant_type_or_transplant_count(self):
        r = offer('Varijanta 1: 25-30 STD 3xv; Varijanta 2: 200-250 C30',
                  sourceEvidence={'multipleVariants': True,
                                  'note': 'Mere su sačuvane po izvornim varijantama.'})
        result = classify_offer(r)
        self.assertEqual(result['seedlingType'], '')
        self.assertEqual(result['traitsEvidence']['seedlingType']['rule'], 'multiple_source_variants')
        self.assertIsNone(result['traitsEvidence']['transplants']['count'])
        self.assertIn('po varijantama', result['transplantNote'])
        self.assertIn('Mere su sačuvane', result['dataAccuracyNote'])

    def test_review_and_photo_attachment_notes_survive_reclassification(self):
        r = offer('Cornus kousa Multistem 200-250 cm',
                  sourceEvidence={'extraction': 'archive_filename',
                                  'note': 'Podatak je iz naziva fotografskog priloga.'},
                  reviewNote='Aktuelna dostupnost nije potvrđena.')
        result = classify_offer(r)
        self.assertEqual(result['seedlingType'], 'multistem')
        self.assertIn('naziva fotografskog priloga', result['dataAccuracyNote'])
        self.assertIn('Aktuelna dostupnost', result['dataAccuracyNote'])

    def test_combined_requested_supplier_alternative_is_not_one_offered_type(self):
        r = offer('Requested Acer; alternative Parrotia MULTISTEM 4xv',
                  sourceEvidence={'sourceSpecifications': [{'recordRole': 'requested_with_supplier_note'}]})
        result = classify_offer(r)
        self.assertEqual(result['seedlingType'], '')
        self.assertEqual(result['transplantNote'], '')
        self.assertIsNone(result['traitsEvidence']['transplants']['count'])

    def test_source_proof_and_unmodified_financial_fields(self):
        r = offer('25-30 STD RB', priceEvidence={'sourceSha256': 'a'*64, 'sourceFile': 'offer.pdf', 'page': 1, 'row': 2})
        before = copy.deepcopy(r)
        result = classify_offer(r)
        self.assertEqual(result['traitsEvidence']['source']['sourceSha256'], 'a'*64)
        self.assertEqual(result['traitsEvidence']['source']['row'], 2)
        self.assertEqual(r, before)
        self.assertNotIn('price', result)
        self.assertNotIn('currency', result)

    def test_patch_guards_only_identity_and_excludes_online_data(self):
        r = offer('')
        online = offer('STD', id='public-row', priceKind='public')
        doc = {'schemaVersion': 1, 'offers': [r, online]}
        original = copy.deepcopy(doc)
        result = build_patch(doc)
        self.assertEqual(doc, original)
        self.assertEqual(len(result['updates']), 1)
        self.assertEqual(result['updates'][0]['expected'], {'plantId': 'plant-test', 'nurseryId': 'arbor'})
        self.assertEqual(result['summary']['publicRowsSkipped'], 1)
        with self.assertRaises(ValueError):
            classify_offer(online)


if __name__ == '__main__':
    unittest.main()

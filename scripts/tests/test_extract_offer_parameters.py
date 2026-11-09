import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from extract_offer_parameters import extract_offer_parameters, build_patch


def offer(text, **changes):
    value = {'id': 'test-row', 'plantId': 'test-plant', 'nurseryId': 'arbor',
             'specification': text, 'price': 250, 'currency': 'EUR', 'priceKind': 'historical',
             'circumference': '', 'height': '', 'crownWidth': '', 'rootBall': '', 'potSize': '', 'rootType': '',
             'sourceEvidence': {'archiveVerified': True, 'sourceSha256': 'a'*64,
                                'sourceFile': 'archive-offer.xlsx', 'sheet': 'Sheet1', 'row': 147}}
    value.update(changes)
    return value


class ExtractOfferParametersTests(unittest.TestCase):
    def test_pacific_sunset_rb_is_packaging_not_rootball_size(self):
        value = offer('Product: Acer Pacific Sunset 16-18 STD RB', circumference='16–18')
        result = extract_offer_parameters(value)
        self.assertEqual(result['set'], {'rootType': 'Busen (RB)'})
        self.assertNotIn('rootBall', result['set'])
        self.assertNotIn('height', result['set'])

    def test_exact_source_supported_multistem_height_keeps_absent_unit(self):
        r = extract_offer_parameters(offer('Product: Acer Pacific Sunset MULTISTEM 350-400 C230L'))
        self.assertEqual(r['set']['height'], '350–400')
        self.assertEqual(r['set']['potSize'], '230 L')
        self.assertIn('interpretation', r['evidence']['height'])
        self.assertEqual(r['evidence']['height']['unitStatus'], 'not_stated')
        self.assertNotIn('circumference', r['set'])

    def test_large_range_rule_is_not_a_generic_measurement_guess(self):
        for spec, nursery in [('Acer 350-400 C230L', 'arbor'),
                              ('Acer MULTISTEM 350-400 C230L', 'unknown-supplier'),
                              ('Acer 20-25 MULTISTEM 350-400 C230L', 'arbor')]:
            with self.subTest(spec=spec, nursery=nursery):
                self.assertNotIn('height', extract_offer_parameters(offer(spec, nurseryId=nursery))['set'])

    def test_explicit_parameters_are_separate_and_keep_units(self):
        r = extract_offer_parameters(offer('Quercus; Visina sadnice 300-350 cm; Obim sadnice 16/18 cm; canopy width 1.5 m; rootball Ø 900-1000 mm; RB'))
        self.assertEqual(r['set']['height'], '300–350 cm')
        self.assertEqual(r['set']['circumference'], '16–18 cm')
        self.assertEqual(r['set']['crownWidth'], '1.5 m')
        self.assertEqual(r['set']['rootBall'], '900–1000 mm')

    def test_minimum_rootball_and_O_equals_are_read_without_girth_height_exchange(self):
        r = extract_offer_parameters(offer('Tilia O=12/14cm; H300 cm; Busen min. 50 cm'))
        self.assertEqual(r['set']['circumference'], '12–14 cm')
        self.assertEqual(r['set']['height'], '300 cm')
        self.assertEqual(r['set']['rootBall'], 'min. 50 cm')

    def test_existing_raw_packaging_is_normalized_only_to_same_meaning(self):
        for code, label in [('rb', 'Busen (RB)'), ('WRB', 'Busen u žičanoj korpi (WRB)'),
                            ('BR', 'Goli koren (BR)'), ('CLT', 'Kontejner (CLT)')]:
            with self.subTest(code=code):
                r = extract_offer_parameters(offer('Plant '+code, rootType=code))
                self.assertEqual(r['set']['rootType'], label)
                self.assertEqual(r['evidence']['rootType']['operation'], 'normalize_equivalent_code')

    def test_missing_text_is_blank_but_an_existing_different_value_is_preserved(self):
        r = extract_offer_parameters(offer('H350 cm; circ. 20-25 cm; WRB', height='Nije navedeno',
                                          circumference='16–18 cm', rootType='Kontejner'))
        self.assertEqual(r['set']['height'], '350 cm')
        self.assertNotIn('circumference', r['set'])
        self.assertNotIn('rootType', r['set'])
        self.assertEqual({x['field'] for x in r['unresolved'] if x['reason']=='existing_value_conflict'},
                         {'circumference', 'rootType'})

    def test_packaging_column_header_options_are_never_actual_values(self):
        for value, expected in [('cont','Kontejner (cont)'), ('rb','Busen (RB)'), ('br','Goli koren (BR)')]:
            with self.subTest(value=value):
                r = extract_offer_parameters(offer('Acer; Height: 250-300; Circums.: 8-10; br/cont/rb: '+value))
                self.assertEqual(r['set']['rootType'], expected)
                self.assertEqual(r['set']['height'], '250–300')
                self.assertEqual(r['set']['circumference'], '8–10')

    def test_mixed_rb_and_container_does_not_select_only_one(self):
        r = extract_offer_parameters(offer('Albizia MULTISTEM 125-150 RB C65L'))
        self.assertEqual(r['set']['rootType'], 'RB / C65L (oznake u ponudi)')
        self.assertEqual(r['set']['potSize'], '65 L')
        self.assertNotIn('rootBall', r['set'])
        self.assertIn('više oznaka', r['evidence']['rootType']['note'])

    def test_litre_and_container_codes_do_not_invent_capacity_units(self):
        for text, expected in [('Plant C7.5L', '7.5 L'), ('Plant C3', 'C3'),
                               ('Plant CLT30 H125/150', 'CLT 30'), ('Plant; Type CLT; Size 3', 'CLT 3'),
                               ('Plant 3L 350mm', '3 L')]:
            with self.subTest(text=text):
                r = extract_offer_parameters(offer(text))
                self.assertEqual(r['set']['potSize'], expected)
        self.assertNotIn('height', extract_offer_parameters(offer('Plant 3L 350mm'))['set'])

    def test_container_volume_ranges_are_never_truncated_to_one_bound(self):
        for text, expected in [('Plant 25-30L', '25–30 L'), ('Plant 2–3 L', '2–3 L'),
                               ('Plant CLT70-90', 'CLT 70–90'),
                               ('Plant; Type CLT; Size 35-50', 'CLT 35–50'),
                               ('Plant C25-30L', '25–30 L')]:
            with self.subTest(text=text):
                self.assertEqual(extract_offer_parameters(offer(text))['set']['potSize'], expected)

    def test_german_width_abbreviation_br_is_not_bare_root(self):
        for token in ['br.150-200', 'br300-400', 'br 200-300']:
            with self.subTest(token=token):
                r = extract_offer_parameters(offer('Parrotia Schirm 4xv mDb '+token+' 400-500', nurseryId='lorberg'))
                self.assertEqual(r['set']['rootType'], 'Busen u žičanoj korpi (mDb)')
                self.assertIn('crownWidth', r['set'])

    def test_explicit_litres_after_clt_are_not_lost(self):
        for text, expected in [('Plant CLT10L', '10 L'), ('Plant clt 35 L', '35 L'),
                               ('Plant; Type CLT; Size 80 L', '80 L')]:
            with self.subTest(text=text):
                r = extract_offer_parameters(offer(text))
                self.assertEqual(r['set']['potSize'], expected)

    def test_uncertain_505_cm_source_note_preserves_intentional_blank(self):
        r = extract_offer_parameters(offer('Quercus; Obim 16/18 cm; Visina 350–400 cm; Izvor doslovno kaže busen min. 505 cm; sumnjiva vrednost nije preneta u rootBall niti automatski popravljena.'))
        self.assertNotIn('rootBall', r['set'])
        self.assertIn('source_flags_uncertain_value', {x['reason'] for x in r['unresolved']})

    def test_pot_alternatives_and_quantities_do_not_form_a_pot_range(self):
        r = extract_offer_parameters(offer('Hibiscus moscheutos C7 ili C10 – 50 kom'))
        self.assertEqual(r['set'], {})
        r = extract_offer_parameters(offer('Hibiscus C10 – 50 pieces'))
        self.assertNotIn('potSize', r['set'])

    def test_clt_dot_spacing_is_not_a_value_conflict(self):
        r = extract_offer_parameters(offer('Viburnum tinus Clt.18 80-100 cm', potSize='Clt.18'))
        self.assertNotIn('existing_value_conflict', {x['reason'] for x in r['unresolved']})

    def test_rootball_code_and_unexplained_supplier_codes_never_become_dimensions(self):
        for text in ['Plant 20-30 RB', 'Plant 100-120 KL']:
            with self.subTest(text=text):
                r = extract_offer_parameters(offer(text, nurseryId='volentis'))
                self.assertNotIn('rootBall', r['set'])
                self.assertNotIn('height', r['set'])
                self.assertNotIn('circumference', r['set'])
        self.assertNotIn('rootType', extract_offer_parameters(offer('Plant KL'))['set'])

    def test_aggregates_review_rows_and_unverified_rows_are_skipped(self):
        for changes in [
            {'sourceEvidence': {'archiveVerified': True, 'multipleVariants': True}},
            {'sourceEvidence': {'archiveVerified': True, 'sourceSpecifications': [{'recordRole': 'requested_with_supplier_note'}]}},
            {'recordStatus': 'needs_review'}, {'recordStatus': 'superseded'},
            {'sourceEvidence': {'archiveVerified': False}}, {'priceKind': 'public'},
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(extract_offer_parameters(offer('H300 cm RB C50L', **changes))['set'], {})

    def test_requested_measures_are_not_applied_to_changed_supplier_size(self):
        r = extract_offer_parameters(offer('Eleagnus 25/30, height 400 cm; rootball Ø 900 mm; NAPOMENA: 20-25 rb',
              priceEvidence={'requestedDescription': 'Eleagnus 25/30, height 400 cm; rootball Ø 900 mm', 'supplierNotes': '20-25 rb'}))
        self.assertEqual(r['set'], {})

    def test_trunk_mature_and_shaped_panel_height_are_not_total_height(self):
        for text in ['trunk height 200 cm', 'mature height 3 m', 'Carpinus PLEACHED STEM220 H160XL160 WOODBOX']:
            with self.subTest(text=text):
                self.assertNotIn('height', extract_offer_parameters(offer(text))['set'])

    def test_broj_transplant_abbreviation_is_not_bare_root(self):
        self.assertNotIn('rootType', extract_offer_parameters(offer('Acer; br. presađivanja III'))['set'])

    def test_two_explicit_heights_are_unresolved_not_arbitrarily_selected(self):
        r = extract_offer_parameters(offer('height 200 cm; height 300 cm'))
        self.assertNotIn('height', r['set'])
        self.assertEqual(r['unresolved'][0]['reason'], 'multiple_parameter_values')

    def test_financial_photographic_and_type_fields_are_untouched_and_function_is_pure(self):
        original = offer('Plant H200 cm RB', image='original.jpg', seedlingType='multistem')
        before = copy.deepcopy(original)
        r = extract_offer_parameters(original)
        self.assertEqual(original, before)
        self.assertFalse({'price','currency','image','seedlingType','priceKind'} & r['set'].keys())

    def test_mauritz_norwegian_sunset_14_16_ho_goes_to_girth(self):
        r = extract_offer_parameters(offer('Acer Norwegian Sunset; Izvorna oznaka: 14-16 Ho 3xv', nurseryId='combinatie-mauritz'))
        self.assertEqual(r['set']['circumference'], '14–16')
        self.assertNotIn('height', r['set'])
        self.assertIn('interpretationSource', r['evidence']['circumference'])

    def test_scoped_dutch_form_and_package_codes(self):
        for nursery, text, field, value, root in [
            ('volentis', '25-30HS WRB', 'circumference', '25–30', 'Busen u žičanoj korpi (WRB)'),
            ('volentis', 'Carpinus 200-250 MS DRKL', 'height', '200–250', 'Busen u žičanoj korpi (DRKL)'),
            ('volentis', '300-350 MSTEM CG', 'height', '300–350', 'Kontejner (CG)'),
            ('combinatie-mauritz', 'Alnus; Izvorna oznaka: Multistem 450-500', 'height', '450–500', None),
        ]:
            with self.subTest(text=text):
                r = extract_offer_parameters(offer(text, nurseryId=nursery))
                self.assertEqual(r['set'][field], value)
                if root: self.assertEqual(r['set']['rootType'], root)
        self.assertNotIn('circumference', extract_offer_parameters(offer('25-30HS WRB', nurseryId='unknown'))['set'])

    def test_source_codes_do_not_invent_units_or_numeric_measures(self):
        for text, root in [('Acer WOODBOX', 'Drvena kutija (WOODBOX)'), ('Acer AIRPOT', 'Air-Pot kontejner (AIRPOT)')]:
            r = extract_offer_parameters(offer(text))
            self.assertEqual(r['set'], {'rootType': root})
        r = extract_offer_parameters(offer('Plant; Size CS9', nurseryId='combinatie-mauritz'))
        self.assertEqual(r['set']['potSize'], 'CS9')
        self.assertEqual(r['set']['rootType'], 'Kontejner')
        self.assertNotIn('height', r['set'])

    def test_lorberg_standard_and_wire_rootball_codes(self):
        r = extract_offer_parameters(offer('Acer Cleveland; H 3xv mDb 25-30', nurseryId='lorberg', rootType='mDb (oznaka izvora)'))
        self.assertEqual(r['set']['circumference'], '25–30')
        self.assertEqual(r['set']['rootType'], 'Busen u žičanoj korpi (mDb)')
        self.assertNotIn('height', r['set'])
        self.assertNotIn('rootBall', r['set'])

    def test_clear_stem_and_topiary_dimensions_are_preserved_outside_total_height(self):
        r = extract_offer_parameters(offer('Carpinus PLEACHED 40-45 STD STEM220 H420L250 WOODBOX'))
        self.assertEqual(r['set']['circumference'], '40–45')
        self.assertNotIn('height', r['set'])
        extras = {x['label']: x['value'] for x in r['additionalParameters']}
        self.assertEqual(extras['Visina čistog debla'], '220')
        self.assertEqual(extras['Dimenzije oblikovane krošnje'], 'H420L250')

    def test_unclassified_range_remains_explicit_in_main_panel_payload(self):
        r = extract_offer_parameters(offer('Plant; DIMENZIJE: 150-200x300-350', nurseryId='lorberg'))
        self.assertNotIn('height', r['set'])
        self.assertNotIn('crownWidth', r['set'])
        self.assertTrue(any(x['reason']=='unclassified_source_measure' for x in r['unresolved']))
        self.assertTrue(any('150-200x300-350' in x['value'] for x in r['additionalParameters']))

    def test_str_is_a_shrub_form_not_multistem_or_standard(self):
        r = extract_offer_parameters(offer('Plant STR 60-80', nurseryId='combinatie-mauritz'))
        self.assertTrue(any(x['label']=='Forma sadnice' and 'Žbunasta' in x['value'] for x in r['additionalParameters']))

    def test_gum_ball_cultivar_is_not_a_ball_form(self):
        r = extract_offer_parameters(offer('Liquidambar styraciflua Gum Ball 16-18 STD C50L'))
        self.assertFalse(any('Kuglasta' in x['value'] for x in r['additionalParameters']))

    def test_arbor_multistem_height_does_not_require_large_number(self):
        r = extract_offer_parameters(offer('Acer MULTISTEM 80-100 C30L'))
        self.assertEqual(r['set']['height'], '80–100')

    def test_half_standard_fraction_is_a_form_not_one_to_two_girth(self):
        r = extract_offer_parameters(offer('Betula Youngii 1/2 STD C25L'))
        self.assertNotIn('circumference', r['set'])
        self.assertTrue(any('Polustandard' in x['value'] for x in r['additionalParameters']))
        r = extract_offer_parameters(offer('Betula Youngii 14-16 1/2 STD C25L'))
        self.assertEqual(r['set']['circumference'],'14–16')

    def test_explicit_royal_garden_h_and_w_are_distinct(self):
        r = extract_offer_parameters(offer('Pinus mugo in container; h 40-50 cm; w 40-50 cm',nurseryId='royal-garden'))
        self.assertEqual(r['set']['height'],'40–50 cm')
        self.assertEqual(r['set']['crownWidth'],'40–50 cm')

    def test_italian_AF_range_is_girth_and_not_the_container_range(self):
        r = extract_offer_parameters(offer('JUGLANS REGIA CLT 70-90 16-18 A.F.',nurseryId='innocenti-mangoni'))
        self.assertEqual(r['set']['circumference'],'16–18')
        self.assertEqual(r['set']['potSize'],'CLT 70–90')
        self.assertNotIn('height',r['set'])

    def test_unclassified_single_measure_and_plus_are_visible_without_guessing(self):
        for text, value in [('Euphorbia palustris 18 cm','18 cm'),('Plant 400+','400+'),('Plant 150-175+','150-175+')]:
            r = extract_offer_parameters(offer(text,nurseryId='royal-garden'))
            self.assertTrue(any(x['label']=='Dimenzija iz ponude' and value in x['value'] for x in r['additionalParameters']))
            self.assertNotIn('height',r['set'])
            self.assertNotIn('potSize',r['set'])

    def test_glued_arbor_stem_and_container_markings_stay_separate(self):
        r = extract_offer_parameters(offer('Product: Liquidambar styraciflua ROOF20-25 STEM220C130L'))
        self.assertEqual(r['set']['potSize'],'130 L')
        self.assertEqual(r['set']['rootType'],'Kontejner')
        self.assertNotIn('height',r['set'])
        self.assertNotIn('circumference',r['set'])
        self.assertTrue(any(x['label']=='Visina čistog debla' and x['value']=='220' for x in r['additionalParameters']))

    def test_patch_guards_every_field_it_will_change(self):
        r = build_patch({'offers':[offer('Plant RB')]})['updates'][0]
        self.assertEqual(r['expected']['rootType'], '')
        self.assertEqual(r['expected']['plantId'], 'test-plant')
        self.assertEqual(r['set']['rootType'], 'Busen (RB)')


if __name__ == '__main__':
    unittest.main()

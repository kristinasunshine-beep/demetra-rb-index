import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lve_photo_catalog import same_product_variant, matches_lve_name
from update_photos import Document


class LveVariantEvidenceTests(unittest.TestCase):
    name = "Fagus sylvatica 'Riversii'"
    page = 'https://www.lve-baumschule.de/fagus-sylvatica-riversii/6353661'
    sku = 'bks33180123'
    uuid = '4f9ee4021e1138697265456a79c2caa4'

    def setUp(self):
        self.variant = 'https://www.lve-baumschule.de/fagus-sylvatica-riversii/' + self.sku
        self.internal = 'https://www.lve-baumschule.de/detail/' + self.uuid
        self.product = {'@type': 'Product', 'name': self.name, 'sku': self.sku,
                        'offers': [{'@type': 'AggregateOffer', 'offers': [
                            {'@type': 'Offer', 'url': self.internal}]}]}

    def doc(self, *, canonical=None, name=None, uuid=None, hidden=True, footer=False):
        token = self.uuid if uuid is None else uuid
        form = (f'<input type="hidden" name="lineItems[{token}][id]" value="{token}">'
                if hidden else '')
        if footer:
            form = '<footer>' + form + '</footer>'
        return Document(f'<link rel="canonical" href="{canonical or self.page}">'
                        f'<h1>{name or self.name}</h1>{form}')

    def check(self, url, doc=None, product=None):
        return same_product_variant(doc or self.doc(), [product or self.product], self.page, url, self.name)

    def test_exact_sku_variant_accepted(self):
        self.assertTrue(self.check(self.variant))

    def test_internal_variant_needs_product_offer_and_current_form(self):
        self.assertTrue(self.check(self.internal))

    def test_wrong_sku_rejected(self):
        self.assertFalse(self.check(self.variant + '9'))

    def test_wrong_cultivar_heading_rejected(self):
        self.assertFalse(self.check(self.variant, self.doc(name="Fagus sylvatica 'Dawyck'")))

    def test_wrong_product_name_rejected(self):
        product = dict(self.product, name="Fagus sylvatica 'Dawyck'")
        self.assertFalse(self.check(self.variant, product=product))

    def test_wrong_host_and_non_https_rejected(self):
        self.assertFalse(self.check(self.variant.replace('www.lve-baumschule.de', 'example.org')))
        self.assertFalse(self.check(self.variant.replace('https:', 'http:')))

    def test_wrong_canonical_rejected(self):
        self.assertFalse(self.check(self.variant, self.doc(canonical=self.page + '7')))

    def test_different_slug_rejected_even_same_sku(self):
        self.assertFalse(self.check(self.variant.replace('riversii', 'dawyck')))

    def test_wrong_or_absent_hidden_uuid_rejected(self):
        self.assertFalse(self.check(self.internal, self.doc(uuid='f' * 32)))
        self.assertFalse(self.check(self.internal, self.doc(hidden=False)))

    def test_footer_form_does_not_prove_current_product(self):
        self.assertFalse(self.check(self.internal, self.doc(footer=True)))

    def test_unrelated_offer_url_rejected(self):
        product = copy.deepcopy(self.product)
        product['offers'][0]['offers'][0]['url'] = self.internal[:-1] + 'f'
        self.assertFalse(self.check(self.internal, product=product))

    def test_unmarked_r_not_silently_normalized(self):
        self.assertFalse(self.check(self.variant, self.doc(name=self.name + ' R')))

    def test_query_fragment_and_bad_internal_identifier_rejected(self):
        for suffix in ('?other=1', '#other'):
            self.assertFalse(self.check(self.variant + suffix))
        self.assertFalse(self.check(self.internal[:-1]))

    def test_lve_explicit_terminal_trademark_marker_only(self):
        name = "Hydrangea paniculata 'Little Lime'"
        self.assertTrue(matches_lve_name(name + '  -R-', name))
        self.assertTrue(matches_lve_name(name + '  -R- | Baumschule LvE', name, title=True))
        self.assertFalse(matches_lve_name(name + ' R', name))
        self.assertFalse(matches_lve_name(name + '-R-', name))
        self.assertFalse(matches_lve_name("Hydrangea paniculata 'Little Lime Punch' -R-", name))
        self.assertFalse(matches_lve_name("Hydrangea paniculata 'Little -R- Lime'", name))

    def test_registered_variant_slug_needs_actual_marker_and_exact_sku(self):
        name = "Hydrangea paniculata 'Little Lime'"
        page = 'https://www.lve-baumschule.de/hydrangea-paniculata-little-lime/6996342'
        variant = 'https://www.lve-baumschule.de/hydrangea-paniculata-little-lime-r/SANA074772'
        doc = Document(f'<link rel="canonical" href="{page}"><h1>{name} -R-</h1>')
        product = {'@type': 'Product', 'name': name + ' -R-', 'sku': 'SANA074772'}
        self.assertTrue(same_product_variant(doc, [product], page, variant, name))
        self.assertFalse(same_product_variant(doc, [dict(product, name=name)], page, variant, name))
        self.assertFalse(same_product_variant(doc, [dict(product, sku='SANA074773')], page, variant, name))
        self.assertFalse(same_product_variant(doc, [dict(product, name=name + ' Punch -R-')], page, variant, name))


if __name__ == '__main__':
    unittest.main()

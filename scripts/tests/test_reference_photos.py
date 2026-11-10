"""Reference-photo identity, attribution, resumption and data-integrity tests."""
from __future__ import annotations

import copy
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import reference_photos as ref
from update_photos import FetchResult, PhotoError

NOW = '2026-11-09T15:00:00Z'
IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Plant.jpg'
SOURCE = 'https://commons.wikimedia.org/wiki/File:Plant.jpg'


def bitmap():
    output = BytesIO()
    Image.new('RGB', (1600, 1200), (40, 90, 55)).save(output, format='PNG')
    return output.getvalue()


def page(**overrides):
    info = {'url': IMAGE, 'thumburl': IMAGE, 'descriptionurl': SOURCE,
            'mime': 'image/jpeg', 'mediatype': 'BITMAP', 'width': 1600, 'height': 1200,
            'extmetadata': {'Artist': {'value': '<a href="/wiki/User:Photographer">Photo Author</a>'},
                            'LicenseShortName': {'value': 'CC BY-SA 4.0'},
                            'LicenseUrl': {'value': 'https://creativecommons.org/licenses/by-sa/4.0/'},
                            'ImageDescription': {'value': 'Living tree, photographed outdoors.'}}}
    info.update(overrides)
    return {'pageid': 12, 'ns': 6, 'title': 'File:Plant.jpg', 'imageinfo': [info]}


class Sources:
    def __init__(self, names=('Abies concolor',), **options):
        self.names = names
        self.options = options
        self.calls = []

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs['kind']))
        if self.options.get('fail'):
            raise self.options['fail']
        if kwargs['kind'] == 'image':
            return FetchResult(bitmap(), url, 'image/png')
        q = {key: value[0] for key, value in parse_qs(urlsplit(url).query).items()}
        if q.get('action') == 'wbsearchentities':
            taxon = q['search']
            value = {'search': [{'id': 'Q' + str(self.names.index(taxon) + 1), 'label': taxon}]
                     if taxon in self.names and not self.options.get('no_entity') else []}
        elif q.get('action') == 'wbgetentities':
            value = {'entities': {qid: {'id': qid, 'claims': {
                'P225': [{'mainsnak': {'snaktype': 'value', 'datavalue': {'value': self.options.get('wrong_taxon') or self.names[int(qid[1:]) - 1]}}}],
                'P18': [{'mainsnak': {'snaktype': 'value', 'datavalue': {'value': 'Plant.jpg'}}}]}}
                for qid in q['ids'].split('|')}}
        elif q.get('prop') == 'categoryinfo':
            if self.options.get('category') and q['titles'] == 'Category:' + self.options['category']:
                value = {'query': {'pages': [{'ns': 14, 'title': q['titles'], 'categoryinfo': {'files': 1}}]}}
            else:
                value = {'query': {'pages': [{'ns': 14, 'title': q['titles'], 'missing': True}]}}
        elif q.get('prop') == 'imageinfo':
            value = {'query': {'pages': [self.options.get('page') or page()]}}
        else:
            raise AssertionError(q)
        return FetchResult(json.dumps(value).encode(), url, 'application/json')


class ReferencePhotoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'docs').mkdir()
        (self.root / 'assets/biljke').mkdir(parents=True)
        self.plants = {'schemaVersion': 1, 'updatedAt': '2026-10-01', 'plants': [
            {'id': 'abies', 'latinName': 'Abies concolor', 'commonName': 'Jela', 'searchAliases': []}]}
        self.offers = {'schemaVersion': 1, 'sourcePolicy': {'nonPhoto': 'rasadnici-ponude-zip', 'onlineUpdates': ['photos']},
                       'offers': [{'id': 'o1', 'plantId': 'abies', 'nurseryId': 'arbor',
                                   'price': 250, 'height': '250–300', 'image': ''}]}
        self.write()

    def write(self):
        (self.root / 'data/biljke.json').write_text(json.dumps(self.plants))
        (self.root / 'data/kataloske-stavke.json').write_text(json.dumps(self.offers))

    def loaded(self):
        return json.loads((self.root / 'data/biljke.json').read_text())

    def run_update(self, fetcher=None, **kwargs):
        return ref.run_reference_update(self.root, fetcher=fetcher or Sources(), now=NOW, **kwargs)

    def test_exact_taxon_has_attribution_and_preserves_every_nonphoto_value(self):
        before_offers = (self.root / 'data/kataloske-stavke.json').read_bytes()
        result = self.run_update()
        photo = self.loaded()['plants'][0]['photo']
        self.assertEqual(photo['matchLevel'], 'exact')
        self.assertEqual(photo['taxon'], 'Abies concolor')
        self.assertEqual(photo['author'], 'Photo Author')
        self.assertEqual(photo['sourceUrl'], SOURCE)
        self.assertEqual(photo['origin'], 'wikimedia')
        self.assertEqual(photo['identityEvidence']['method'], 'wikidata_P225_P18')
        self.assertEqual(result['added'], 1)
        self.assertEqual(result['requests'], 4)
        after = self.loaded(); del after['plants'][0]['photo']
        self.assertEqual(after, self.plants)
        self.assertEqual((self.root / 'data/kataloske-stavke.json').read_bytes(), before_offers)
        with Image.open(self.root / photo['image']) as image:
            self.assertEqual(image.format, 'JPEG')
            self.assertLessEqual(max(image.size), 1200)

    def test_cultivar_can_only_fall_back_to_its_explicit_species(self):
        self.plants['plants'][0]['latinName'] = "Abies concolor 'Glauca'"
        self.write()
        result = self.run_update()
        photo = self.loaded()['plants'][0]['photo']
        self.assertEqual(photo['matchLevel'], 'species_reference')
        self.assertEqual(photo['taxon'], 'Abies concolor')
        self.assertEqual(result['added'], 1)

    def test_genus_only_cultivar_does_not_guess_parent_species(self):
        self.plants['plants'][0]['latinName'] = "Acer 'Norwegian Sunset'"
        self.write(); fetcher = Sources()
        result = self.run_update(fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(result['sources'][0]['reason'], 'taxon_not_specific')
        self.assertNotIn('photo', self.loaded()['plants'][0])

    def test_taxon_rank_names_and_hybrids_are_distinguished(self):
        self.assertEqual(ref.targets('Abies sp.'), [])
        self.assertEqual(ref.targets('Acer'), [])
        self.assertEqual(ref.targets("Acer × freemanii 'Autumn Blaze'")[-1], ('Acer × freemanii', 'species_reference'))
        self.assertEqual(ref.targets('Abies concolor var. concolor')[-1], ('Abies concolor', 'species_reference'))

    def test_a_search_label_is_not_taxonomic_identity_evidence(self):
        result = self.run_update(Sources(wrong_taxon='Abies alba'))
        self.assertEqual(result['added'], 0)
        self.assertEqual(result['sources'][0]['reason'], 'no_verified_reference')
        self.assertNotIn('photo', self.loaded()['plants'][0])

    def test_exact_commons_category_is_accepted_without_recursive_or_fuzzy_search(self):
        result = self.run_update(Sources(no_entity=True, category='Abies concolor'))
        photo = self.loaded()['plants'][0]['photo']
        self.assertEqual(photo['identityEvidence']['method'], 'exact_commons_taxon_category')
        self.assertEqual(photo['identityEvidence']['category'], 'Category:Abies concolor')
        self.assertEqual(result['added'], 1)

    def test_license_and_author_are_required_for_every_file(self):
        for field, value in [('LicenseShortName', 'CC BY-NC 4.0'), ('LicenseShortName', 'All rights reserved'),
                             ('Artist', ''), ('LicenseUrl', 'https://untrusted.example/license')]:
            with self.subTest(field=field):
                fake = page()
                fake['imageinfo'][0]['extmetadata'][field] = {'value': value}
                result = self.run_update(Sources(page=fake), dry_run=True)
                self.assertEqual(result['added'], 0)

    def test_public_domain_uses_its_actual_source_declaration(self):
        metadata = {'Artist': {'value': 'U.S. Government photographer'},
                    'LicenseShortName': {'value': 'Public domain'}}
        name, author, url = ref.permitted_license(metadata, SOURCE)
        self.assertEqual(name, 'Public domain')
        self.assertEqual(url, SOURCE + '#Licensing')

    def test_foreign_redirects_and_images_are_not_fetched(self):
        fake = page(thumburl='https://example.org/photo.jpg')
        source = Sources(page=fake)
        result = self.run_update(source)
        self.assertEqual(result['added'], 0)
        self.assertFalse(any(kind == 'image' for _, kind in source.calls))

    def test_maps_drawings_and_undersized_files_do_not_fill_slots(self):
        for fake in [page(mime='image/svg+xml'), page(width=16),
                     {**page(), 'title': 'File:Abies concolor distribution map.jpg'}]:
            with self.subTest(fake=fake['title']):
                self.assertEqual(self.run_update(Sources(page=fake), dry_run=True)['added'], 0)

    def test_budget_stops_requests_and_cached_work_resumes(self):
        source = Sources()
        first = self.run_update(source, budget=2)
        self.assertEqual(first['requests'], 2)
        self.assertEqual(first['status'], 'partial')
        self.assertNotIn('photo', self.loaded()['plants'][0])
        second = self.run_update(source, budget=2)
        self.assertEqual(second['requests'], 2)
        self.assertEqual(second['added'], 1)
        self.assertEqual(len(source.calls), 4)

    def test_pending_first_taxon_does_not_starve_next_taxon(self):
        self.plants['plants'].insert(0, {'id': 'missing', 'latinName': 'Absentia ficta'})
        self.write(); source = Sources()
        first = self.run_update(source, budget=2)
        self.assertEqual(first['pending'], 1)
        second = self.run_update(source, budget=4)
        self.assertEqual(second['added'], 1)
        self.assertEqual(self.loaded()['plants'][1]['photo']['taxon'], 'Abies concolor')

    def test_failure_preserves_previous_photo_and_stops_provider_retry_storm(self):
        self.run_update()
        before = (self.root / 'data/biljke.json').read_bytes()
        source = Sources(fail=PhotoError('http_error', 'Source returned HTTP 429.'))
        result = ref.run_reference_update(self.root, fetcher=source, now='2026-12-10T15:00:00Z')
        self.assertEqual(result['requests'], 1)
        self.assertTrue(result['providerPaused'])
        self.assertEqual((self.root / 'data/biljke.json').read_bytes(), before)

    def test_unchanged_current_photo_and_pending_state_skip_work(self):
        self.run_update()
        before = (self.root / 'data/biljke.json').read_bytes()
        source = Sources()
        result = self.run_update(source)
        self.assertEqual(result['requests'], 0)
        self.assertEqual(source.calls, [])
        self.assertEqual((self.root / 'data/biljke.json').read_bytes(), before)

    def test_dry_run_has_no_data_asset_or_state_side_effects(self):
        before = (self.root / 'data/biljke.json').read_bytes()
        result = self.run_update(dry_run=True)
        self.assertEqual(result['added'], 1)
        self.assertEqual((self.root / 'data/biljke.json').read_bytes(), before)
        self.assertFalse((self.root / ref.STATE_PATH).exists())
        self.assertEqual(list((self.root / 'assets/biljke').iterdir()), [])

    def test_source_policy_cannot_be_relaxed_by_photo_worker(self):
        self.offers['sourcePolicy']['onlineUpdates'].append('prices'); self.write()
        with self.assertRaises(PhotoError):
            self.run_update()

    def test_shared_reference_asset_is_reused_without_changing_identity_level(self):
        self.plants['plants'].append({'id': 'glauca', 'latinName': "Abies concolor 'Glauca'"})
        self.write(); source = Sources()
        result = self.run_update(source)
        photos = [p['photo'] for p in self.loaded()['plants']]
        self.assertEqual(photos[0]['image'], photos[1]['image'])
        self.assertEqual([p['matchLevel'] for p in photos], ['exact', 'species_reference'])
        self.assertEqual(sum(kind == 'image' for _, kind in source.calls), 1)


if __name__ == '__main__':
    unittest.main()

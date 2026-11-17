"""Content-based display identities preserve originals and reject unsafe paths."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_photo_identities import build_photo_identities, write_photo_identities


class PhotoIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plants = []
        self.offers = []

    def image(self, name, content):
        relative = 'assets/biljke/' + name
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return relative

    def save_catalogue(self):
        (self.root / 'data').mkdir(exist_ok=True)
        for filename, key, values in [('biljke.json', 'plants', self.plants),
                                       ('kataloske-stavke.json', 'offers', self.offers)]:
            (self.root / 'data' / filename).write_text(json.dumps({key: values}), encoding='utf-8')

    def build(self):
        self.save_catalogue()
        return build_photo_identities(self.root)

    def test_exact_bytes_under_different_names_share_identity_without_mutating_inputs(self):
        body = b'complete original image bytes\0\xff'
        reference = self.image('reference-arbitrary.jpg', body)
        offer = self.image('photo-another-name.png', body)
        unique = self.image('different.jpg', body + b'different')
        self.image('unreferenced.jpg', body)
        self.plants = [{'id': 'p1', 'photo': {'image': reference}}]
        self.offers = [{'plantId': 'p1', 'image': offer}, {'plantId': 'p1', 'image': unique}]
        self.save_catalogue()
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = write_photo_identities(self.root)
        expected = hashlib.sha256(body).hexdigest()
        self.assertEqual(result, {'schemaVersion': 1, 'identities': {offer: expected, reference: expected}})
        for filename, data in before.items():
            self.assertEqual(Path(filename).read_bytes(), data)
        self.assertEqual(set(self.root.rglob('*.json')),
                         {self.root/'data/biljke.json', self.root/'data/kataloske-stavke.json',
                          self.root/'assets/photo-identities.json'})

    def test_repeated_single_url_and_similar_names_do_not_prove_equal_content(self):
        first = self.image('reference-abc123.jpg', b'first image')
        second = self.image('photo-abc123.jpg', b'second image')
        self.plants = [{'photo': {'image': first}}]
        self.offers = [{'image': first}, {'image': first}, {'image': second}]
        self.assertEqual(self.build()['identities'], {})

    def test_output_is_stable_after_catalogue_reorder_and_repeat_generation(self):
        paths = [self.image(name, b'same') for name in ('z.jpg', 'a.jpg', 'm.jpg')]
        self.plants = [{'photo': {'image': paths[0]}}]
        self.offers = [{'image': value} for value in paths[1:]]
        self.save_catalogue()
        write_photo_identities(self.root)
        first = (self.root/'assets/photo-identities.json').read_bytes()
        self.offers.reverse()
        self.save_catalogue()
        write_photo_identities(self.root)
        self.assertEqual(first, (self.root/'assets/photo-identities.json').read_bytes())
        self.assertEqual(list(json.loads(first)['identities']), sorted(paths))
        self.assertNotIn(str(self.root), first.decode())

    def test_remote_empty_and_data_urls_are_not_downloaded_or_published(self):
        self.plants = [{'photo': {'image': 'https://nursery.example/photo.jpg'}}, {'photo': None}]
        self.offers = [{'image': ''}, {'image': None}, {'image': 'data:image/png;base64,AAAA'}]
        self.assertEqual(self.build(), {'schemaVersion': 1, 'identities': {}})

    def test_path_traversal_absolute_and_outside_asset_paths_fail(self):
        for invalid in ('assets/biljke/../outside.jpg', 'assets/biljke/%2e%2e/outside.jpg',
                        'assets/biljke\\outside.jpg', '/tmp/photo.jpg', 'C:/private/photo.jpg',
                        'data/private.jpg', 'assets/biljke/photo.jpg?x=1', 42):
            with self.subTest(path=invalid):
                self.offers = [{'image': invalid}]
                self.save_catalogue()
                with self.assertRaises(ValueError):
                    build_photo_identities(self.root)

    def test_missing_referenced_file_fails_without_replacing_previous_manifest(self):
        (self.root/'assets').mkdir()
        output = self.root/'assets/photo-identities.json'
        output.write_text('previous manifest', encoding='utf-8')
        self.offers = [{'image': 'assets/biljke/missing.jpg'}]
        self.save_catalogue()
        with self.assertRaises(FileNotFoundError):
            write_photo_identities(self.root)
        self.assertEqual(output.read_text(encoding='utf-8'), 'previous manifest')

    def test_symlink_cannot_read_outside_photo_folder(self):
        outside = self.root/'private.jpg'
        outside.write_bytes(b'private')
        link = self.root/'assets/biljke/escape.jpg'
        link.parent.mkdir(parents=True)
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f'Symlink creation is unavailable: {error}')
        self.offers = [{'image': 'assets/biljke/escape.jpg'}]
        self.save_catalogue()
        with self.assertRaises(ValueError):
            build_photo_identities(self.root)


if __name__ == '__main__':
    unittest.main()

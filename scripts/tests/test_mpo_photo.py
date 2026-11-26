from io import BytesIO
from pathlib import Path
import sys
import unittest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_photos import to_jpeg, DEFAULT_LIMITS, PhotoError


class MpoPhotoTests(unittest.TestCase):
    def test_supplier_multi_picture_jpeg_uses_first_photo(self):
        first = Image.new('RGB', (160, 180), (20, 100, 50))
        second = Image.new('RGB', (160, 180), (220, 10, 10))
        stream = BytesIO()
        first.save(stream, format='MPO', save_all=True, append_images=[second])
        with Image.open(BytesIO(stream.getvalue())) as source:
            self.assertEqual(source.format, 'MPO')
            self.assertEqual(source.n_frames, 2)
        with Image.open(BytesIO(to_jpeg(stream.getvalue(), DEFAULT_LIMITS))) as saved:
            self.assertEqual(saved.format, 'JPEG')
            self.assertEqual(saved.size, (160, 180))
            self.assertLess(sum(abs(a-b) for a,b in zip(saved.getpixel((80, 90)), (20, 100, 50))), 8)
        with self.assertRaises(PhotoError) as error:
            to_jpeg(stream.getvalue(), {**DEFAULT_LIMITS, 'maxPixels': 100})
        self.assertEqual(error.exception.code, 'image_too_large')


if __name__ == '__main__':
    unittest.main()

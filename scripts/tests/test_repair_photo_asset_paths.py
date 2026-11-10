import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "repair_photo_asset_paths.py"
SPEC = importlib.util.spec_from_file_location("repair_photo_asset_paths", MODULE_PATH)
repair_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair_module)


class RepairPhotoPathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "assets" / "biljke"
        self.nested = self.target / "biljke"
        self.nested.mkdir(parents=True)
        (self.root / "scripts").mkdir()
        self.images = {"reference-aaa.jpg": b"verified image A", "reference-bbb.jpg": b"verified image B"}
        for name, data in self.images.items():
            (self.nested / name).write_bytes(data)
        policy = {"verifiedAgainstCommit": "a" * 40,
                  "files": {name: hashlib.sha256(data).hexdigest() for name, data in self.images.items()}}
        (self.root / repair_module.POLICY).write_text(json.dumps(policy), encoding="utf-8")

    def test_moves_verified_images_once(self):
        result = repair_module.repair(self.root)
        self.assertEqual(result, {"changed": True, "moved": 2, "removedIdenticalCopies": 0, "restoredFromHistory": 0})
        self.assertFalse(self.nested.exists())
        for name, data in self.images.items():
            self.assertEqual((self.target / name).read_bytes(), data)
        self.assertFalse(repair_module.repair(self.root)["changed"])

    def test_modified_source_stops_before_any_move(self):
        (self.nested / "reference-bbb.jpg").write_bytes(b"unexpected image")
        with self.assertRaisesRegex(ValueError, "differs from verified"):
            repair_module.repair(self.root)
        self.assertTrue((self.nested / "reference-aaa.jpg").exists())
        self.assertFalse((self.target / "reference-aaa.jpg").exists())

    def test_different_destination_is_preserved(self):
        (self.target / "reference-bbb.jpg").write_bytes(b"existing different image")
        with self.assertRaisesRegex(ValueError, "different image"):
            repair_module.repair(self.root)
        self.assertEqual((self.target / "reference-bbb.jpg").read_bytes(), b"existing different image")
        self.assertTrue((self.nested / "reference-aaa.jpg").exists())

    def test_only_identical_duplicate_is_removed(self):
        (self.target / "reference-aaa.jpg").write_bytes(self.images["reference-aaa.jpg"])
        result = repair_module.repair(self.root)
        self.assertEqual(result, {"changed": True, "moved": 1, "removedIdenticalCopies": 1, "restoredFromHistory": 0})
        self.assertEqual((self.target / "reference-aaa.jpg").read_bytes(), self.images["reference-aaa.jpg"])

    def test_deleted_folder_is_recovered_from_verified_history(self):
        for path in self.nested.iterdir():
            path.unlink()
        self.nested.rmdir()
        seen = []

        def load(commit, names):
            seen.append((commit, names))
            return dict(self.images)

        result = repair_module.repair(self.root, history_loader=load)
        self.assertEqual(result["restoredFromHistory"], 2)
        self.assertTrue(result["changed"])
        self.assertEqual(seen, [("a" * 40, sorted(self.images))])
        for name, data in self.images.items():
            self.assertEqual((self.target / name).read_bytes(), data)

    def test_wrong_historical_bytes_leave_all_paths_unchanged(self):
        (self.nested / "reference-bbb.jpg").unlink()
        with self.assertRaisesRegex(ValueError, "Historical image differs"):
            repair_module.repair(self.root, history_loader=lambda commit, names: {names[0]: b"wrong image"})
        self.assertTrue((self.nested / "reference-aaa.jpg").exists())
        self.assertFalse((self.target / "reference-aaa.jpg").exists())
        self.assertFalse((self.target / "reference-bbb.jpg").exists())


if __name__ == "__main__":
    unittest.main()

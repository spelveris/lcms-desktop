import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


class PersonalFolderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def match(self, name):
        return server._match_personal_initials_folder(self.root, name)

    def test_plain_initials_use_the_two_account_names(self):
        folder = self.root / "PP"
        folder.mkdir()
        (self.root / "20261026").mkdir()
        (self.root / "PPe").touch()
        self.assertEqual(self.match("Petras Petraitis"), folder)
        self.assertEqual(self.match("Pétrās Petraitis"), folder)
        for name in ("", "ppetraitis", "P P", "Petras Jonas Petraitis", "Other Person"):
            with self.subTest(name=name):
                self.assertIsNone(self.match(name))

    def test_collision_requires_one_explicit_surname_prefix(self):
        (self.root / "JH").mkdir()
        folder = self.root / "JHu"
        folder.mkdir()
        self.assertEqual(self.match("Jonas Hunt"), folder)
        self.assertIsNone(self.match("Jonas Hall"))
        self.assertIsNone(self.match("JH"))
        (self.root / "JHú").mkdir()
        self.assertIsNone(self.match("Jonas Hunt"))

    def test_volume_list_returns_shortcut_only_while_match_is_available(self):
        preferred = "/Volumes/chab_loc_lang_s1/Group/LC-MS Agilent data"
        folder = self.root / "DS"
        folder.mkdir()
        paths = {preferred: self.root, "/Volumes": self.root / "unmounted"}
        with patch("platform.system", return_value="Darwin"), \
                patch.object(server, "Path", side_effect=paths.__getitem__), \
                patch.object(server, "_macos_account_full_name", return_value="Dominykas Spelveris"):
            data = server.list_volumes()
            self.assertEqual(data["personal_folder"], {"name": "DS", "path": str(folder)})
            self.assertEqual(data["volumes"], [{"name": "LC-MS Agilent data", "path": str(self.root), "pinned": True}])
            folder.rmdir()
            self.assertIsNone(server.list_volumes()["personal_folder"])

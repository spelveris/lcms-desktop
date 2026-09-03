import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from search_index import (  # noqa: E402
    INDEX_DIRECTORY_NAME,
    record_transferred_sample,
    search_shared_index,
    write_complete_index,
)


class SharedSearchIndexTests(unittest.TestCase):
    def test_multiple_computers_reuse_their_shards_and_merge_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "AA" / "Sample-101.d"
            second = root / "BB" / "Sample-202.d"
            first.mkdir(parents=True)
            second.mkdir(parents=True)

            with patch.dict(
                os.environ,
                {"COMPUTERNAME": "LCMS Room 1", "CATRUPOLE_MACHINE_ID": "room-1"},
                clear=False,
            ):
                self.assertTrue(
                    write_complete_index(
                        root,
                        [{
                            "name": first.name,
                            "path": str(first),
                            "is_dir": True,
                            "is_d_folder": True,
                            "kind": "sample-folder",
                            "modified": first.stat().st_mtime,
                        }],
                    )
                )
                self.assertTrue(record_transferred_sample(root, first))

            with patch.dict(
                os.environ,
                {"COMPUTERNAME": "LCMS Room 2", "CATRUPOLE_MACHINE_ID": "room-2"},
                clear=False,
            ):
                self.assertTrue(record_transferred_sample(root, second))
                self.assertTrue(record_transferred_sample(root, second))

            shards = sorted((root / INDEX_DIRECTORY_NAME).glob("*.json"))
            self.assertEqual(len(shards), 2)
            self.assertTrue(all(path.name.startswith("machine-") for path in shards))
            result = search_shared_index(root, "sample", 20)
            self.assertIsNotNone(result)
            self.assertEqual(
                {item["name"] for item in result["items"]},
                {first.name, second.name},
            )

            scoped = search_shared_index(root, "sample", 20, search_root=first.parent)
            self.assertEqual([item["name"] for item in scoped["items"]], [first.name])

    def test_partial_transfer_shard_does_not_hide_unindexed_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sample = root / "Sample-101.d"
            sample.mkdir()
            with patch.dict(
                os.environ,
                {"COMPUTERNAME": "LCMS Room 1", "CATRUPOLE_MACHINE_ID": "room-1"},
                clear=False,
            ):
                self.assertTrue(record_transferred_sample(root, sample))
            self.assertIsNone(search_shared_index(root, "sample", 20))
            document = json.loads(next((root / INDEX_DIRECTORY_NAME).glob("*.json")).read_text())
            self.assertFalse(document["complete_scan"])


if __name__ == "__main__":
    unittest.main()

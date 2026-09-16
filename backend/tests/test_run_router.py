import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


class RunRouterWashTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        # A parent folder mentioning wash must not exclude its normal runs.
        self.source = self.root / "instrument_wash_archive"
        self.destination = self.root / "destination"
        self.source.mkdir()
        (self.destination / "DS").mkdir(parents=True)
        (self.destination / "Unnamed").mkdir()
        env = patch.dict(os.environ, {
            "LCMS_USER_DATA_DIR": str(self.root / "app-data"),
            "CATRUPOLE_MACHINE_ID": "router-test-machine",
        })
        env.start()
        self.addCleanup(env.stop)
        self.payload = {
            "source_path": str(self.source),
            "initials_root": str(self.destination),
        }

    def make_run(self, name, position=1, parent=None, complete=True):
        run = (parent or self.source) / name
        run.mkdir()
        (run / "signal.bin").write_bytes(b"test instrument data")
        if complete:
            (run / "RUN.LOG").write_text(
                f"Sample from location '{position}'\nMethod completed\n",
                encoding="utf-16",
            )
        return run

    def test_scan_skips_machine_washes_but_keeps_personal_washes(self):
        wash_names = [
            "wash_001.d", "Wash 002.D", "WASH-003.d", "wash004.d",
            "wash.d", "wash_005.sirslt",
        ]
        for name in wash_names:
            self.make_run(name, complete=False)
        self.make_run("DS_old_machine.d", position=91)
        self.make_run("wash_both_rules.d", position=91)
        personal = self.make_run("DS_wash_003.d")
        ordinary = self.make_run("DS_sample.d")
        other_word = self.make_run("Washer_control.d")

        result = server.run_router_scan(self.payload)

        self.assertEqual(
            {item["name"] for item in result["items"]},
            {personal.name, ordinary.name, other_word.name},
        )
        self.assertEqual(result["summary"]["ready"], 3)
        self.assertEqual(result["summary"]["wash"], len(wash_names) + 2)

    def test_copy_ready_runs_transfers_personal_wash_and_indexes_only_copies(self):
        machine_wash = self.make_run("wash_001.d")
        old_wash = self.make_run("DS_old_machine.d", position=91)
        personal = self.make_run("DS_wash_003.d")
        ordinary = self.make_run("DS_sample.d")
        before = {
            str(path.relative_to(self.source)): path.read_bytes()
            for path in self.source.rglob("*") if path.is_file()
        }

        result = server.run_router_copy(self.payload)

        self.assertEqual(result["summary"]["copied"], 2)
        self.assertEqual(result["summary"]["errors"], 0)
        self.assertEqual(
            {item["name"] for item in result["items"]},
            {personal.name, ordinary.name},
        )
        for item in result["items"]:
            copied = Path(item["destination_path"])
            self.assertEqual(copied.parent.parent.name, "DS")
            self.assertEqual((copied / "signal.bin").read_bytes(), b"test instrument data")
        for wash in (machine_wash, old_wash):
            self.assertFalse(list(self.destination.rglob(wash.name)))
        after = {
            str(path.relative_to(self.source)): path.read_bytes()
            for path in self.source.rglob("*") if path.is_file()
        }
        self.assertEqual(before, after)
        shards = list((self.destination / ".catrupole-index").glob("*.json"))
        self.assertEqual(len(shards), 1)
        index_text = json.dumps(json.loads(shards[0].read_text()))
        self.assertIn(personal.name, index_text)
        self.assertIn(ordinary.name, index_text)
        self.assertNotIn(machine_wash.name, index_text)
        self.assertNotIn(old_wash.name, index_text)

    def test_explicit_copy_request_cannot_bypass_either_wash_rule(self):
        named_wash = self.make_run("Wash 001.sirslt", complete=False)
        old_wash = self.make_run("DS_old_machine.d", position=91)
        personal = self.make_run("DS_wash_003.d")

        result = server.run_router_copy({
            **self.payload,
            "run_paths": [str(named_wash), str(old_wash), str(personal)],
        })

        self.assertEqual(result["summary"]["skipped"], 2)
        self.assertEqual(result["summary"]["copied"], 1)
        self.assertEqual(result["summary"]["errors"], 0)
        by_name = {item["name"]: item for item in result["items"]}
        self.assertEqual(by_name[named_wash.name]["status"], "skipped")
        self.assertIn("starts with wash", by_name[named_wash.name]["detail"])
        self.assertEqual(by_name[old_wash.name]["detail"], "Wash position skipped")
        self.assertEqual(by_name[personal.name]["status"], "copied")
        self.assertFalse(list(self.destination.rglob(named_wash.name)))
        self.assertFalse(list(self.destination.rglob(old_wash.name)))

    def test_monitor_scan_uses_the_same_rules(self):
        sequence = self.source / server._recent_sequence_date_tokens(7)[0]
        sequence.mkdir()
        self.make_run("wash_001.d", parent=sequence)
        self.make_run("DS_old_machine.d", position=91, parent=sequence)
        personal = self.make_run("DS_wash_003.d", parent=sequence)

        result = server.run_router_scan({**self.payload, "monitor_recent_days": 7})

        self.assertEqual([item["name"] for item in result["items"]], [personal.name])
        self.assertEqual(result["summary"]["wash"], 2)
        self.assertEqual(result["summary"]["ready"], 1)


if __name__ == "__main__":
    unittest.main()

import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plot_runtime import DeferredModule, PlotRuntime


class PlotRuntimeTests(unittest.TestCase):
    def test_workspace_import_does_not_load_export_renderer(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, MPLCONFIGDIR=tmp, LCMS_USER_DATA_DIR=tmp)
            result = subprocess.run([
                sys.executable, "-c",
                "import sys, server; assert 'matplotlib.pyplot' not in sys.modules; "
                "assert 'matplotlib.font_manager' not in sys.modules; "
                "assert 'plotting' not in sys.modules; assert server.health()['status'] == 'ok'",
            ], cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_warmup_and_early_exports_share_one_complete_initialization(self):
        started, release = Event(), Event()
        calls = []
        ready = SimpleNamespace(fonts="unchanged")

        def loader():
            calls.append(True)
            started.set()
            self.assertTrue(release.wait(5))
            return {"plotting": ready, "pyplot": ready}

        runtime = PlotRuntime(loader)
        runtime.warm_in_background()
        self.assertTrue(started.wait(5))
        worker = runtime._worker
        runtime.warm_in_background()
        self.assertIs(runtime._worker, worker)
        proxy = DeferredModule(runtime, "plotting")
        with ThreadPoolExecutor(max_workers=4) as pool:
            requests = [pool.submit(lambda: proxy.fonts) for _ in range(4)]
            try:
                self.assertTrue(all(not item.done() for item in requests))
            finally:
                release.set()
            self.assertEqual([item.result(timeout=5) for item in requests], ["unchanged"] * 4)
        worker.join(timeout=5)
        self.assertEqual(len(calls), 1)

    def test_failed_warmup_can_be_retried_by_export(self):
        calls = []

        def loader():
            calls.append(True)
            if len(calls) == 1:
                raise RuntimeError("temporary font scan failure")
            return {"plotting": "ready"}

        runtime = PlotRuntime(loader)
        with self.assertLogs("plot_runtime", level="ERROR"):
            runtime.warm_in_background()
            runtime._worker.join(timeout=5)
        self.assertIsNone(runtime._modules)
        self.assertEqual(runtime.get("plotting"), "ready")

    def test_lifespan_does_not_wait_for_font_scan(self):
        import server
        from unittest.mock import patch
        started, release = Event(), Event()

        def loader():
            started.set()
            release.wait(5)
            return {"plotting": "ready"}

        runtime = PlotRuntime(loader)

        async def run():
            with patch.object(server, "plot_runtime", runtime):
                async with server.lifespan(server.app):
                    self.assertTrue(started.wait(5))
                    self.assertFalse(release.is_set())
                    self.assertEqual(server.health()["status"], "ok")

        try:
            asyncio.run(run())
        finally:
            release.set()
            runtime._worker.join(timeout=5)


if __name__ == "__main__":
    unittest.main()

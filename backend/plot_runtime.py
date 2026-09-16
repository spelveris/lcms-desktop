"""Prepare the unchanged export renderer without blocking workspace startup.

Matplotlib's first font scan can be slow, especially in a frozen application.
The browser plots do not use it. Warm it in one background thread and make an
early export wait for that same initialization, never a partially loaded module.
"""

import logging
from threading import Lock, Thread


def _load_modules():
    # Keep these imports explicit so PyInstaller collects the same dependencies.
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as pyplot
    import plotting
    return {"pyplot": pyplot, "plotting": plotting}


class PlotRuntime:
    def __init__(self, loader=_load_modules):
        self._loader = loader
        self._load_lock = Lock()
        self._warm_lock = Lock()
        self._modules = None
        self._worker = None

    def get(self, name):
        with self._load_lock:
            if self._modules is None:
                # Publish only after pyplot and plotting's rcParams are ready.
                self._modules = self._loader()
            return self._modules[name]

    def warm_in_background(self):
        with self._warm_lock:
            if self._worker is None:
                self._worker = Thread(target=self._warm, name="catrupole-export-warmup", daemon=True)
                self._worker.start()

    def _warm(self):
        try:
            self.get("plotting")
        except Exception:
            # Keep file browsing/analysis usable. An export retries initialization
            # and reports the actual error through the existing request handling.
            logging.getLogger(__name__).exception("Export renderer warmup failed")


class DeferredModule:
    def __init__(self, runtime, name):
        self._runtime = runtime
        self._name = name

    def __getattr__(self, name):
        return getattr(self._runtime.get(self._name), name)


runtime = PlotRuntime()
plotting = DeferredModule(runtime, "plotting")
pyplot = DeferredModule(runtime, "pyplot")

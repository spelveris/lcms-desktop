"""Configuration defaults for LC-MS Web App."""

import os

APP_VERSION = "1.10.9"

def get_default_path():
    """Get a sensible default path for LC-MS data."""
    # Check environment variable first
    env_path = os.environ.get("LCMS_BASE_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    # Windows: prefer the first available local drive
    if os.name == "nt":
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.exists(drive) and os.path.isdir(drive):
                return drive

    # Priority 1: Check for known LC-MS network drives (macOS)
    lcms_drives = [
        "/Volumes/nas22",
        "/Volumes/chab_loc_lang_s1",
    ]
    for drive in lcms_drives:
        if os.path.exists(drive) and os.path.isdir(drive):
            return drive

    # Priority 2: Check /Volumes for any mounted drives (macOS)
    if os.path.exists("/Volumes"):
        return "/Volumes"

    # Priority 3: Common fallback locations
    candidates = [
        os.path.expanduser("~/Documents"),  # User documents
        os.path.expanduser("~"),  # Home directory
        "C:\\",  # Windows root
        "/data/lcms",  # Docker default
    ]

    for path in candidates:
        if os.path.exists(path):
            return path

    return os.path.expanduser("~")  # Final fallback

# Base path for LC-MS data
BASE_PATH = get_default_path()

# UV wavelength to display (nm)
UV_WAVELENGTH = 280

# Smoothing parameters
UV_SMOOTHING_WINDOW = 36
EIC_SMOOTHING_WINDOW = 5

# Default m/z values (empty by default)
DEFAULT_MZ_VALUES = []

# Default m/z window for EIC extraction
DEFAULT_MZ_WINDOW = 0.5

# Export settings
EXPORT_DPI = 300

# Plot colors for time progression
TIME_COLORS = {
    "initial": "#808080",  # Grey
    "mid": "#1f77b4",      # Blue
    "final": "#d62728",    # Red
}

# Plot color cycle for multiple EICs
EIC_COLORS = [
    "#1f77b4",  # Blue
    "#ff7f0e",  # Orange
    "#2ca02c",  # Green
    "#d62728",  # Red
    "#9467bd",  # Purple
    "#8c564b",  # Brown
    "#e377c2",  # Pink
    "#7f7f7f",  # Gray
]

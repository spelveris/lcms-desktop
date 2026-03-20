"""FastAPI backend for LC-MS Desktop App.

Wraps the existing analysis/data_reader code and exposes it as REST endpoints.
The Electron frontend communicates with this server via HTTP.
"""

import os
import re
import sys
import io
import datetime
import json
import shutil
import subprocess
from pathlib import Path
from threading import Lock
from typing import Optional, Union

# Patch out Streamlit before any lcms-webapp imports
from data_reader_patch import patch_streamlit
patch_streamlit()

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import numpy as np
import matplotlib
matplotlib.use("Agg", force=True)
import matplotlib.pyplot as plt

# Prefer local desktop copies of core LC-MS modules.
BACKEND_DIR = os.path.dirname(__file__)
LOCAL_LCMS_APP_DIR = os.environ.get(
    "LCMS_LOCAL_APP_DIR",
    os.path.join(BACKEND_DIR, "lcms_app"),
)
if os.path.isdir(LOCAL_LCMS_APP_DIR):
    sys.path.insert(0, os.path.abspath(LOCAL_LCMS_APP_DIR))

# Optional external fallback via LCMS_APP_DIR (for advanced overrides).
LCMS_APP_DIR = os.environ.get("LCMS_APP_DIR")
if LCMS_APP_DIR and os.path.isdir(LCMS_APP_DIR):
    abs_external = os.path.abspath(LCMS_APP_DIR)
    if abs_external not in sys.path:
        sys.path.append(abs_external)

# Import existing modules
from data_reader import SampleData, SUPPORTED_SAMPLE_SUFFIXES, list_d_folders
import analysis
import config as lcms_config
import plotting

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="LC-MS Desktop API", version=lcms_config.APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache of loaded samples  {folder_path: SampleData}
_sample_cache: dict[str, SampleData] = {}
_sample_cache_state: dict[str, str] = {}
RUN_SETTLE_SECONDS = 120
WASH_POSITIONS = {91}
DEFAULT_DECONV_MIN_INPUT_MZ = 100.0
DEFAULT_DECONV_MIN_CHARGE = 1
DEFAULT_DECONV_MAX_CHARGE = 50
DEFAULT_DECONV_MIN_PEAKS = 3
DEFAULT_DECONV_MW_AGREEMENT = 0.0005
DEFAULT_DECONV_CONTIG_MIN = 3
DEFAULT_DECONV_ABUNDANCE_CUTOFF = 0.05
DEFAULT_DECONV_ENVELOPE_CUTOFF = 0.50
DEFAULT_DECONV_MAX_OVERLAP = 0.0
DEFAULT_DECONV_PWHH = 0.6
DEFAULT_DECONV_NOISE_CUTOFF = 1000.0
DEFAULT_DECONV_LOW_MW = 500.0
DEFAULT_DECONV_HIGH_MW = 50000.0
DEFAULT_DECONV_MW_ASSIGN_CUTOFF = 0.40
DEFAULT_DECONV_USE_MZ_AGREEMENT = False
DEFAULT_DECONV_USE_MONOISOTOPIC = False
DEFAULT_DECONV_INCLUDE_SINGLY_CHARGED = True
_router_log_lock = Lock()
_router_logged_item_state: dict[str, str] = {}
_router_last_window_signature = ""
ROUTER_LOG_RETENTION_DAYS = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ndarray_to_list(arr):
    """Safely convert numpy array to Python list for JSON serialization."""
    if arr is None:
        return None
    if isinstance(arr, np.ndarray):
        return arr.tolist()
    return arr


def _is_supported_sample_folder(path: Path) -> bool:
    return path.is_dir() and path.name.lower().endswith(SUPPORTED_SAMPLE_SUFFIXES)


def _strip_sample_suffix(name: str) -> str:
    value = str(name or "")
    lowered = value.lower()
    for suffix in SUPPORTED_SAMPLE_SUFFIXES:
        if lowered.endswith(suffix):
            return value[: -len(suffix)]
    return value


def _normalize_filesystem_path(path_str: str) -> str:
    """Normalize incoming manual paths, including UNC/smb paths on macOS."""
    raw = str(path_str or "").strip()
    if not raw:
        return raw

    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        raw = raw[1:-1].strip()
    if not raw:
        return raw

    if raw.lower().startswith("smb://"):
        smb_path = raw[6:]
        parts = [part for part in smb_path.split("/") if part]
        if len(parts) >= 2:
            host, share, *rest = parts
            if sys.platform == "darwin":
                mount_root = Path("/Volumes") / share
                if mount_root.exists():
                    return str(mount_root.joinpath(*rest))
            return "\\\\" + "\\".join([host, share, *rest])

    if raw.startswith("\\\\") or raw.startswith("//"):
        parts = [part for part in re.split(r"[\\/]+", raw.lstrip("\\/")) if part]
        if len(parts) >= 2:
            host, share, *rest = parts
            if sys.platform == "darwin":
                mount_root = Path("/Volumes") / share
                if mount_root.exists():
                    return str(mount_root.joinpath(*rest))
            return "\\\\" + "\\".join([host, share, *rest])

    return raw


def _app_user_data_dir() -> Path:
    configured = os.environ.get("LCMS_USER_DATA_DIR", "").strip()
    if configured:
        return Path(configured)

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "CATrupole"
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        if local_appdata:
            return Path(local_appdata) / "CATrupole"
        return Path.home() / "AppData" / "Local" / "CATrupole"

    xdg_state = os.environ.get("XDG_STATE_HOME", "").strip()
    if xdg_state:
        return Path(xdg_state) / "CATrupole"
    return Path.home() / ".local" / "state" / "CATrupole"


def _router_log_path() -> Path:
    return _app_user_data_dir() / "logs" / "transfer-router.log"


def _sanitize_log_field(value: object) -> str:
    return str(value or "").replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()


def _append_router_log(
    event: str,
    status: str,
    run_name: str = "",
    source_path: str = "",
    destination_path: str = "",
    detail: str = "",
) -> str:
    log_path = _router_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    header = "timestamp\tevent\tstatus\trun_name\tsource_path\tdestination_path\tdetail\n"
    now_dt = datetime.datetime.now()
    line = "\t".join([
        now_dt.isoformat(),
        _sanitize_log_field(event),
        _sanitize_log_field(status),
        _sanitize_log_field(run_name),
        _sanitize_log_field(source_path),
        _sanitize_log_field(destination_path),
        _sanitize_log_field(detail),
    ]) + "\n"
    with _router_log_lock:
        cutoff = now_dt - datetime.timedelta(days=max(1, int(ROUTER_LOG_RETENTION_DAYS)))
        preserved_lines: list[str] = []

        if log_path.exists():
            try:
                existing_lines = log_path.read_text(encoding="utf-8").splitlines()
            except Exception:
                existing_lines = []
            if existing_lines and existing_lines[0].startswith("timestamp\t"):
                existing_lines = existing_lines[1:]
            for existing_line in existing_lines:
                if not existing_line.strip():
                    continue
                timestamp_text = existing_line.split("\t", 1)[0].strip()
                try:
                    timestamp_value = datetime.datetime.fromisoformat(timestamp_text)
                except Exception:
                    preserved_lines.append(existing_line)
                    continue
                if timestamp_value >= cutoff:
                    preserved_lines.append(existing_line)

        with log_path.open("w", encoding="utf-8") as handle:
            handle.write(header)
            for existing_line in preserved_lines:
                handle.write(existing_line.rstrip("\n") + "\n")
            handle.write(line)
    return str(log_path)


def _router_log_detail_for_item(item: dict) -> str:
    status = str(item.get("status") or "")
    route_mode = str(item.get("route_mode") or "")
    initials = str(item.get("initials") or "")
    last_line = str(item.get("run_log_last_line") or "").strip()
    completion_source = str(item.get("completion_source") or "").strip()
    route_reason = str(item.get("route_reason") or "").strip()
    normalized_run_name = str(item.get("normalized_run_name") or "").strip()
    initials_root = str(item.get("initials_root") or "").strip()
    unnamed_available = item.get("unnamed_available")
    available_initials_preview = str(item.get("available_initials_preview") or "").strip()
    completion_prefix = f"[{completion_source}] " if completion_source else ""

    if status == "running":
        if last_line:
            return f"{completion_prefix}{last_line}".strip()
        if route_mode == "unnamed":
            return "Run still active, will route to Unnamed when finished"
        if initials:
            return f"Run still active, will route to {initials}"
        return "Run still active"
    if status in {"ready", "already-copied"}:
        if last_line:
            return f"{completion_prefix}{last_line}".strip()
        if route_mode == "unnamed":
            return "Method completed, routing to Unnamed"
        if initials:
            return f"Method completed, matched {initials}"
        return "Method completed"
    if status in {"failed", "skipped"} and last_line:
        return f"{completion_prefix}{last_line}".strip()
    if route_mode == "unnamed":
        return "No recognizable initials, routing to Unnamed"
    if initials:
        return f"Matched {initials}"
    if route_reason or normalized_run_name or initials_root or available_initials_preview:
        detail_bits = []
        if route_reason:
            detail_bits.append(f"reason={route_reason}")
        if normalized_run_name:
            detail_bits.append(f"normalized={normalized_run_name}")
        if initials_root:
            detail_bits.append(f"initials_root={initials_root}")
        if unnamed_available is not None:
            detail_bits.append(f"unnamed={'yes' if unnamed_available else 'no'}")
        if available_initials_preview:
            detail_bits.append(f"available={available_initials_preview}")
        return f"No transfer target ({'; '.join(detail_bits)})"
    return "No transfer target"


def _maybe_log_router_scan_window(
    source_root: Path,
    scan_roots: list[Path],
    initials_root: Path,
    destination_root: Path,
    recursive: bool,
    monitor_recent_days: int,
    monitor_date_tokens: list[str],
) -> str:
    global _router_last_window_signature

    status = "monitoring" if monitor_recent_days > 0 else "manual-scan"
    roots_text = ", ".join(str(path) for path in scan_roots)
    tokens_text = ", ".join(monitor_date_tokens)
    signature = "|".join([
        status,
        str(source_root),
        str(monitor_recent_days),
        roots_text,
        tokens_text,
    ])

    if monitor_recent_days > 0 and signature == _router_last_window_signature:
        return str(_router_log_path())

    _router_last_window_signature = signature
    detail = f"scan_roots={roots_text or str(source_root)}"
    detail += f"; initials_root={initials_root}"
    detail += f"; destination_root={destination_root}"
    detail += f"; recursive={'yes' if recursive else 'no'}"
    if monitor_recent_days > 0 and tokens_text:
        detail += f"; date_tokens={tokens_text}"
    return _append_router_log(
        event="scan-window",
        status=status,
        source_path=str(source_root),
        detail=detail,
    )


def _maybe_log_router_scan_item(item: dict) -> str:
    source_path = str(item.get("path") or "")
    detail = _router_log_detail_for_item(item)
    fingerprint = "|".join([
        str(item.get("status") or ""),
        str(item.get("destination_path") or ""),
        detail,
    ])

    with _router_log_lock:
        previous = _router_logged_item_state.get(source_path)
        if previous == fingerprint:
            return str(_router_log_path())
        _router_logged_item_state[source_path] = fingerprint

    return _append_router_log(
        event="scan-item",
        status=str(item.get("status") or "scanned"),
        run_name=str(item.get("name") or ""),
        source_path=source_path,
        destination_path=str(item.get("destination_path") or ""),
        detail=detail,
    )


def _decode_text_file(path: Path) -> str:
    try:
        raw = path.read_bytes()
    except Exception:
        return ""
    if not raw:
        return ""
    try:
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in raw[:200]:
            return raw.decode("utf-16", errors="ignore")
        return raw.decode("utf-8", errors="ignore")
    except Exception:
        return raw.decode("latin-1", errors="ignore")


def _folder_latest_mtime(folder: Path) -> float:
    try:
        latest = folder.stat().st_mtime
    except Exception:
        return 0.0

    try:
        for entry in folder.iterdir():
            try:
                latest = max(latest, entry.stat().st_mtime)
            except Exception:
                continue
    except Exception:
        pass
    return latest


def _extract_sample_location(run_log_text: str) -> Optional[int]:
    """Extract the autosampler position from Agilent RUN.LOG text."""
    text = str(run_log_text or "")
    if not text:
        return None

    patterns = [
        r"sample from location\s+'?(\d+)'?",
        r"line#\s+\d+\s+at location\s+'?(\d+)'?",
        r"\blocation\s+'?(\d+)'?",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except Exception:
                return None
    return None


def _normalized_run_log_lines(run_log_text: str) -> list[str]:
    text = str(run_log_text or "")
    if not text:
        return []

    lines = []
    for raw_line in text.splitlines():
        line = " ".join(str(raw_line).replace("\x00", " ").split())
        if line:
            lines.append(line)
    return lines


def _latest_run_log_line(run_log_text: str) -> Optional[str]:
    lines = _normalized_run_log_lines(run_log_text)
    return lines[-1] if lines else None


def _run_log_has_method_completed(run_log_text: str) -> bool:
    line = _latest_run_log_line(run_log_text) or ""
    return bool(re.search(r"\bmethod\s+completed\b", line, flags=re.IGNORECASE))


def _find_sirslt_acaml_file(folder: Path) -> Optional[Path]:
    try:
        acaml_files = [
            path for path in sorted(folder.glob("*.acaml"))
            if path.is_file() and not path.name.startswith("._")
        ]
    except Exception:
        acaml_files = []
    return acaml_files[0] if acaml_files else None


def _extract_sirslt_acaml_state(acaml_text: str) -> dict:
    text = str(acaml_text or "")
    status_match = re.search(
        r"<AcquitionStatus>.*?<Status>\s*([^<]+?)\s*</Status>",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    message_match = re.search(
        r"<AcquitionStatus>.*?<Message>\s*([^<]+?)\s*</Message>",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    integrity_match = re.search(
        r"<ContentIntegrity>\s*([^<]+?)\s*</ContentIntegrity>",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    modified_match = re.search(
        r'LastModifiedDateTime="([^"]+)"',
        text,
        flags=re.IGNORECASE,
    )

    status = " ".join(str(status_match.group(1)).split()) if status_match else ""
    message = " ".join(str(message_match.group(1)).split()) if message_match else ""
    integrity = " ".join(str(integrity_match.group(1)).split()) if integrity_match else ""
    modified = " ".join(str(modified_match.group(1)).split()) if modified_match else ""

    aborted = False
    if status:
        aborted = status.strip().lower() in {"aborted", "failed", "error", "cancelled", "canceled"}
    if not aborted and message:
        aborted = bool(
            re.search(
                r"\bacquisition\s+aborted\b|\bhardware\s+error\b|\bby\s+system\b|\bcancelled\b|\bcanceled\b",
                message,
                flags=re.IGNORECASE,
            )
        )

    completed = False
    if not aborted:
        completed = status.lower() == "completed"
        if not completed and message:
            completed = bool(re.search(r"\bacquisition\s+completed\b", message, flags=re.IGNORECASE))
        if not completed and integrity:
            completed = integrity.strip().lower() == "complete"

    return {
        "status": status,
        "message": message,
        "content_integrity": integrity,
        "last_modified": modified,
        "aborted": aborted,
        "completed": completed,
    }


def _inspect_sample_run_state(folder_path: Union[str, Path]) -> dict:
    folder = Path(_normalize_filesystem_path(str(folder_path)))
    if folder.name.lower().endswith(".sirslt"):
        latest_mtime = _folder_latest_mtime(folder)
        completion_source = "acaml-pending"
        run_complete = False
        run_failed = False
        run_log_last_line = None
        cacheable = False

        acaml_path = _find_sirslt_acaml_file(folder)
        if acaml_path is not None:
            acaml_state = _extract_sirslt_acaml_state(_decode_text_file(acaml_path))
            status = str(acaml_state.get("status") or "")
            message = str(acaml_state.get("message") or "")
            integrity = str(acaml_state.get("content_integrity") or "")
            modified = str(acaml_state.get("last_modified") or "")

            if message:
                run_log_last_line = message
            elif status:
                run_log_last_line = f"Status: {status}"
            elif integrity:
                run_log_last_line = f"Content integrity: {integrity}"
            elif modified:
                run_log_last_line = f"Last modified: {modified}"

            if acaml_state.get("aborted"):
                run_failed = True
                cacheable = True
                completion_source = "acaml-aborted"
            elif acaml_state.get("completed"):
                run_complete = True
                cacheable = True
                completion_source = "acaml-status"
            else:
                completion_source = "acaml-pending"

        return {
            "folder_path": str(folder),
            "latest_mtime": latest_mtime,
            "run_complete": run_complete,
            "run_in_progress": not run_complete and not run_failed,
            "run_failed": run_failed,
            "cacheable": cacheable,
            "completion_source": completion_source,
            "run_log_last_line": run_log_last_line,
            "sample_location": None,
            "is_wash_position": False,
        }

    latest_mtime = _folder_latest_mtime(folder)
    now_ts = datetime.datetime.now().timestamp()
    settled = latest_mtime > 0 and (now_ts - latest_mtime) >= RUN_SETTLE_SECONDS
    completion_source = "mtime-settled" if settled else "active-write"
    run_complete = False
    sample_location = None
    run_log_last_line = None

    try:
        run_logs = sorted(folder.glob("RUN*.LOG"), key=lambda p: p.stat().st_mtime, reverse=True)
    except Exception:
        run_logs = []

    if run_logs:
        raw_text = _decode_text_file(run_logs[0])
        sample_location = _extract_sample_location(raw_text)
        run_log_last_line = _latest_run_log_line(raw_text)
        if _run_log_has_method_completed(raw_text):
            run_complete = True
            completion_source = "run-log"

    cacheable = run_complete or settled
    return {
        "folder_path": str(folder),
        "latest_mtime": latest_mtime,
        "run_complete": run_complete,
        "run_in_progress": not cacheable,
        "run_failed": False,
        "cacheable": cacheable,
        "completion_source": completion_source,
        "run_log_last_line": run_log_last_line,
        "sample_location": sample_location,
        "is_wash_position": sample_location in WASH_POSITIONS if sample_location is not None else False,
    }


def _sample_cache_token(run_state: dict) -> str:
    latest = float(run_state.get("latest_mtime") or 0.0)
    completion_source = str(run_state.get("completion_source") or "")
    cacheable = "1" if run_state.get("cacheable") else "0"
    return f"{latest:.6f}|{completion_source}|{cacheable}"


def _get_sample(folder_path: str) -> SampleData:
    """Load sample with caching."""
    normalized_path = _normalize_filesystem_path(folder_path)
    run_state = _inspect_sample_run_state(normalized_path)
    cache_token = _sample_cache_token(run_state)

    if run_state["cacheable"]:
        cached = _sample_cache.get(normalized_path)
        if cached is not None and _sample_cache_state.get(normalized_path) == cache_token:
            return cached
    else:
        _sample_cache.pop(normalized_path, None)
        _sample_cache_state.pop(normalized_path, None)

    sample = SampleData(normalized_path)
    ok = sample.load()
    if not ok:
        raise HTTPException(status_code=400, detail=sample.error or "Failed to load sample")

    if run_state["cacheable"]:
        _sample_cache[normalized_path] = sample
        _sample_cache_state[normalized_path] = cache_token

    return sample


def _coerce_float(value, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


def _coerce_int(value, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _coerce_bool(value, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"1", "true", "yes", "on"}:
            return True
        if v in {"0", "false", "no", "off"}:
            return False
    return default


def _sanitize_filename(name: str, fallback: str = "sample") -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in str(name)).strip("_")
    return safe or fallback


def _iter_d_folder_paths(base_path: Union[str, Path], recursive: bool = True) -> list[Path]:
    root = Path(_normalize_filesystem_path(str(base_path)))
    if not root.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    folders: list[Path] = []
    if not recursive:
        try:
            for entry in sorted(root.iterdir()):
                if entry.name.startswith("."):
                    continue
                if _is_supported_sample_folder(entry):
                    folders.append(entry)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")
        return folders

    def _on_walk_error(exc):
        if isinstance(exc, PermissionError):
            raise HTTPException(status_code=403, detail="Permission denied")

    for current_root, dirs, _files in os.walk(root, onerror=_on_walk_error):
        visible_dirs = [d for d in dirs if not d.startswith(".")]
        d_dirs = [d for d in visible_dirs if _is_supported_sample_folder(Path(current_root) / d)]
        for dirname in d_dirs:
            folders.append(Path(current_root) / dirname)
        dirs[:] = [d for d in visible_dirs if not _is_supported_sample_folder(Path(current_root) / d)]
    return folders


def _recent_sequence_date_tokens(lookback_days: int) -> list[str]:
    days = max(0, int(lookback_days))
    today = datetime.date.today()
    tokens: list[str] = []
    seen: set[str] = set()

    for offset in range(days + 1):
        day = today - datetime.timedelta(days=offset)
        day_tokens = [
            day.strftime("%y %m %d"),
            day.strftime("%y%m%d"),
            day.strftime("%Y %m %d"),
            day.strftime("%Y%m%d"),
            day.strftime("%Y-%m-%d"),
            day.strftime("%Y_%m_%d"),
        ]
        for token in day_tokens:
            normalized = re.sub(r"\s+", " ", token.strip())
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            tokens.append(normalized)

    return tokens


def _folder_name_matches_sequence_tokens(folder_name: str, tokens: list[str]) -> bool:
    normalized = re.sub(r"\s+", " ", str(folder_name or "").strip())
    if not normalized or not tokens:
        return False
    return any(token in normalized for token in tokens)


def _is_ignored_router_monitor_folder(folder_name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(folder_name or "").strip().lower())
    words = {part for part in normalized.split() if part}
    return "demo" in words or "shutdown" in words


def _is_ignored_router_sample_path(path: Union[str, Path]) -> bool:
    parts = [
        re.sub(r"[^a-z0-9]+", " ", str(part).strip().lower())
        for part in Path(str(path)).parts
    ]
    words = {word for part in parts for word in part.split() if word}
    return "shutdown" in words


def _resolve_run_router_scan_roots(
    source_path: Union[str, Path],
    monitor_recent_days: int = 0,
) -> tuple[Path, list[Path], list[str]]:
    root = Path(_normalize_filesystem_path(str(source_path)))
    if not root.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    recent_days = max(0, int(monitor_recent_days))
    if recent_days <= 0:
        return root, [root], []

    tokens = _recent_sequence_date_tokens(recent_days)
    if _folder_name_matches_sequence_tokens(root.name, tokens):
        return root, [root], tokens

    try:
        child_dirs = [
            entry for entry in sorted(root.iterdir())
            if (
                entry.is_dir()
                and not entry.name.startswith(".")
                and not _is_supported_sample_folder(entry)
                and not _is_ignored_router_monitor_folder(entry.name)
            )
        ]
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    matching_children = [
        entry for entry in child_dirs
        if _folder_name_matches_sequence_tokens(entry.name, tokens)
    ]
    if matching_children:
        return root, matching_children, tokens

    return root, [root], tokens


def _list_router_initial_dirs(initials_root: Union[str, Path]) -> tuple[Path, list[Path]]:
    root = Path(_normalize_filesystem_path(str(initials_root)))
    if not root.exists():
        raise HTTPException(status_code=404, detail="Initials root not found")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="Initials root is not a directory")

    try:
        folders = [
            entry for entry in sorted(root.iterdir())
            if entry.is_dir() and not entry.name.startswith(".")
        ]
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    if not folders:
        raise HTTPException(status_code=400, detail="Initials root has no subfolders")
    return root, folders


def _preview_router_initial_dirs(initials_dirs: list[Path], limit: int = 12) -> str:
    names = [folder.name for folder in initials_dirs if folder and folder.name]
    if not names:
        return "(none)"
    preview = names[:max(1, int(limit))]
    suffix = "" if len(names) <= len(preview) else f", ... ({len(names)} total)"
    return ", ".join(preview) + suffix


def _match_router_initials(run_name: str, initials_dirs: list[Path]) -> tuple[Optional[str], Optional[Path]]:
    base_name = _strip_sample_suffix(Path(str(run_name)).name)
    normalized = re.sub(r"\s+", " ", base_name.strip()).upper()
    if not normalized:
        return None, None

    candidates = sorted(
        ((folder.name, folder) for folder in initials_dirs),
        key=lambda item: (-len(item[0]), item[0].upper()),
    )

    for folder_name, folder_path in candidates:
        key = folder_name.upper()
        if not key:
            continue
        if normalized == key:
            return folder_name, folder_path
        if normalized.startswith(key):
            next_char = normalized[len(key):len(key) + 1]
            if not next_char or not next_char.isalnum():
                return folder_name, folder_path

    for folder_name, folder_path in candidates:
        key = folder_name.upper()
        if key and normalized.startswith(key):
            return folder_name, folder_path

    return None, None


def _build_router_destination(
    folder_path: Union[str, Path],
    initials_root: Union[str, Path],
    destination_root: Optional[Union[str, Path]] = None,
    initials_dirs: Optional[list[Path]] = None,
) -> dict:
    source_folder = Path(_normalize_filesystem_path(str(folder_path)))
    initials_root_path, initial_dirs = (
        (Path(_normalize_filesystem_path(str(initials_root))), initials_dirs)
        if initials_dirs is not None
        else _list_router_initial_dirs(initials_root)
    )
    if initial_dirs is None:
        initial_dirs = []

    normalized_run_name = re.sub(r"\s+", " ", _strip_sample_suffix(source_folder.name).strip()).upper()
    matched_initials, matched_initials_dir = _match_router_initials(source_folder.name, initial_dirs)
    destination_root_path = Path(
        _normalize_filesystem_path(str(destination_root or initials_root_path))
    )
    route_mode = "matched"
    recognized_initials = True
    route_reason = "matched"
    unnamed_folder = next(
        (folder for folder in initial_dirs if folder.name.strip().lower() == "unnamed"),
        None,
    )
    unnamed_available = unnamed_folder is not None
    available_initials_preview = _preview_router_initial_dirs(initial_dirs)

    if matched_initials_dir is None:
        if unnamed_folder is not None:
            matched_initials = unnamed_folder.name
            matched_initials_dir = unnamed_folder
            route_mode = "unnamed"
            recognized_initials = False
            route_reason = "unnamed-fallback"

    if matched_initials_dir is None:
        return {
            "matched": False,
            "initials": None,
            "recognized_initials": False,
            "route_mode": "unmatched",
            "route_reason": "no-match-no-unnamed",
            "normalized_run_name": normalized_run_name,
            "unnamed_available": unnamed_available,
            "available_initials_preview": available_initials_preview,
            "initials_root": str(initials_root_path),
            "matched_initials_dir": None,
            "destination_dir": None,
            "destination_path": None,
            "destination_exists": False,
        }

    relative_dir = matched_initials_dir.relative_to(initials_root_path)
    destination_dir = destination_root_path.joinpath(*relative_dir.parts)
    destination_path = destination_dir / source_folder.name

    return {
        "matched": True,
        "initials": matched_initials,
        "recognized_initials": recognized_initials,
        "route_mode": route_mode,
        "route_reason": route_reason,
        "normalized_run_name": normalized_run_name,
        "unnamed_available": unnamed_available,
        "available_initials_preview": available_initials_preview,
        "initials_root": str(initials_root_path),
        "matched_initials_dir": str(matched_initials_dir),
        "destination_dir": str(destination_dir),
        "destination_path": str(destination_path),
        "destination_exists": destination_path.exists(),
    }


def _scan_run_router(
    source_path: Union[str, Path],
    initials_root: Union[str, Path],
    destination_root: Optional[Union[str, Path]] = None,
    recursive: bool = True,
    limit: int = 200,
    monitor_recent_days: int = 0,
) -> dict:
    source_root, scan_roots, monitor_date_tokens = _resolve_run_router_scan_roots(
        source_path,
        monitor_recent_days=monitor_recent_days,
    )
    initials_root_path, initials_dirs = _list_router_initial_dirs(initials_root)
    destination_root_path = Path(_normalize_filesystem_path(str(destination_root or initials_root_path)))
    log_path = _maybe_log_router_scan_window(
        source_root,
        scan_roots,
        initials_root_path,
        destination_root_path,
        recursive=recursive,
        monitor_recent_days=monitor_recent_days,
        monitor_date_tokens=monitor_date_tokens,
    )

    items = []
    in_progress_count = 0
    wash_count = 0
    ready_count = 0
    copied_count = 0
    unmatched_count = 0
    unnamed_count = 0

    seen_paths = set()
    for scan_root in scan_roots:
        for folder in _iter_d_folder_paths(scan_root, recursive=recursive):
            if _is_ignored_router_sample_path(folder):
                continue
            normalized_folder = str(folder)
            if normalized_folder in seen_paths:
                continue
            seen_paths.add(normalized_folder)

            run_state = _inspect_sample_run_state(folder)
            if run_state.get("is_wash_position"):
                wash_count += 1
                continue
            if run_state.get("run_in_progress"):
                in_progress_count += 1

            route = _build_router_destination(
                folder,
                initials_root_path,
                destination_root_path,
                initials_dirs=initials_dirs,
            )
            latest_mtime = float(run_state.get("latest_mtime") or 0.0)
            latest_iso = (
                datetime.datetime.fromtimestamp(latest_mtime).isoformat()
                if latest_mtime > 0
                else None
            )
            status = "unmatched"
            if run_state.get("run_failed"):
                status = "failed"
            elif not run_state.get("run_complete"):
                status = "running"
            elif route["matched"]:
                status = "already-copied" if route["destination_exists"] else "ready"

            item = {
                "name": folder.name,
                "path": normalized_folder,
                "latest_mtime": latest_mtime,
                "latest_mtime_iso": latest_iso,
                "run_in_progress": bool(run_state.get("run_in_progress")),
                "run_complete": bool(run_state.get("run_complete")),
                "run_failed": bool(run_state.get("run_failed")),
                "sample_location": run_state.get("sample_location"),
                "completion_source": run_state.get("completion_source"),
                "run_log_last_line": run_state.get("run_log_last_line"),
                "initials": route["initials"],
                "matched": route["matched"],
                "recognized_initials": route.get("recognized_initials", False),
                "route_mode": route.get("route_mode", "unmatched"),
                "route_reason": route.get("route_reason"),
                "normalized_run_name": route.get("normalized_run_name"),
                "unnamed_available": route.get("unnamed_available"),
                "available_initials_preview": route.get("available_initials_preview"),
                "initials_root": route.get("initials_root"),
                "matched_initials_dir": route["matched_initials_dir"],
                "destination_dir": route["destination_dir"],
                "destination_path": route["destination_path"],
                "destination_exists": route["destination_exists"],
                "status": status,
            }
            items.append(item)
            _maybe_log_router_scan_item(item)

            if status == "ready":
                ready_count += 1
            elif status == "already-copied":
                copied_count += 1
            elif status == "unmatched":
                unmatched_count += 1
            if route.get("route_mode") == "unnamed":
                unnamed_count += 1

    items.sort(key=lambda item: item.get("latest_mtime") or 0.0, reverse=True)
    if limit > 0:
        items = items[:limit]

    return {
        "source_path": str(source_root),
        "scan_roots": [str(path) for path in scan_roots],
        "initials_root": str(initials_root_path),
        "destination_root": str(destination_root_path),
        "recursive": bool(recursive),
        "monitor_recent_days": max(0, int(monitor_recent_days)),
        "monitor_date_tokens": monitor_date_tokens,
        "log_path": log_path,
        "items": items,
        "summary": {
            "shown": len(items),
            "ready": ready_count,
            "already_copied": copied_count,
            "unmatched": unmatched_count,
            "unnamed": unnamed_count,
            "in_progress": in_progress_count,
            "wash": wash_count,
        },
    }


def _copy_router_folder(source_folder: Path, destination_path: Path) -> None:
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S%f")
    temp_destination = destination_path.with_name(f"{destination_path.name}.copying-{timestamp}")

    try:
        shutil.copytree(source_folder, temp_destination, copy_function=shutil.copy2)
        temp_destination.replace(destination_path)
        _preserve_router_tree_timestamps(source_folder, destination_path)
    except Exception:
        shutil.rmtree(temp_destination, ignore_errors=True)
        raise


def _source_creation_time_ns(stat_result: os.stat_result) -> Optional[int]:
    birth_ns = getattr(stat_result, "st_birthtime_ns", None)
    if birth_ns is not None and int(birth_ns) > 0:
        return int(birth_ns)

    if sys.platform == "win32":
        ctime_ns = getattr(stat_result, "st_ctime_ns", None)
        if ctime_ns is not None and int(ctime_ns) > 0:
            return int(ctime_ns)

    return None


def _set_windows_creation_time(path: Path, created_ns: int) -> None:
    if sys.platform != "win32" or created_ns <= 0:
        return

    import ctypes
    from ctypes import wintypes

    class FILETIME(ctypes.Structure):
        _fields_ = [
            ("dwLowDateTime", wintypes.DWORD),
            ("dwHighDateTime", wintypes.DWORD),
        ]

    filetime_value = int(created_ns // 100) + 116444736000000000
    creation_time = FILETIME(
        dwLowDateTime=filetime_value & 0xFFFFFFFF,
        dwHighDateTime=(filetime_value >> 32) & 0xFFFFFFFF,
    )

    flags = 0x02000000 if path.is_dir() else 0
    desired_access = 0x0100
    share_mode = 0x00000001 | 0x00000002 | 0x00000004
    open_existing = 3

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.CreateFileW(
        str(path),
        desired_access,
        share_mode,
        None,
        open_existing,
        flags,
        None,
    )

    invalid_handle = ctypes.c_void_p(-1).value
    if handle == invalid_handle:
        raise OSError(ctypes.get_last_error(), f"CreateFileW failed for {path}")

    try:
        if not kernel32.SetFileTime(handle, ctypes.byref(creation_time), None, None):
            raise OSError(ctypes.get_last_error(), f"SetFileTime failed for {path}")
    finally:
        kernel32.CloseHandle(handle)


def _set_macos_creation_time(path: Path, created_ns: int) -> None:
    if sys.platform != "darwin" or created_ns <= 0:
        return

    setfile_path = shutil.which("SetFile")
    if not setfile_path:
        raise FileNotFoundError("SetFile not available")

    created_dt = datetime.datetime.fromtimestamp(created_ns / 1_000_000_000)
    formatted = created_dt.strftime("%m/%d/%Y %H:%M:%S")
    subprocess.run(
        [setfile_path, "-d", formatted, str(path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _copy_path_timestamps(source_path: Path, destination_path: Path) -> None:
    try:
        source_stat = source_path.stat(follow_symlinks=False)
    except OSError:
        return

    try:
        os.utime(
            destination_path,
            ns=(int(source_stat.st_atime_ns), int(source_stat.st_mtime_ns)),
            follow_symlinks=False,
        )
    except Exception:
        pass

    created_ns = _source_creation_time_ns(source_stat)
    if created_ns is None:
        return

    try:
        if sys.platform == "win32":
            _set_windows_creation_time(destination_path, created_ns)
        elif sys.platform == "darwin":
            _set_macos_creation_time(destination_path, created_ns)
    except Exception:
        pass


def _preserve_router_tree_timestamps(source_root: Path, destination_root: Path) -> None:
    file_pairs: list[tuple[Path, Path]] = []
    dir_pairs: list[tuple[Path, Path]] = [(source_root, destination_root)]

    for current_root, dirs, files in os.walk(source_root):
        source_dir = Path(current_root)
        relative_root = source_dir.relative_to(source_root)
        destination_dir = destination_root / relative_root if relative_root.parts else destination_root

        for filename in files:
            source_file = source_dir / filename
            destination_file = destination_dir / filename
            if destination_file.exists():
                file_pairs.append((source_file, destination_file))

        for dirname in dirs:
            source_subdir = source_dir / dirname
            destination_subdir = destination_dir / dirname
            if destination_subdir.exists():
                dir_pairs.append((source_subdir, destination_subdir))

    for source_file, destination_file in file_pairs:
        _copy_path_timestamps(source_file, destination_file)

    for source_dir, destination_dir in sorted(dir_pairs, key=lambda pair: len(pair[0].parts), reverse=True):
        _copy_path_timestamps(source_dir, destination_dir)


def _resolve_node_command() -> Optional[str]:
    preferred = os.environ.get("LCMS_NODE")
    candidates = []
    if preferred:
        candidates.append(preferred)
    candidates.extend(["node", "nodejs"])

    for candidate in candidates:
        if not candidate:
            continue
        candidate_path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if not candidate_path:
            continue
        try:
            _kw = {}
            if sys.platform == "win32":
                _kw["creationflags"] = subprocess.CREATE_NO_WINDOW
            # When the candidate is the Electron binary (set via LCMS_NODE), we must
            # set ELECTRON_RUN_AS_NODE=1 so Electron acts as a Node.js runtime instead
            # of launching the GUI app (which on macOS causes a brief window flash and
            # a non-zero exit code, causing this check to incorrectly reject it).
            check_env = None
            if candidate == preferred and preferred:
                check_env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
            check = subprocess.run(
                [candidate_path, "--version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=5,
                env=check_env,
                **_kw,
            )
            if check.returncode == 0:
                return candidate_path
        except Exception:
            continue
    return None


def _compute_smiles_properties(smiles: str) -> dict:
    node_cmd = _resolve_node_command()
    if not node_cmd:
        raise HTTPException(status_code=500, detail="Node.js runtime not available for SMILES calculation")

    smiles = str(smiles or "").strip()
    if not smiles:
        raise HTTPException(status_code=400, detail="smiles is required")

    env = dict(os.environ)
    node_modules_dir = env.get("LCMS_NODE_MODULES", "").strip()
    if node_modules_dir and os.path.isdir(node_modules_dir):
        existing_node_path = env.get("NODE_PATH", "")
        env["NODE_PATH"] = f"{node_modules_dir}{os.pathsep}{existing_node_path}" if existing_node_path else node_modules_dir

    if env.get("LCMS_NODE") and os.path.abspath(node_cmd) == os.path.abspath(env["LCMS_NODE"]):
        env["ELECTRON_RUN_AS_NODE"] = "1"

    if node_modules_dir and os.path.isdir(node_modules_dir):
        run_cwd = os.path.dirname(node_modules_dir)
    else:
        project_root = os.path.abspath(os.path.join(BACKEND_DIR, ".."))
        run_cwd = project_root if os.path.isdir(os.path.join(project_root, "node_modules")) else BACKEND_DIR

    node_script = r"""
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(chunks.join('') || '{}');
    const smiles = String(payload.smiles || '').trim();
    if (!smiles) throw new Error('smiles is required');

    const mod = await import('openchemlib');
    const OCL = mod.default || mod;
    let mol;
    try {
      mol = OCL.Molecule.fromSmiles(smiles);
    } catch (e) {
      throw new Error('Invalid SMILES syntax');
    }
    if (!mol) throw new Error('Could not parse SMILES');

    const mf = mol.getMolecularFormula();
    const exactMass = Number(mf.absoluteWeight);
    if (!Number.isFinite(exactMass) || exactMass <= 0) {
      throw new Error('Unable to calculate molecular mass');
    }

    let netCharge = 0;
    const atomCount = Number(mol.getAllAtoms?.()) || 0;
    for (let i = 0; i < atomCount; i++) {
      netCharge += Number(mol.getAtomCharge?.(i)) || 0;
    }

    process.stdout.write(JSON.stringify({
      formula: String(mf.formula || ''),
      exact_mass: exactMass,
      net_charge: netCharge
    }));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(msg);
    process.exit(1);
  }
});
"""

    try:
        # On Windows, hide the subprocess console window to avoid a white flash
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(
            [node_cmd, "-e", node_script],
            input=json.dumps({"smiles": smiles}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=run_cwd,
            env=env,
            timeout=20,
            **kwargs,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="SMILES calculation timed out")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SMILES calculation failed: {exc}")

    if result.returncode != 0:
        err = (result.stderr or "").strip() or (result.stdout or "").strip() or "Unknown SMILES calculation error"
        raise HTTPException(status_code=400, detail=err)

    try:
        parsed = json.loads(result.stdout or "{}")
    except Exception:
        raise HTTPException(status_code=500, detail="Invalid SMILES calculator response")

    formula = str(parsed.get("formula", ""))
    exact_mass = float(parsed.get("exact_mass", 0.0))
    net_charge = int(parsed.get("net_charge", 0))
    if not np.isfinite(exact_mass) or exact_mass <= 0:
        raise HTTPException(status_code=400, detail="Unable to calculate molecular mass from this SMILES")

    return {
        "formula": formula,
        "exact_mass": exact_mass,
        "net_charge": net_charge,
    }


def _detect_deconvolution_window_for_sample(sample: SampleData) -> tuple[float, float]:
    """Auto-detect default deconvolution time window (webapp parity)."""
    if sample.ms_times is None or len(sample.ms_times) == 0:
        return 0.0, 0.0

    min_time = float(sample.ms_times[0])
    max_time = float(sample.ms_times[-1])

    if sample.tic is None:
        return min_time, min(min_time + 1.0, max_time)

    tic_smoothed = analysis.smooth_data(sample.tic, 5)
    peaks = analysis.find_peaks(sample.ms_times, tic_smoothed, height_threshold=0.3, prominence=0.1)
    if not peaks:
        return min_time, min(min_time + 1.0, max_time)

    is_c4 = getattr(sample, "is_c4_method", False)
    if is_c4:
        protein_peaks = [p for p in peaks if p["time"] >= 1.8]
        if protein_peaks:
            peaks = protein_peaks

    dominant = max(peaks, key=lambda p: p["intensity"])
    threshold = float(dominant["intensity"]) * 0.48

    left_idx = int(dominant["index"])
    while left_idx > 0 and tic_smoothed[left_idx] > threshold:
        left_idx -= 1

    right_idx = int(dominant["index"])
    while right_idx < len(tic_smoothed) - 1 and tic_smoothed[right_idx] > threshold:
        right_idx += 1

    auto_start = float(sample.ms_times[left_idx])
    auto_end = float(sample.ms_times[right_idx])

    max_window_width = 0.30
    if auto_end > auto_start and (auto_end - auto_start) > max_window_width:
        peak_time = float(sample.ms_times[int(dominant["index"])])
        half_width = max_window_width / 2.0
        auto_start = max(min_time, peak_time - half_width)
        auto_end = min(max_time, peak_time + half_width)

    return auto_start, auto_end


def _filter_spectrum_by_min_input_mz(
    mz_arr: np.ndarray,
    intensity_arr: np.ndarray,
    min_input_mz: float,
) -> tuple[np.ndarray, np.ndarray]:
    if mz_arr is None or intensity_arr is None:
        return np.array([]), np.array([])

    try:
        floor = max(0.0, float(min_input_mz))
    except Exception:
        floor = DEFAULT_DECONV_MIN_INPUT_MZ
    mz_values = np.asarray(mz_arr, dtype=float)
    intensity_values = np.asarray(intensity_arr, dtype=float)
    if floor <= 0:
        return mz_values, intensity_values

    mask = mz_values >= floor
    return mz_values[mask], intensity_values[mask]


def _get_default_deconvolution_parameters() -> dict[str, Union[int, float, bool]]:
    return {
        "min_charge": DEFAULT_DECONV_MIN_CHARGE,
        "max_charge": DEFAULT_DECONV_MAX_CHARGE,
        "min_peaks": DEFAULT_DECONV_MIN_PEAKS,
        "mw_agreement": DEFAULT_DECONV_MW_AGREEMENT,
        "contig_min": DEFAULT_DECONV_CONTIG_MIN,
        "abundance_cutoff": DEFAULT_DECONV_ABUNDANCE_CUTOFF,
        "envelope_cutoff": DEFAULT_DECONV_ENVELOPE_CUTOFF,
        "max_overlap": DEFAULT_DECONV_MAX_OVERLAP,
        "pwhh": DEFAULT_DECONV_PWHH,
        "noise_cutoff": DEFAULT_DECONV_NOISE_CUTOFF,
        "min_input_mz": DEFAULT_DECONV_MIN_INPUT_MZ,
        "low_mw": DEFAULT_DECONV_LOW_MW,
        "high_mw": DEFAULT_DECONV_HIGH_MW,
        "mw_assign_cutoff": DEFAULT_DECONV_MW_ASSIGN_CUTOFF,
        "use_mz_agreement": DEFAULT_DECONV_USE_MZ_AGREEMENT,
        "use_monoisotopic": DEFAULT_DECONV_USE_MONOISOTOPIC,
        "include_singly_charged": DEFAULT_DECONV_INCLUDE_SINGLY_CHARGED,
    }


def _normalize_deconvolution_parameters(raw_params: Optional[dict]) -> dict[str, Union[int, float, bool]]:
    raw = raw_params if isinstance(raw_params, dict) else {}
    params = _get_default_deconvolution_parameters()

    params["min_charge"] = max(1, _coerce_int(raw.get("min_charge"), int(params["min_charge"])))
    params["max_charge"] = max(2, _coerce_int(raw.get("max_charge"), int(params["max_charge"])))
    params["min_peaks"] = max(2, min(10, _coerce_int(raw.get("min_peaks"), int(params["min_peaks"]))))
    params["mw_agreement"] = max(0.0, _coerce_float(raw.get("mw_agreement"), float(params["mw_agreement"])))
    params["contig_min"] = max(2, _coerce_int(raw.get("contig_min"), int(params["contig_min"])))
    params["abundance_cutoff"] = max(0.0, _coerce_float(raw.get("abundance_cutoff"), float(params["abundance_cutoff"])))
    params["envelope_cutoff"] = max(
        0.0,
        _coerce_float(raw.get("envelope_cutoff", raw.get("r2_cutoff")), float(params["envelope_cutoff"])),
    )
    params["max_overlap"] = max(0.0, _coerce_float(raw.get("max_overlap"), float(params["max_overlap"])))
    params["pwhh"] = max(0.05, _coerce_float(raw.get("pwhh", raw.get("fwhm")), float(params["pwhh"])))
    params["noise_cutoff"] = max(0.0, _coerce_float(raw.get("noise_cutoff"), float(params["noise_cutoff"])))
    params["min_input_mz"] = max(0.0, _coerce_float(raw.get("min_input_mz"), float(params["min_input_mz"])))
    params["low_mw"] = max(0.0, _coerce_float(raw.get("low_mw", raw.get("mass_range_low")), float(params["low_mw"])))
    params["high_mw"] = max(params["low_mw"], _coerce_float(raw.get("high_mw", raw.get("mass_range_high")), float(params["high_mw"])))
    params["mw_assign_cutoff"] = max(0.0, _coerce_float(raw.get("mw_assign_cutoff"), float(params["mw_assign_cutoff"])))
    params["use_mz_agreement"] = _coerce_bool(raw.get("use_mz_agreement"), bool(params["use_mz_agreement"]))
    params["use_monoisotopic"] = _coerce_bool(
        raw.get("use_monoisotopic", raw.get("monoisotopic")),
        bool(params["use_monoisotopic"]),
    )
    params["include_singly_charged"] = _coerce_bool(
        raw.get("include_singly_charged"),
        bool(params["include_singly_charged"]),
    )
    return params


def _serialize_deconvolution_components(components: list[dict]) -> list[dict]:
    results = []
    for comp in components or []:
        results.append({
            "mass": float(comp.get("mass", 0)),
            "mass_std": float(comp.get("mass_std", 0)),
            "intensity": float(comp.get("intensity", 0)),
            "num_charges": int(comp.get("num_charges", 0)),
            "charge_states": comp.get("charge_states", []),
            "peaks_found": int(comp.get("peaks_found", 0)),
            "r2": float(comp.get("r2", 0)),
            "ion_mzs": comp.get("ion_mzs", []),
            "ion_charges": comp.get("ion_charges", []),
            "ion_intensities": comp.get("ion_intensities", []),
        })
    return results


def _sort_serialized_deconvolution_results(results: list[dict]) -> list[dict]:
    serialized = _serialize_deconvolution_components(results)
    serialized.sort(key=lambda comp: float(comp.get("intensity", 0) or 0), reverse=True)
    return serialized


def _run_report_deconvolution(
    mz_arr: np.ndarray,
    intensity_arr: np.ndarray,
    raw_params: Optional[dict] = None,
) -> list[dict]:
    """Run report deconvolution using the current deconvolution-tab parameters."""
    if mz_arr is None or intensity_arr is None or len(mz_arr) == 0:
        return []

    params = _normalize_deconvolution_parameters(raw_params)
    mz_arr, intensity_arr = _filter_spectrum_by_min_input_mz(
        mz_arr,
        intensity_arr,
        float(params["min_input_mz"]),
    )
    if len(mz_arr) == 0:
        return []

    low_mw = float(params["low_mw"])
    high_mw = float(params["high_mw"])
    effective_max_charge = int(params["max_charge"])
    if high_mw > DEFAULT_DECONV_HIGH_MW:
        effective_max_charge = max(effective_max_charge, int(np.ceil(high_mw / 1000.0)))
    effective_max_charge = max(2, min(100, effective_max_charge))

    components = analysis.deconvolute_protein_local_lcms_machine_like(
        mz_arr,
        intensity_arr,
        min_charge=max(int(params["min_charge"]), 2),
        max_charge=effective_max_charge,
        min_peaks=int(params["min_peaks"]),
        noise_cutoff=float(params["noise_cutoff"]),
        abundance_cutoff=float(params["abundance_cutoff"]),
        mw_agreement=float(params["mw_agreement"]),
        mw_assign_cutoff=float(params["mw_assign_cutoff"]),
        envelope_cutoff=float(params["envelope_cutoff"]),
        max_overlap=float(params["max_overlap"]),
        pwhh=float(params["pwhh"]),
        low_mw=low_mw,
        high_mw=high_mw,
        contig_min=int(params["contig_min"]),
        use_mz_agreement=bool(params["use_mz_agreement"]),
        use_monoisotopic_proton=bool(params["use_monoisotopic"]),
    )

    if bool(params["include_singly_charged"]) and int(params["min_charge"]) <= 1:
        exclude_ranges = []
        for comp in components:
            mzs = comp.get("ion_mzs", [])
            if mzs:
                exclude_ranges.append((min(mzs) - 2.0, max(mzs) + 2.0))

        singly = analysis.detect_singly_charged(
            mz_arr,
            intensity_arr,
            noise_cutoff=float(params["noise_cutoff"]),
            low_mw=low_mw,
            high_mw=min(high_mw, 2000.0),
            pwhh=float(params["pwhh"]),
            exclude_mz_ranges=exclude_ranges,
            use_monoisotopic_proton=bool(params["use_monoisotopic"]),
        )
        components.extend(singly)

    results = _serialize_deconvolution_components(components)
    filtered = [r for r in results if low_mw <= r["mass"] <= high_mw]
    filtered.sort(key=lambda c: c["intensity"], reverse=True)
    return _sort_serialized_deconvolution_results(filtered)


def _format_deconvolution_parameters_for_report(raw_params: Optional[dict]) -> dict[str, str]:
    params = _normalize_deconvolution_parameters(raw_params)
    return {
        "Mass range": f"{float(params['low_mw']):,.0f} - {float(params['high_mw']):,.0f} Da",
        "Charge range": f"{int(params['min_charge'])} - {int(params['max_charge'])}",
        "Minimum ions": str(int(params["min_peaks"])),
        "MW agreement": f"{float(params['mw_agreement']) * 100:.2f}%",
        "Contiguity min": str(int(params["contig_min"])),
        "Abundance cutoff": f"{float(params['abundance_cutoff']) * 100:.1f}%",
        "Envelope R²": f"{float(params['envelope_cutoff']) * 100:.1f}%",
        "Peak width FWHM": f"{float(params['pwhh']):.2f}",
        "Minimum input m/z": f"{float(params['min_input_mz']):.0f}",
        "Noise cutoff": f"{float(params['noise_cutoff']):,.0f} counts",
        "Monoisotopic proton": "On" if bool(params["use_monoisotopic"]) else "Off",
    }




def _subtract_chromatograms(
    sample_times,
    sample_intensities,
    background_times,
    background_intensities,
) -> tuple[np.ndarray, np.ndarray]:
    """Align the background signal onto the sample time axis and subtract it."""
    sample_times_arr = np.asarray(sample_times if sample_times is not None else [], dtype=float)
    sample_int_arr = np.asarray(sample_intensities if sample_intensities is not None else [], dtype=float)
    if sample_times_arr.size == 0 or sample_int_arr.size == 0:
        return np.array([], dtype=float), np.array([], dtype=float)

    sample_len = min(sample_times_arr.size, sample_int_arr.size)
    sample_times_arr = sample_times_arr[:sample_len]
    sample_int_arr = sample_int_arr[:sample_len]

    background_times_arr = np.asarray(background_times if background_times is not None else [], dtype=float)
    background_int_arr = np.asarray(background_intensities if background_intensities is not None else [], dtype=float)
    if background_times_arr.size == 0 or background_int_arr.size == 0:
        return sample_times_arr, sample_int_arr

    background_len = min(background_times_arr.size, background_int_arr.size)
    background_times_arr = background_times_arr[:background_len]
    background_int_arr = background_int_arr[:background_len]
    if background_times_arr.size == 0:
        return sample_times_arr, sample_int_arr

    sample_order = np.argsort(sample_times_arr)
    sample_times_arr = sample_times_arr[sample_order]
    sample_int_arr = sample_int_arr[sample_order]

    background_order = np.argsort(background_times_arr)
    background_times_arr = background_times_arr[background_order]
    background_int_arr = background_int_arr[background_order]

    background_times_arr, unique_idx = np.unique(background_times_arr, return_index=True)
    background_int_arr = background_int_arr[unique_idx]

    aligned_background = np.interp(
        sample_times_arr,
        background_times_arr,
        background_int_arr,
        left=0.0,
        right=0.0,
    )
    return sample_times_arr, sample_int_arr - aligned_background


def _subtract_spectra(
    sample_mz,
    sample_intensities,
    background_mz,
    background_intensities,
) -> tuple[np.ndarray, np.ndarray]:
    """Align the background spectrum onto the sample m/z axis and subtract it."""
    sample_mz_arr = np.asarray(sample_mz if sample_mz is not None else [], dtype=float)
    sample_int_arr = np.asarray(sample_intensities if sample_intensities is not None else [], dtype=float)
    if sample_mz_arr.size == 0 or sample_int_arr.size == 0:
        return np.array([], dtype=float), np.array([], dtype=float)

    sample_len = min(sample_mz_arr.size, sample_int_arr.size)
    sample_mz_arr = sample_mz_arr[:sample_len]
    sample_int_arr = sample_int_arr[:sample_len]

    background_mz_arr = np.asarray(background_mz if background_mz is not None else [], dtype=float)
    background_int_arr = np.asarray(background_intensities if background_intensities is not None else [], dtype=float)
    if background_mz_arr.size == 0 or background_int_arr.size == 0:
        return sample_mz_arr, sample_int_arr

    background_len = min(background_mz_arr.size, background_int_arr.size)
    background_mz_arr = background_mz_arr[:background_len]
    background_int_arr = background_int_arr[:background_len]
    if background_mz_arr.size == 0:
        return sample_mz_arr, sample_int_arr

    sample_order = np.argsort(sample_mz_arr)
    sample_mz_arr = sample_mz_arr[sample_order]
    sample_int_arr = sample_int_arr[sample_order]

    background_order = np.argsort(background_mz_arr)
    background_mz_arr = background_mz_arr[background_order]
    background_int_arr = background_int_arr[background_order]

    background_mz_arr, unique_idx = np.unique(background_mz_arr, return_index=True)
    background_int_arr = background_int_arr[unique_idx]

    aligned_background = np.interp(
        sample_mz_arr,
        background_mz_arr,
        background_int_arr,
        left=0.0,
        right=0.0,
    )
    return sample_mz_arr, sample_int_arr - aligned_background


def _get_channel_ms_data(sample: SampleData, polarity: Optional[str]) -> tuple:
    """Return channel-specific MS arrays, falling back to the generic alias if needed."""
    if polarity == "negative" and sample.ms_times_neg is not None and sample.ms_scans_neg is not None:
        return sample.ms_times_neg, sample.ms_scans_neg, sample.ms_mz_axis_neg, sample.tic_neg
    if polarity == "positive" and sample.ms_times_pos is not None and sample.ms_scans_pos is not None:
        return sample.ms_times_pos, sample.ms_scans_pos, sample.ms_mz_axis_pos, sample.tic_pos
    return sample.ms_times, sample.ms_scans, sample.ms_mz_axis, sample.tic


def _select_shared_ms_polarity(sample: SampleData, background: SampleData) -> Optional[str]:
    """Choose one polarity that both samples can compare directly, preferring positive."""
    if sample.ms_times_pos is not None and background.ms_times_pos is not None:
        return "positive"
    if sample.ms_times_neg is not None and background.ms_times_neg is not None:
        return "negative"
    if sample.ms_times_pos is not None:
        return "positive"
    if sample.ms_times_neg is not None:
        return "negative"
    return None


def _get_shared_ms_polarities(sample: SampleData, background: SampleData) -> list[str]:
    """Return the shared MS polarities available in both files, preferring positive first."""
    polarities = []
    if sample.ms_times_pos is not None and background.ms_times_pos is not None:
        polarities.append("positive")
    if sample.ms_times_neg is not None and background.ms_times_neg is not None:
        polarities.append("negative")
    if polarities:
        return polarities

    fallback = _select_shared_ms_polarity(sample, background)
    return [fallback] if fallback else []


def _sum_spectra_for_polarity(
    sample: SampleData,
    start_time: float,
    end_time: float,
    polarity: Optional[str],
) -> tuple[np.ndarray, np.ndarray]:
    """Sum mass spectra within a time range for the requested polarity."""
    times, scans, mz_axis, _ = _get_channel_ms_data(sample, polarity)
    if scans is None or times is None:
        return np.array([]), np.array([])

    time_mask = (times >= start_time) & (times <= end_time)
    scan_indices = np.where(time_mask)[0]
    if len(scan_indices) == 0:
        return np.array([]), np.array([])

    if mz_axis is not None:
        summed_intensities = np.zeros(len(mz_axis))
        for idx in scan_indices:
            scan = scans[idx]
            if scan is not None and isinstance(scan, np.ndarray):
                summed_intensities += scan
        return np.asarray(mz_axis, dtype=float), summed_intensities

    all_mz = []
    all_int = []
    for idx in scan_indices:
        scan = scans[idx]
        if scan is None:
            continue

        mz = None
        intensity = None
        if hasattr(scan, "mz") and hasattr(scan, "intensity"):
            mz = np.array(scan.mz)
            intensity = np.array(scan.intensity)
        elif hasattr(scan, "masses") and hasattr(scan, "intensities"):
            mz = np.array(scan.masses)
            intensity = np.array(scan.intensities)
        elif isinstance(scan, np.ndarray) and scan.ndim == 2:
            mz = scan[:, 0]
            intensity = scan[:, 1]
        elif isinstance(scan, dict):
            mz = np.array(scan.get("mz", scan.get("masses", [])))
            intensity = np.array(scan.get("intensity", scan.get("intensities", [])))

        if mz is not None and intensity is not None and len(mz) > 0:
            all_mz.extend(mz)
            all_int.extend(intensity)

    if len(all_mz) == 0:
        return np.array([]), np.array([])

    all_mz = np.array(all_mz)
    all_int = np.array(all_int)
    mz_bins = np.round(all_mz, 1)
    unique_mz = np.unique(mz_bins)
    summed_intensities = np.zeros(len(unique_mz))
    for i, mz_val in enumerate(unique_mz):
        summed_intensities[i] = np.sum(all_int[mz_bins == mz_val])

    return unique_mz, summed_intensities


def _build_residual_ms_channel(
    sample: SampleData,
    background: SampleData,
    polarity: str,
    mz_window: float,
) -> Optional[dict]:
    """Build one residual MS channel summary for the requested polarity."""
    sample_channel_times, _, _, _ = _get_channel_ms_data(sample, polarity)
    background_channel_times, _, _, _ = _get_channel_ms_data(background, polarity)
    if sample_channel_times is None or len(sample_channel_times) <= 1:
        return None

    sample_mz, sample_intensities = _sum_spectra_for_polarity(
        sample,
        float(sample_channel_times[0]),
        float(sample_channel_times[-1]),
        polarity,
    )
    if background_channel_times is not None and len(background_channel_times) > 1:
        background_mz, background_intensities = _sum_spectra_for_polarity(
            background,
            float(background_channel_times[0]),
            float(background_channel_times[-1]),
            polarity,
        )
    else:
        background_mz, background_intensities = np.array([], dtype=float), np.array([], dtype=float)

    spectrum_mz, spectrum_intensities = _subtract_spectra(
        sample_mz,
        sample_intensities,
        background_mz,
        background_intensities,
    )
    if spectrum_mz.size == 0:
        return None

    channel = {
        "polarity": polarity,
        "spectrum": {
            "mz": _ndarray_to_list(spectrum_mz),
            "intensities": _ndarray_to_list(spectrum_intensities),
        },
        "spectrum_peaks": [],
    }

    positive_spectrum = np.maximum(spectrum_intensities, 0)
    if positive_spectrum.size == 0 or float(np.max(positive_spectrum)) <= 0:
        return channel

    detected_peaks = analysis.find_peaks(
        spectrum_mz,
        positive_spectrum,
        height_threshold=0.03,
        prominence=0.01,
    )
    candidate_mzs = []
    for peak in sorted(detected_peaks, key=lambda item: item.get("intensity", 0), reverse=True)[:80]:
        candidate_mzs.append(float(peak.get("time", 0.0)))

    strongest_rows = []
    for candidate_mz in candidate_mzs:
        sample_eic = analysis.extract_eic(sample, candidate_mz, mz_window, ion_mode=polarity)
        if sample_eic is None:
            continue
        background_eic = analysis.extract_eic(background, candidate_mz, mz_window, ion_mode=polarity)
        eic_times = sample.ms_times_neg if polarity == "negative" and sample.ms_times_neg is not None else (
            sample.ms_times_pos if sample.ms_times_pos is not None else sample.ms_times
        )
        bg_times = background.ms_times_neg if polarity == "negative" and background.ms_times_neg is not None else (
            background.ms_times_pos if background.ms_times_pos is not None else background.ms_times
        )
        sub_times, sub_intensities = _subtract_chromatograms(
            eic_times,
            sample_eic,
            bg_times,
            background_eic,
        )
        if sub_times.size == 0 or sub_intensities.size == 0:
            continue

        positive_trace = np.maximum(sub_intensities, 0)
        if positive_trace.size == 0:
            continue

        residual_peaks = analysis.find_peaks(
            sub_times,
            positive_trace,
            height_threshold=0.05,
            prominence=0.02,
        )

        if residual_peaks:
            best_peak = max(residual_peaks, key=lambda item: item.get("intensity", 0))
        else:
            max_idx = int(np.argmax(positive_trace))
            max_val = float(positive_trace[max_idx]) if positive_trace.size > 0 else 0.0
            if max_val <= 0:
                continue
            best_peak = {
                "time": float(sub_times[max_idx]),
                "intensity": max_val,
                "area": 0.0,
                "start_time": float(sub_times[max_idx]),
                "end_time": float(sub_times[max_idx]),
            }

        strongest_rows.append({
            "mz": candidate_mz,
            "polarity": polarity,
            "apex_time": float(best_peak.get("time", 0.0)),
            "intensity": float(best_peak.get("intensity", 0.0)),
            "area": float(best_peak.get("area", 0.0)),
            "start_time": float(best_peak.get("start_time", best_peak.get("time", 0.0))),
            "end_time": float(best_peak.get("end_time", best_peak.get("time", 0.0))),
        })

    strongest_rows = [row for row in strongest_rows if row["intensity"] > 0]
    strongest_rows.sort(key=lambda row: row["intensity"], reverse=True)
    if strongest_rows:
        max_apex = max(row["intensity"] for row in strongest_rows)
        for row in strongest_rows[:25]:
            row["relative_intensity"] = (row["intensity"] / max_apex) * 100.0 if max_apex > 0 else 0.0
            channel["spectrum_peaks"].append(row)

    return channel


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok", "version": lcms_config.APP_VERSION}


@app.get("/api/config")
def get_config():
    """Return app defaults so the frontend knows initial settings."""
    return {
        "version": lcms_config.APP_VERSION,
        "default_path": lcms_config.BASE_PATH,
        "uv_wavelength": lcms_config.UV_WAVELENGTH,
        "uv_smoothing": lcms_config.UV_SMOOTHING_WINDOW,
        "eic_smoothing": lcms_config.EIC_SMOOTHING_WINDOW,
        "mz_window": lcms_config.DEFAULT_MZ_WINDOW,
        "export_dpi": lcms_config.EXPORT_DPI,
    }


@app.get("/api/browse")
def browse_folder(
    path: str = Query(..., description="Directory to list"),
    include_state: bool = Query(False, description="Include run-state metadata for sample bundles"),
):
    """List contents of a directory, including supported sample bundles."""
    p = Path(_normalize_filesystem_path(path))
    if not p.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not p.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    items = []
    try:
        for entry in sorted(p.iterdir()):
            if entry.name.startswith("."):
                continue
            is_d = _is_supported_sample_folder(entry)
            item = {
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
                "is_d_folder": is_d,
            }
            if is_d and include_state:
                item.update(_inspect_sample_run_state(entry))
            items.append(item)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    return {"path": str(p), "items": items}


@app.get("/api/find-d-folders")
def find_d_folders(
    path: str = Query(...),
    search: str = Query("", description="Optional name filter"),
):
    """Recursively find supported sample folders under a path."""
    folders = list_d_folders(_normalize_filesystem_path(path), search)
    for f in folders:
        f["date"] = f["date"].isoformat()
    return {"folders": folders}


@app.get("/api/load-sample")
def load_sample(path: str = Query(..., description="Path to a supported sample folder")):
    """Load a sample and return its metadata."""
    normalized_path = _normalize_filesystem_path(path)
    sample = _get_sample(normalized_path)
    run_state = _inspect_sample_run_state(normalized_path)
    return {
        "name": sample.name,
        "folder_path": sample.folder_path,
        "is_c4_method": sample.is_c4_method,
        "acq_method": sample.acq_method,
        "acq_info": sample.acq_info,
        "has_uv": sample.uv_data is not None,
        "has_ms": sample.ms_scans is not None,
        "has_ms_pos": sample.ms_times_pos is not None,
        "has_ms_neg": sample.ms_times_neg is not None,
        "has_dual_polarity": sample.has_dual_polarity,
        "uv_wavelengths": _ndarray_to_list(sample.uv_wavelengths),
        "ms_time_range": [float(sample.ms_times[0]), float(sample.ms_times[-1])] if sample.ms_times is not None else None,
        "uv_time_range": [float(sample.uv_times[0]), float(sample.uv_times[-1])] if sample.uv_times is not None else None,
        "run_complete": run_state["run_complete"],
        "run_in_progress": run_state["run_in_progress"],
        "run_failed": run_state.get("run_failed", False),
        "cacheable": run_state["cacheable"],
        "completion_source": run_state["completion_source"],
        "sample_location": run_state["sample_location"],
        "is_wash_position": run_state["is_wash_position"],
        "latest_update": datetime.datetime.fromtimestamp(run_state["latest_mtime"]).isoformat() if run_state["latest_mtime"] else None,
    }


@app.get("/api/uv-chromatogram")
def uv_chromatogram(
    path: str = Query(...),
    wavelength: float = Query(280.0),
    smooth: int = Query(0, description="Smoothing window (0=off)"),
):
    """Return UV chromatogram data at a specific wavelength."""
    sample = _get_sample(path)
    uv = sample.get_uv_at_wavelength(wavelength)
    if uv is None:
        raise HTTPException(status_code=404, detail=f"No UV data at {wavelength} nm")

    times = _ndarray_to_list(sample.uv_times)
    intensities = _ndarray_to_list(analysis.smooth_data(uv, smooth) if smooth > 2 else uv)
    return {"times": times, "intensities": intensities, "wavelength": wavelength}


@app.get("/api/tic")
def tic(path: str = Query(...)):
    """Return total ion chromatogram. Returns both polarities if available."""
    sample = _get_sample(path)
    if sample.tic is None:
        raise HTTPException(status_code=404, detail="No MS data")
    result = {
        "times": _ndarray_to_list(sample.ms_times),
        "intensities": _ndarray_to_list(sample.tic),
        "has_dual_polarity": sample.has_dual_polarity,
    }
    if sample.has_dual_polarity:
        result["times_pos"] = _ndarray_to_list(sample.ms_times_pos)
        result["intensities_pos"] = _ndarray_to_list(sample.tic_pos)
        result["times_neg"] = _ndarray_to_list(sample.ms_times_neg)
        result["intensities_neg"] = _ndarray_to_list(sample.tic_neg)
    return result


@app.get("/api/eic")
def eic(
    path: str = Query(...),
    mz: float = Query(..., description="Target m/z"),
    window: float = Query(0.5),
    smooth: int = Query(0),
    ion_mode: str = Query("positive", description="positive or negative"),
):
    """Return extracted ion chromatogram."""
    sample = _get_sample(path)
    eic_data = analysis.extract_eic(sample, mz, window, ion_mode=ion_mode)
    if eic_data is None:
        raise HTTPException(status_code=404, detail="No MS data for EIC")

    if smooth > 2:
        eic_data = analysis.smooth_data(eic_data, smooth)

    # Return times from the matching polarity detector
    if ion_mode == 'negative' and sample.ms_times_neg is not None:
        times = sample.ms_times_neg
    else:
        times = sample.ms_times_pos if sample.ms_times_pos is not None else sample.ms_times

    return {
        "times": _ndarray_to_list(times),
        "intensities": _ndarray_to_list(eic_data),
        "target_mz": mz,
        "window": window,
        "ion_mode": ion_mode,
    }


@app.post("/api/background-subtraction")
def background_subtraction(payload: dict = Body(...)):
    """Subtract one selected sample from another across UV, TIC, and EIC traces."""
    sample_path = str(payload.get("sample_path") or "").strip()
    background_path = str(payload.get("background_path") or "").strip()
    if not sample_path or not background_path:
        raise HTTPException(status_code=400, detail="sample_path and background_path are required")
    if sample_path == background_path:
        raise HTTPException(status_code=400, detail="Choose two different files for background subtraction")

    sample = _get_sample(sample_path)
    background = _get_sample(background_path)

    uv_smoothing = _coerce_int(payload.get("uv_smoothing"), 0)
    eic_smoothing = _coerce_int(payload.get("eic_smoothing"), 0)
    mz_window = _coerce_float(payload.get("mz_window"), 0.5)

    requested_wavelengths = payload.get("wavelengths") or []
    uv_results = []
    for raw_wavelength in requested_wavelengths:
        try:
            wavelength = float(raw_wavelength)
        except Exception:
            continue

        sample_uv = sample.get_uv_at_wavelength(wavelength)
        if sample_uv is None or sample.uv_times is None:
            continue

        background_uv = background.get_uv_at_wavelength(wavelength)
        uv_times, uv_intensities = _subtract_chromatograms(
            sample.uv_times,
            sample_uv,
            background.uv_times,
            background_uv,
        )
        if uv_smoothing > 2 and uv_intensities.size > 0:
            uv_intensities = analysis.smooth_data(uv_intensities, uv_smoothing)

        uv_results.append({
            "nm": wavelength,
            "wavelength": wavelength,
            "times": _ndarray_to_list(uv_times),
            "intensities": _ndarray_to_list(uv_intensities),
        })

    tic_result = None
    if sample.has_dual_polarity and background.has_dual_polarity:
        pos_times, pos_intensities = _subtract_chromatograms(
            sample.ms_times_pos,
            sample.tic_pos,
            background.ms_times_pos,
            background.tic_pos,
        )
        neg_times, neg_intensities = _subtract_chromatograms(
            sample.ms_times_neg,
            sample.tic_neg,
            background.ms_times_neg,
            background.tic_neg,
        )
        if pos_times.size > 0 or neg_times.size > 0:
            tic_result = {
                "has_dual_polarity": True,
                "times_pos": _ndarray_to_list(pos_times),
                "intensities_pos": _ndarray_to_list(pos_intensities),
                "times_neg": _ndarray_to_list(neg_times),
                "intensities_neg": _ndarray_to_list(neg_intensities),
            }
    elif sample.tic is not None and sample.ms_times is not None:
        tic_times, tic_intensities = _subtract_chromatograms(
            sample.ms_times,
            sample.tic,
            background.ms_times,
            background.tic,
        )
        tic_result = {
            "times": _ndarray_to_list(tic_times),
            "intensities": _ndarray_to_list(tic_intensities),
            "has_dual_polarity": False,
        }

    raw_targets = payload.get("mz_targets") or payload.get("targets") or []
    eic_targets = []
    for raw_target in raw_targets:
        if isinstance(raw_target, dict):
            target_mz = _coerce_float(raw_target.get("mz", raw_target.get("target_mz")), float("nan"))
            polarity = str(raw_target.get("polarity") or raw_target.get("ion_mode") or "positive").strip().lower()
        else:
            target_mz = _coerce_float(raw_target, float("nan"))
            polarity = "positive"

        if not np.isfinite(target_mz) or target_mz <= 0:
            continue
        if polarity not in {"positive", "negative"}:
            polarity = "positive"

        sample_eic = analysis.extract_eic(sample, target_mz, mz_window, ion_mode=polarity)
        if sample_eic is None:
            continue

        background_eic = analysis.extract_eic(background, target_mz, mz_window, ion_mode=polarity)
        sample_times = sample.ms_times_neg if polarity == "negative" and sample.ms_times_neg is not None else (
            sample.ms_times_pos if sample.ms_times_pos is not None else sample.ms_times
        )
        background_times = background.ms_times_neg if polarity == "negative" and background.ms_times_neg is not None else (
            background.ms_times_pos if background.ms_times_pos is not None else background.ms_times
        )

        eic_times, eic_intensities = _subtract_chromatograms(
            sample_times,
            sample_eic,
            background_times,
            background_eic,
        )
        if eic_smoothing > 2 and eic_intensities.size > 0:
            eic_intensities = analysis.smooth_data(eic_intensities, eic_smoothing)

        eic_targets.append({
            "times": _ndarray_to_list(eic_times),
            "intensities": _ndarray_to_list(eic_intensities),
            "mz": target_mz,
            "target_mz": target_mz,
            "window": mz_window,
            "polarity": polarity,
            "ion_mode": polarity,
        })

    residual_channels = []
    for polarity in _get_shared_ms_polarities(sample, background):
        channel = _build_residual_ms_channel(sample, background, polarity, mz_window)
        if channel is not None:
            residual_channels.append(channel)

    first_residual_channel = residual_channels[0] if residual_channels else {}

    scan_count = int(len(sample.ms_times)) if sample.ms_times is not None else 0
    return {
        "sample_name": sample.name,
        "sample_path": sample.folder_path,
        "background_name": background.name,
        "background_path": background.folder_path,
        "uv": {"wavelengths": uv_results},
        "tic": tic_result,
        "eic": {"targets": eic_targets},
        "residual_channels": residual_channels,
        "spectrum": first_residual_channel.get("spectrum"),
        "spectrum_peaks": first_residual_channel.get("spectrum_peaks", []),
        "spectrum_polarity": first_residual_channel.get("polarity"),
        "ms_scan_count": scan_count,
    }


@app.get("/api/ms-spectrum")
def ms_spectrum(
    path: str = Query(...),
    time: float = Query(..., description="Retention time (min)"),
):
    """Return mass spectrum at a specific retention time."""
    sample = _get_sample(path)
    result = sample.get_ms_scan(time)
    if result is None:
        raise HTTPException(status_code=404, detail="No MS scan at this time")
    mz_arr, intensity_arr = result
    return {
        "mz": _ndarray_to_list(mz_arr),
        "intensities": _ndarray_to_list(intensity_arr),
        "time": time,
    }


@app.get("/api/summed-spectrum")
def summed_spectrum(
    path: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    polarity: Optional[str] = Query(None, description="positive, negative, or default channel"),
):
    """Return summed mass spectrum over a time range."""
    sample = _get_sample(path)
    normalized_polarity = str(polarity).strip().lower() if polarity is not None else None
    if normalized_polarity not in {"positive", "negative"}:
        normalized_polarity = None

    times, scans, mz_axis, _ = _get_channel_ms_data(sample, normalized_polarity)
    if scans is None or times is None:
        raise HTTPException(status_code=404, detail="No MS data")

    mz_arr, intensity_arr = analysis.sum_spectra_from_channel(times, scans, mz_axis, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra")

    return {
        "mz": _ndarray_to_list(mz_arr),
        "intensities": _ndarray_to_list(intensity_arr),
        "time_range": [start, end],
        "polarity": normalized_polarity,
    }


@app.get("/api/peaks")
def find_chromatogram_peaks(
    path: str = Query(...),
    data_type: str = Query("tic", description="tic, uv, or eic"),
    wavelength: float = Query(280.0),
    mz: float = Query(0.0),
    mz_window: float = Query(0.5),
    ion_mode: str = Query("positive", description="positive or negative"),
    smooth: int = Query(0),
    height_threshold: float = Query(0.1),
    prominence: float = Query(0.05),
):
    """Find peaks in a chromatogram (TIC, UV, or EIC)."""
    sample = _get_sample(path)

    if data_type == "tic":
        if sample.tic is None or sample.ms_times is None:
            raise HTTPException(status_code=404, detail="No TIC data")
        times = sample.ms_times
        intensities = sample.tic
    elif data_type == "uv":
        uv = sample.get_uv_at_wavelength(wavelength)
        if uv is None or sample.uv_times is None:
            raise HTTPException(status_code=404, detail=f"No UV data at {wavelength} nm")
        times = sample.uv_times
        intensities = uv
    elif data_type == "eic":
        normalized_ion_mode = str(ion_mode).strip().lower()
        if normalized_ion_mode not in {"positive", "negative"}:
            normalized_ion_mode = "positive"
        eic_data = analysis.extract_eic(sample, mz, mz_window, ion_mode=normalized_ion_mode)
        times = sample.ms_times_neg if normalized_ion_mode == "negative" and sample.ms_times_neg is not None else (
            sample.ms_times_pos if sample.ms_times_pos is not None else sample.ms_times
        )
        if eic_data is None or times is None:
            raise HTTPException(status_code=404, detail="No EIC data")
        intensities = eic_data
    else:
        raise HTTPException(status_code=400, detail=f"Unknown data_type: {data_type}")

    if smooth > 2:
        intensities = analysis.smooth_data(intensities, smooth)

    peaks = analysis.find_peaks(times, intensities, height_threshold, prominence)

    # Convert numpy types
    for p in peaks:
        for k, v in p.items():
            if isinstance(v, (np.floating, np.integer)):
                p[k] = float(v)

    return {"peaks": peaks}


@app.get("/api/peak-area")
def peak_area(
    path: str = Query(...),
    data_type: str = Query("eic"),
    mz: float = Query(0.0),
    mz_window: float = Query(0.5),
    ion_mode: str = Query("positive", description="positive or negative"),
    wavelength: float = Query(280.0),
    smooth: int = Query(0),
    start: float = Query(...),
    end: float = Query(...),
):
    """Calculate peak area for a given time window."""
    sample = _get_sample(path)

    if data_type == "tic":
        times, intensities = sample.ms_times, sample.tic
    elif data_type == "uv":
        times = sample.uv_times
        intensities = sample.get_uv_at_wavelength(wavelength)
    elif data_type == "eic":
        normalized_ion_mode = str(ion_mode).strip().lower()
        if normalized_ion_mode not in {"positive", "negative"}:
            normalized_ion_mode = "positive"
        times = sample.ms_times_neg if normalized_ion_mode == "negative" and sample.ms_times_neg is not None else (
            sample.ms_times_pos if sample.ms_times_pos is not None else sample.ms_times
        )
        intensities = analysis.extract_eic(sample, mz, mz_window, ion_mode=normalized_ion_mode)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown data_type: {data_type}")

    if times is None or intensities is None:
        raise HTTPException(status_code=404, detail="No data")

    if smooth > 2:
        intensities = analysis.smooth_data(intensities, smooth)

    area = analysis.calculate_peak_area(times, intensities, start, end)
    return {"area": float(area), "start": start, "end": end}


@app.get("/api/detect-deconv-window")
def detect_deconv_window(path: str = Query(...)):
    """Auto-detect the optimal deconvolution time window."""
    sample = _get_sample(path)
    auto_start, auto_end = _detect_deconvolution_window_for_sample(sample)
    if auto_end <= auto_start:
        raise HTTPException(status_code=404, detail="No MS time data")
    return {"start": auto_start, "end": auto_end}


@app.post("/api/smiles-mz")
def smiles_mz(payload: dict = Body(...)):
    """Calculate exact mass/formula/charge from SMILES using OpenChemLib in Node."""
    smiles = str((payload or {}).get("smiles", "")).strip()
    return _compute_smiles_properties(smiles)


@app.post("/api/deconvolute")
def deconvolute(
    path: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    min_charge: int = Query(DEFAULT_DECONV_MIN_CHARGE),
    max_charge: int = Query(DEFAULT_DECONV_MAX_CHARGE),
    min_peaks: int = Query(DEFAULT_DECONV_MIN_PEAKS),
    mw_agreement: float = Query(DEFAULT_DECONV_MW_AGREEMENT),
    contig_min: int = Query(DEFAULT_DECONV_CONTIG_MIN),
    abundance_cutoff: float = Query(DEFAULT_DECONV_ABUNDANCE_CUTOFF),
    envelope_cutoff: float = Query(DEFAULT_DECONV_ENVELOPE_CUTOFF),
    max_overlap: float = Query(DEFAULT_DECONV_MAX_OVERLAP),
    pwhh: float = Query(DEFAULT_DECONV_PWHH),
    noise_cutoff: float = Query(DEFAULT_DECONV_NOISE_CUTOFF),
    min_input_mz: float = Query(DEFAULT_DECONV_MIN_INPUT_MZ),
    low_mw: float = Query(DEFAULT_DECONV_LOW_MW),
    high_mw: float = Query(DEFAULT_DECONV_HIGH_MW),
    mw_assign_cutoff: float = Query(DEFAULT_DECONV_MW_ASSIGN_CUTOFF),
    use_mz_agreement: bool = Query(DEFAULT_DECONV_USE_MZ_AGREEMENT),
    use_monoisotopic: bool = Query(DEFAULT_DECONV_USE_MONOISOTOPIC),
    include_singly_charged: bool = Query(DEFAULT_DECONV_INCLUDE_SINGLY_CHARGED),
):
    """Run deconvolution on summed spectrum and return detected components."""
    sample = _get_sample(path)
    if sample.ms_scans is None:
        raise HTTPException(status_code=404, detail="No MS data")

    mz_arr, intensity_arr = analysis.sum_spectra_in_range(sample, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra")
    mz_arr, intensity_arr = _filter_spectrum_by_min_input_mz(mz_arr, intensity_arr, min_input_mz)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="No spectrum data remained above the minimum input m/z")

    # Agilent's "start charge maximum" can still yield envelopes above that
    # charge in high-mass windows; expand internal search for high mass limits.
    effective_max_charge = int(max_charge)
    if high_mw > 50000.0:
        effective_max_charge = max(effective_max_charge, int(np.ceil(high_mw / 1000.0)))
    effective_max_charge = max(2, min(100, effective_max_charge))

    # Run multi-charge deconvolution
    components = analysis.deconvolute_protein_local_lcms_machine_like(
        mz_arr,
        intensity_arr,
        min_charge=max(min_charge, 2),  # Multi-charge needs z>=2
        max_charge=effective_max_charge,
        min_peaks=max(2, min(10, int(min_peaks))),
        mw_agreement=mw_agreement,
        contig_min=contig_min,
        abundance_cutoff=abundance_cutoff,
        envelope_cutoff=envelope_cutoff,
        max_overlap=max_overlap,
        pwhh=pwhh,
        noise_cutoff=noise_cutoff,
        low_mw=low_mw,
        high_mw=high_mw,
        mw_assign_cutoff=mw_assign_cutoff,
        use_mz_agreement=use_mz_agreement,
        use_monoisotopic_proton=use_monoisotopic,
    )

    # Optionally detect singly charged species
    if include_singly_charged and min_charge <= 1:
        # Exclude m/z ranges already claimed by multi-charge envelopes
        exclude_ranges = []
        for comp in components:
            mzs = comp.get("ion_mzs", [])
            if mzs:
                exclude_ranges.append((min(mzs) - 2.0, max(mzs) + 2.0))

        singly = analysis.detect_singly_charged(
            mz_arr,
            intensity_arr,
            noise_cutoff=noise_cutoff,
            low_mw=low_mw,
            high_mw=min(high_mw, 2000.0),
            pwhh=pwhh,
            exclude_mz_ranges=exclude_ranges,
            use_monoisotopic_proton=use_monoisotopic,
        )
        components.extend(singly)

    # Serialize components
    results = _serialize_deconvolution_components(components)

    return {
        "components": results,
        "spectrum": {
            "mz": _ndarray_to_list(mz_arr),
            "intensities": _ndarray_to_list(intensity_arr),
        },
        "time_range": [start, end],
        "effective_max_charge": effective_max_charge,
    }


@app.get("/api/theoretical-mz")
def theoretical_mz(
    mass: float = Query(..., description="Neutral mass in Da"),
    min_charge: int = Query(1),
    max_charge: int = Query(50),
    use_monoisotopic: bool = Query(False),
):
    """Calculate theoretical m/z values for given mass and charge range."""
    charge_states = list(range(min_charge, max_charge + 1))
    results = analysis.get_theoretical_mz(mass, charge_states, use_monoisotopic)
    return {"mass": mass, "ions": results}


@app.get("/api/volumes")
def list_volumes():
    """List mounted volumes / drives for quick navigation."""
    import platform
    volumes = []

    system = platform.system()
    if system == "Darwin":
        # macOS: list /Volumes
        vol_path = Path("/Volumes")
        if vol_path.exists():
            for entry in sorted(vol_path.iterdir()):
                if entry.name.startswith("."):
                    continue
                volumes.append({"name": entry.name, "path": str(entry)})
    elif system == "Windows":
        # Windows: list drive letters
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                volumes.append({"name": f"{letter}:", "path": drive})
    else:
        # Linux: list /mnt and /media
        for base in ["/mnt", "/media"]:
            bp = Path(base)
            if bp.exists():
                for entry in sorted(bp.iterdir()):
                    if entry.name.startswith("."):
                        continue
                    volumes.append({"name": entry.name, "path": str(entry)})
        # Also add home
        home = Path.home()
        volumes.append({"name": f"Home ({home.name})", "path": str(home)})

    return {"volumes": volumes, "platform": system.lower()}


@app.delete("/api/cache")
def clear_cache():
    """Clear the sample cache."""
    _sample_cache.clear()
    _sample_cache_state.clear()
    return {"status": "cleared"}


@app.post("/api/run-router/scan")
def run_router_scan(payload: dict = Body(...)):
    source_path = str(payload.get("source_path") or "").strip()
    initials_root = str(payload.get("initials_root") or "").strip()
    destination_root = str(payload.get("destination_root") or initials_root).strip()

    if not source_path:
        raise HTTPException(status_code=400, detail="source_path is required")
    if not initials_root:
        raise HTTPException(status_code=400, detail="initials_root is required")

    recursive = _coerce_bool(payload.get("recursive"), True)
    limit = _coerce_int(payload.get("limit"), 200)
    limit = max(0, min(limit, 1000))
    monitor_recent_days = _coerce_int(payload.get("monitor_recent_days"), 0)
    monitor_recent_days = max(0, min(monitor_recent_days, 30))

    return _scan_run_router(
        source_path=source_path,
        initials_root=initials_root,
        destination_root=destination_root,
        recursive=recursive,
        limit=limit,
        monitor_recent_days=monitor_recent_days,
    )


@app.post("/api/run-router/copy")
def run_router_copy(payload: dict = Body(...)):
    source_path = str(payload.get("source_path") or "").strip()
    initials_root = str(payload.get("initials_root") or "").strip()
    destination_root = str(payload.get("destination_root") or initials_root).strip()

    if not source_path:
        raise HTTPException(status_code=400, detail="source_path is required")
    if not initials_root:
        raise HTTPException(status_code=400, detail="initials_root is required")

    recursive = _coerce_bool(payload.get("recursive"), True)
    monitor_recent_days = _coerce_int(payload.get("monitor_recent_days"), 0)
    monitor_recent_days = max(0, min(monitor_recent_days, 30))
    run_paths_raw = payload.get("run_paths", [])
    if run_paths_raw is None:
        run_paths_raw = []
    if not isinstance(run_paths_raw, list):
        raise HTTPException(status_code=400, detail="run_paths must be a list")

    if run_paths_raw:
        run_paths = []
        seen_paths = set()
        for raw_path in run_paths_raw:
            normalized = _normalize_filesystem_path(str(raw_path or ""))
            if not normalized or normalized in seen_paths:
                continue
            seen_paths.add(normalized)
            run_paths.append(Path(normalized))
    else:
        scan_data = _scan_run_router(
            source_path=source_path,
            initials_root=initials_root,
            destination_root=destination_root,
            recursive=recursive,
            limit=0,
            monitor_recent_days=monitor_recent_days,
        )
        run_paths = [
            Path(item["path"])
            for item in scan_data["items"]
            if item.get("status") == "ready"
        ]

    initials_root_path, initials_dirs = _list_router_initial_dirs(initials_root)
    destination_root_path = Path(_normalize_filesystem_path(destination_root))

    results = []
    copied_count = 0
    exists_count = 0
    skipped_count = 0
    error_count = 0
    log_path = str(_router_log_path())

    for run_path in run_paths:
        source_folder = Path(_normalize_filesystem_path(str(run_path)))
        result = {
            "name": source_folder.name,
            "path": str(source_folder),
            "status": "skipped",
            "detail": "",
            "destination_path": None,
        }

        if not source_folder.exists():
            result["detail"] = "Source run not found"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue
        if not _is_supported_sample_folder(source_folder):
            result["detail"] = "Source path is not a supported sample folder"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue
        if _is_ignored_router_sample_path(source_folder):
            result["detail"] = "Shutdown runs are ignored"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue

        run_state = _inspect_sample_run_state(source_folder)
        if run_state.get("run_failed"):
            result["detail"] = run_state.get("run_log_last_line") or "Run was aborted or failed"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue
        if run_state.get("run_in_progress"):
            result["detail"] = "Run is still in progress"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue
        if not run_state.get("run_complete"):
            result["detail"] = "Run completion was not confirmed"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue
        if run_state.get("is_wash_position"):
            result["detail"] = "Wash position skipped"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                detail=result["detail"],
            )
            results.append(result)
            continue

        route = _build_router_destination(
            source_folder,
            initials_root_path,
            destination_root_path,
            initials_dirs=initials_dirs,
        )
        result["destination_path"] = route.get("destination_path")
        if not route["matched"] or not route["destination_path"]:
            result["detail"] = "No matching initials folder"
            skipped_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                destination_path=result["destination_path"],
                detail=result["detail"],
            )
            results.append(result)
            continue

        destination_path = Path(route["destination_path"])
        if destination_path.exists():
            result["status"] = "exists"
            result["detail"] = "Destination already exists"
            exists_count += 1
            log_path = _append_router_log(
                event="copy",
                status=result["status"],
                run_name=result["name"],
                source_path=result["path"],
                destination_path=result["destination_path"],
                detail=result["detail"],
            )
            results.append(result)
            continue

        try:
            _copy_router_folder(source_folder, destination_path)
            result["status"] = "copied"
            copied_count += 1
        except Exception as exc:
            result["status"] = "error"
            result["detail"] = str(exc)
            error_count += 1
        log_path = _append_router_log(
            event="copy",
            status=result["status"],
            run_name=result["name"],
            source_path=result["path"],
            destination_path=result["destination_path"],
            detail=result["detail"],
        )
        results.append(result)

    return {
        "items": results,
        "log_path": log_path,
        "summary": {
            "requested": len(run_paths),
            "copied": copied_count,
            "exists": exists_count,
            "skipped": skipped_count,
            "errors": error_count,
        },
    }


@app.post("/api/export-single-sample")
def export_single_sample(payload: dict = Body(...)):
    """Export Simple Sample views through the backend for true vector PDF output."""
    sample_path = payload.get("path")
    if not sample_path:
        raise HTTPException(status_code=400, detail="path is required")

    sample = _get_sample(str(sample_path))
    kind = str(payload.get("kind", "overview")).strip().lower()
    export_format = str(payload.get("format", "pdf")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    try:
        dpi = int(payload.get("dpi", lcms_config.EXPORT_DPI))
    except Exception:
        dpi = lcms_config.EXPORT_DPI
    dpi = max(72, min(600, dpi))

    settings = payload.get("settings", {})
    if not isinstance(settings, dict):
        settings = {}

    uv_wavelengths = []
    uv_wavelengths_raw = settings.get("uv_wavelengths", [])
    if isinstance(uv_wavelengths_raw, list):
        for wl in uv_wavelengths_raw:
            try:
                uv_wavelengths.append(float(wl))
            except Exception:
                continue

    mz_targets = payload.get("mz_targets", [])
    if not isinstance(mz_targets, list):
        mz_targets = []

    mz_window = _coerce_float(payload.get("mz_window"), lcms_config.DEFAULT_MZ_WINDOW)
    uv_smoothing = _coerce_int(settings.get("uv_smoothing"), lcms_config.UV_SMOOTHING_WINDOW)
    eic_smoothing = _coerce_int(settings.get("eic_smoothing"), lcms_config.EIC_SMOOTHING_WINDOW)
    style = {
        "fig_width": _coerce_float(settings.get("fig_width"), 10.0),
        "fig_height_per_panel": _coerce_float(settings.get("fig_height_per_panel"), 2.9),
        "line_width": _coerce_float(settings.get("line_width"), 0.8),
        "show_grid": _coerce_bool(settings.get("show_grid"), False),
        "labels": settings.get("labels", {}) if isinstance(settings.get("labels"), dict) else {},
    }

    if kind == "eic-overlay":
        fig = plotting.create_eic_comparison_figure(
            sample,
            mz_targets,
            mz_window=mz_window,
            smoothing=eic_smoothing,
            overlay=True,
            normalize=False,
            style=style,
        )
        filename_suffix = "extracted_ion_chromatograms"
    else:
        fig = plotting.create_single_sample_export_figure(
            sample,
            uv_wavelengths=uv_wavelengths,
            eic_targets=mz_targets,
            style=style,
            mz_window=mz_window,
            uv_smoothing=uv_smoothing,
            eic_smoothing=eic_smoothing,
        )
        filename_suffix = "single_sample"

    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png")
            media_type = "image/png"
    finally:
        plt.close(fig)

    base_name = sample.name[:-2] if sample.name.lower().endswith(".d") else sample.name
    safe_name = _sanitize_filename(base_name, fallback="sample")
    filename = f"{safe_name}_{filename_suffix}.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-progression-panel")
def export_progression_panel(payload: dict = Body(...)):
    """Export a single Time Progression panel through the backend renderer."""
    traces = payload.get("traces", [])
    if not isinstance(traces, list) or len(traces) == 0:
        raise HTTPException(status_code=400, detail="traces must be a non-empty list")

    export_format = str(payload.get("format", "pdf")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    try:
        dpi = int(payload.get("dpi", lcms_config.EXPORT_DPI))
    except Exception:
        dpi = lcms_config.EXPORT_DPI
    dpi = max(72, min(600, dpi))

    title = str(payload.get("title", "Time Progression"))
    y_label = str(payload.get("y_label", "Intensity"))
    x_label = str(payload.get("x_label", "Time (min)"))
    filename_base = str(payload.get("filename_base", "progression_panel"))

    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}

    x_range_raw = payload.get("x_range")
    x_range = None
    if isinstance(x_range_raw, (list, tuple)) and len(x_range_raw) == 2:
        x0 = _coerce_float(x_range_raw[0], np.nan)
        x1 = _coerce_float(x_range_raw[1], np.nan)
        if np.isfinite(x0) and np.isfinite(x1) and x1 > x0:
            x_range = (float(x0), float(x1))

    fig = plotting.create_chromatogram_overlay_export_figure(
        traces=traces,
        title=title,
        y_label=y_label,
        x_label=x_label,
        style=style,
        x_range=x_range,
    )
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig, tight=False)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi, tight=False)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png", tight=False)
            media_type = "image/png"
    finally:
        plt.close(fig)

    safe_name = _sanitize_filename(filename_base, fallback="progression_panel")
    filename = f"{safe_name}.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-uptake-assay-cc")
def export_uptake_assay_cc(payload: dict = Body(...)):
    """Export an uptake assay calibration curve through the backend renderer."""
    points = payload.get("points", [])
    if not isinstance(points, list) or len(points) == 0:
        raise HTTPException(status_code=400, detail="points must be a non-empty list")

    export_format = str(payload.get("format", "pdf")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    try:
        dpi = int(payload.get("dpi", lcms_config.EXPORT_DPI))
    except Exception:
        dpi = lcms_config.EXPORT_DPI
    dpi = max(72, min(600, dpi))

    title = str(payload.get("title", "Uptake Assay Calibration Curve"))
    x_label = str(payload.get("x_label", "Concentration (uM)"))
    y_label = str(payload.get("y_label", "Integrated Area"))
    filename_base = str(payload.get("filename_base", "uptake_assay_cc"))

    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}

    fit = payload.get("fit")
    if not isinstance(fit, dict):
        fit = None

    fig = plotting.create_calibration_curve_export_figure(
        points=points,
        title=title,
        x_label=x_label,
        y_label=y_label,
        style=style,
        fit=fit,
    )
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig, tight=False)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi, tight=False)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png", tight=False)
            media_type = "image/png"
    finally:
        plt.close(fig)

    safe_name = _sanitize_filename(filename_base, fallback="uptake_assay_cc")
    filename = f"{safe_name}.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-deconvoluted-masses")
def export_deconvoluted_masses(payload: dict = Body(...)):
    """Export deconvoluted masses figure using webapp's Matplotlib plotting rules."""
    sample_name = str(payload.get("sample_name", "sample"))
    components = payload.get("components", [])
    if not isinstance(components, list):
        raise HTTPException(status_code=400, detail="components must be a list")
    spectrum = payload.get("spectrum")
    if not isinstance(spectrum, dict):
        spectrum = {}

    export_format = str(payload.get("format", "png")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")
    variant = str(payload.get("variant", "standard")).lower()
    if variant not in {"standard", "wide-inset", "side-by-side"}:
        raise HTTPException(status_code=400, detail="variant must be one of: standard, wide-inset, side-by-side")

    try:
        dpi = int(payload.get("dpi", lcms_config.EXPORT_DPI))
    except Exception:
        dpi = lcms_config.EXPORT_DPI
    dpi = max(72, min(600, dpi))

    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}
    style = dict(style)
    style["deconv_export_variant"] = variant

    fig = plotting.create_deconvoluted_masses_figure(sample_name, components, style, spectrum=spectrum)
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png")
            media_type = "image/png"
    finally:
        plt.close(fig)

    base_name = sample_name[:-2] if sample_name.lower().endswith(".d") else sample_name
    safe_name = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in base_name).strip("_")
    safe_name = safe_name or "sample"
    if variant == "wide-inset":
        filename_suffix = "batch_deconvoluted_masses_wide"
    elif variant == "side-by-side":
        filename_suffix = "batch_deconvoluted_masses_side_by_side"
    else:
        filename_suffix = "batch_deconvoluted_masses"
    filename = f"{safe_name}_{filename_suffix}.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-ion-selection")
def export_ion_selection(payload: dict = Body(...)):
    """Export webapp-style ion selection figure for deconvolution results."""
    sample_path = payload.get("path")
    if not sample_path:
        raise HTTPException(status_code=400, detail="path is required")

    sample = _get_sample(str(sample_path))
    if sample.ms_scans is None or sample.ms_times is None:
        raise HTTPException(status_code=404, detail="No MS data")

    start = _coerce_float(payload.get("start"), np.nan)
    end = _coerce_float(payload.get("end"), np.nan)
    if not np.isfinite(start) or not np.isfinite(end) or end <= start:
        auto_start, auto_end = _detect_deconvolution_window_for_sample(sample)
        start, end = auto_start, auto_end
    if end <= start:
        raise HTTPException(status_code=400, detail="Invalid start/end time range")

    components = payload.get("components", [])
    if not isinstance(components, list) or len(components) == 0:
        raise HTTPException(status_code=400, detail="components must be a non-empty list")

    export_format = str(payload.get("format", "png")).lower()
    if export_format not in {"png", "svg", "pdf"}:
        raise HTTPException(status_code=400, detail="format must be one of: png, svg, pdf")

    dpi = max(72, min(600, _coerce_int(payload.get("dpi"), lcms_config.EXPORT_DPI)))
    style = payload.get("style", {})
    if not isinstance(style, dict):
        style = {}

    mz_arr, intensity_arr = analysis.sum_spectra_in_range(sample, start, end)
    if mz_arr is None or len(mz_arr) == 0:
        raise HTTPException(status_code=404, detail="Could not sum spectra for selected range")

    fig = plotting.create_ion_selection_figure(mz_arr, intensity_arr, components, style)
    try:
        if export_format == "svg":
            content = plotting.export_figure_svg(fig)
            media_type = "image/svg+xml"
        elif export_format == "pdf":
            content = plotting.export_figure_pdf(fig, dpi=dpi)
            media_type = "application/pdf"
        else:
            content = plotting.export_figure(fig, dpi=dpi, format="png")
            media_type = "image/png"
    finally:
        plt.close(fig)

    base_name = sample.name[:-2] if sample.name.lower().endswith(".d") else sample.name
    safe_name = _sanitize_filename(base_name, fallback="sample")
    filename = f"{safe_name}_ion_selection.{export_format}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/export-report-pdf")
def export_report_pdf(payload: dict = Body(...)):
    """Generate a multi-page report PDF using webapp plotting/export rules."""
    sample_path = payload.get("path")
    if not sample_path:
        raise HTTPException(status_code=400, detail="path is required")

    sample = _get_sample(str(sample_path))
    settings = payload.get("settings", {})
    if not isinstance(settings, dict):
        settings = {}

    include_uv = _coerce_bool(payload.get("include_uv"), sample.uv_data is not None)
    include_deconv = _coerce_bool(payload.get("include_deconv"), True)
    env_app_version = os.environ.get("LCMS_APP_VERSION")
    app_version = str(
        payload.get("app_version")
        or env_app_version
        or lcms_config.APP_VERSION
    ).strip() or str(lcms_config.APP_VERSION)

    line_width = _coerce_float(settings.get("line_width"), 0.8)
    show_grid = _coerce_bool(settings.get("show_grid"), False)
    deconv_x_min_da = _coerce_float(settings.get("deconv_x_min_da"), 1000.0)
    deconv_x_max_da = _coerce_float(settings.get("deconv_x_max_da"), 50000.0)
    uv_smoothing = _coerce_int(settings.get("uv_smoothing"), lcms_config.UV_SMOOTHING_WINDOW)
    eic_smoothing = _coerce_int(settings.get("eic_smoothing"), lcms_config.EIC_SMOOTHING_WINDOW)

    colors = settings.get("colors", {})
    if not isinstance(colors, dict):
        colors = {}
    labels = settings.get("labels", {})
    if not isinstance(labels, dict):
        labels = {}

    uv_wavelengths = []
    uv_wavelengths_raw = settings.get("uv_wavelengths", [])
    if isinstance(uv_wavelengths_raw, list):
        for wl in uv_wavelengths_raw:
            try:
                uv_wavelengths.append(float(wl))
            except Exception:
                continue

    if include_uv and not uv_wavelengths and sample.uv_wavelengths is not None and len(sample.uv_wavelengths) > 0:
        try:
            uv_wavelengths = [float(sample.uv_wavelengths[0])]
        except Exception:
            uv_wavelengths = []
    if not include_uv or sample.uv_data is None:
        uv_wavelengths = []

    deconv_results = payload.get("deconv_results")
    if not isinstance(deconv_results, list):
        deconv_results = []
    deconv_results = _sort_serialized_deconvolution_results(deconv_results)

    deconv_parameters = _normalize_deconvolution_parameters(payload.get("deconv_parameters"))

    deconv_time_range = payload.get("deconv_time_range")
    if isinstance(deconv_time_range, (list, tuple)) and len(deconv_time_range) == 2:
        start = _coerce_float(deconv_time_range[0], np.nan)
        end = _coerce_float(deconv_time_range[1], np.nan)
        if np.isfinite(start) and np.isfinite(end) and end > start:
            deconv_time_range = (float(start), float(end))
        else:
            deconv_time_range = None
    else:
        deconv_time_range = None

    if include_deconv:
        if deconv_time_range is None:
            start, end = _detect_deconvolution_window_for_sample(sample)
            if end > start:
                deconv_time_range = (start, end)
        if not deconv_results and deconv_time_range is not None:
            report_mz, report_intensity = analysis.sum_spectra_in_range(sample, deconv_time_range[0], deconv_time_range[1])
            if report_mz is not None and len(report_mz) > 0:
                deconv_results = _run_report_deconvolution(report_mz, report_intensity, deconv_parameters)
    else:
        deconv_results = []
        deconv_time_range = None

    A4_W, A4_H = 8.27, 11.69
    from matplotlib.backends.backend_pdf import PdfPages

    pdf_buffer = io.BytesIO()
    with PdfPages(pdf_buffer) as pdf:
        # Page 1: sample info + deconvolution table
        params = _format_deconvolution_parameters_for_report(deconv_parameters)
        fig_info = plotting.create_report_info_page(
            sample_name=sample.name,
            acq_method=sample.acq_method,
            app_version=app_version,
            time_range=deconv_time_range,
            parameters=params if deconv_results else {},
            results=deconv_results if deconv_results else None,
            acq_info=getattr(sample, "acq_info", None),
        )
        pdf.savefig(fig_info)
        plt.close(fig_info)

        # Page 2: UV/TIC chromatograms
        if sample.tic is not None or (include_uv and sample.uv_data is not None):
            chrom_style = {
                "fig_width": A4_W - 0.8,
                "fig_height_per_panel": 3.0,
                "line_width": line_width,
                "show_grid": show_grid,
                "y_scale": "linear",
                "colors": colors,
                "labels": labels,
            }
            fig_chrom = plotting.create_single_sample_figure(
                sample,
                uv_wavelengths=uv_wavelengths,
                eic_targets=[],
                style=chrom_style,
                uv_smoothing=uv_smoothing,
                eic_smoothing=eic_smoothing,
            )
            fig_chrom.set_size_inches(A4_W, A4_H)
            if fig_chrom._suptitle:
                fig_chrom._suptitle.set_y(0.98)
            fig_chrom.subplots_adjust(top=0.93)
            pdf.savefig(fig_chrom)
            plt.close(fig_chrom)

        # Page 3/4: deconvolution views
        if deconv_results and deconv_time_range is not None:
            display_results = deconv_results
            deconv_style = {
                "fig_width": A4_W - 0.8,
                "line_width": line_width,
                "show_grid": True,
                "deconv_x_min_da": deconv_x_min_da,
                "deconv_x_max_da": deconv_x_max_da,
                "deconv_show_obs_calc": False,
                "deconv_calc_mass_da": None,
            }
            fig_deconv = plotting.create_deconvolution_figure(
                sample,
                deconv_time_range[0],
                deconv_time_range[1],
                display_results,
                deconv_style,
            )
            fig_deconv.set_size_inches(A4_W, A4_H)
            if fig_deconv._suptitle:
                fig_deconv._suptitle.set_y(0.98)
            fig_deconv.subplots_adjust(top=0.93)
            pdf.savefig(fig_deconv)
            plt.close(fig_deconv)

            report_mz, report_intensity = analysis.sum_spectra_in_range(sample, deconv_time_range[0], deconv_time_range[1])
            if report_mz is not None and len(report_mz) > 0:
                ion_style = {
                    "fig_width": A4_W - 0.8,
                    "line_width": line_width,
                    "show_grid": True,
                }
                ion_components_per_page = 4
                global_top_intensity = float(display_results[0].get("intensity", 0) or 0)
                for offset in range(0, len(display_results), ion_components_per_page):
                    page_results = display_results[offset:offset + ion_components_per_page]
                    fig_ions = plotting.create_ion_selection_figure(
                        report_mz,
                        report_intensity,
                        page_results,
                        ion_style,
                        panel_slots=ion_components_per_page,
                        reference_intensity=global_top_intensity,
                    )
                    fig_ions.set_size_inches(A4_W, A4_H)
                    if fig_ions._suptitle:
                        fig_ions._suptitle.set_y(0.98)
                    fig_ions.subplots_adjust(top=0.93)
                    pdf.savefig(fig_ions)
                    plt.close(fig_ions)

    pdf_buffer.seek(0)
    base_name = sample.name[:-2] if sample.name.lower().endswith(".d") else sample.name
    safe_name = _sanitize_filename(base_name, fallback="sample")
    date_str = datetime.date.today().strftime("%Y%m%d")
    filename = f"{safe_name}_report_{date_str}.pdf"

    return Response(
        content=pdf_buffer.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("LCMS_PORT", 8741))
    print(f"LC-MS Backend starting on http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")

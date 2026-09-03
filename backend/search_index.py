"""Shared, per-computer search indexes for CATrupole data roots."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional


INDEX_DIRECTORY_NAME = ".catrupole-index"
INDEX_FORMAT_VERSION = 1
_VIRTUAL_SAMPLE_SEPARATOR = "::"
_cache_lock = threading.Lock()
_index_cache: dict[str, tuple[tuple[tuple[str, int, int], ...], list[dict]]] = {}


def _machine_name() -> str:
    raw = os.environ.get("COMPUTERNAME") or platform.node() or os.environ.get("HOSTNAME") or "computer"
    normalized = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(raw).strip()).strip("-.").lower()
    return normalized[:80] or "computer"


def _machine_fingerprint() -> str:
    """Return a stable, non-identifying shard key that survives app reinstalls."""
    raw_identifier = os.environ.get("CATRUPOLE_MACHINE_ID", "").strip()

    if not raw_identifier and os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Cryptography",
                0,
                winreg.KEY_READ | getattr(winreg, "KEY_WOW64_64KEY", 0),
            ) as key:
                raw_identifier = str(winreg.QueryValueEx(key, "MachineGuid")[0]).strip()
        except (OSError, ImportError):
            pass

    if not raw_identifier and platform.system() == "Darwin":
        try:
            output = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                text=True,
                timeout=2,
                stderr=subprocess.DEVNULL,
            )
            match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', output)
            if match:
                raw_identifier = match.group(1)
        except (OSError, subprocess.SubprocessError):
            pass

    if not raw_identifier and platform.system() == "Linux":
        for candidate in (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id")):
            try:
                raw_identifier = candidate.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if raw_identifier:
                break

    if not raw_identifier:
        # uuid.getnode() normally returns a hardware MAC address. Combining it
        # with the host name also protects against cloned/default identifiers.
        raw_identifier = f"{uuid.getnode():012x}:{platform.node()}"

    return hashlib.sha256(raw_identifier.encode("utf-8")).hexdigest()[:16]


def _index_directory(root: Path) -> Path:
    return root / INDEX_DIRECTORY_NAME


def _shard_path(root: Path) -> Path:
    return _index_directory(root) / f"machine-{_machine_fingerprint()}.json"


def _hide_on_windows(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        hidden = 0x02
        current = ctypes.windll.kernel32.GetFileAttributesW(str(path))
        if current != -1:
            ctypes.windll.kernel32.SetFileAttributesW(str(path), current | hidden)
    except Exception:
        pass


def _atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _hide_on_windows(path.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _hide_on_windows(path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _read_shard(path: Path) -> Optional[dict]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(document, dict) or document.get("version") != INDEX_FORMAT_VERSION:
        return None
    if not isinstance(document.get("entries"), list):
        return None
    return document


def _relative_parts(value: str) -> tuple[str, ...]:
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
        return ()
    return tuple(part for part in candidate.parts if part not in {"", "."})


def _split_virtual_path(value: str) -> tuple[str, str]:
    if _VIRTUAL_SAMPLE_SEPARATOR not in value:
        return value, ""
    base, selector = value.split(_VIRTUAL_SAMPLE_SEPARATOR, 1)
    return base, selector


def _entry_from_item(root: Path, item: dict) -> Optional[dict]:
    raw_path = str(item.get("path") or "")
    base_path_text, selector = _split_virtual_path(raw_path)
    try:
        relative = Path(base_path_text).relative_to(root)
    except (ValueError, TypeError):
        return None
    relative_text = relative.as_posix()
    if relative_text in {"", "."}:
        return None
    return {
        "relative_path": relative_text,
        "selector": selector,
        "name": str(item.get("name") or Path(base_path_text).name),
        "is_dir": bool(item.get("is_dir", False)),
        "is_d_folder": bool(item.get("is_d_folder", False)),
        "kind": str(item.get("kind") or "file"),
        "modified": float(item.get("modified") or 0.0),
    }


def _new_document(root: Path, entries: list[dict], complete_scan: bool) -> dict:
    return {
        "version": INDEX_FORMAT_VERSION,
        "root": str(root),
        "computer": _machine_name(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "complete_scan": bool(complete_scan),
        "entries": entries,
    }


def _invalidate(root: Path) -> None:
    with _cache_lock:
        _index_cache.pop(str(root), None)


def write_complete_index(root: Path, items: Iterable[dict]) -> bool:
    """Replace this computer's shard with a complete snapshot of the root."""
    normalized_root = Path(root)
    entries_by_path: dict[tuple[str, str], dict] = {}
    for item in items:
        entry = _entry_from_item(normalized_root, item)
        if entry is not None:
            entries_by_path[(entry["relative_path"], entry["selector"])] = entry
    entries = sorted(
        entries_by_path.values(),
        key=lambda entry: (entry["relative_path"].lower(), entry["selector"].lower()),
    )
    try:
        _atomic_write(_shard_path(normalized_root), _new_document(normalized_root, entries, True))
        _invalidate(normalized_root)
        return True
    except OSError:
        return False


def record_transferred_sample(root: Path, sample_path: Path) -> bool:
    """Add or refresh one successfully transferred sample in this computer's shard."""
    normalized_root = Path(root)
    normalized_sample = Path(sample_path)
    try:
        relative = normalized_sample.relative_to(normalized_root)
        stat_result = normalized_sample.stat()
    except (OSError, ValueError):
        return False

    shard_path = _shard_path(normalized_root)
    current = _read_shard(shard_path)
    current_entries = current.get("entries", []) if current else []
    entries_by_path: dict[tuple[str, str], dict] = {}
    for candidate in current_entries:
        if not isinstance(candidate, dict):
            continue
        relative_path = str(candidate.get("relative_path") or "")
        selector = str(candidate.get("selector") or "")
        if relative_path:
            entries_by_path[(relative_path, selector)] = candidate

    relative_text = relative.as_posix()
    entries_by_path[(relative_text, "")] = {
        "relative_path": relative_text,
        "selector": "",
        "name": normalized_sample.name,
        "is_dir": True,
        "is_d_folder": True,
        "kind": "sample-folder",
        "modified": float(stat_result.st_mtime),
    }
    entries = sorted(
        entries_by_path.values(),
        key=lambda entry: (
            str(entry.get("relative_path", "")).lower(),
            str(entry.get("selector", "")).lower(),
        ),
    )
    complete_scan = bool(current and current.get("complete_scan"))
    try:
        _atomic_write(shard_path, _new_document(normalized_root, entries, complete_scan))
        _invalidate(normalized_root)
        return True
    except OSError:
        return False


def _load_documents(root: Path) -> list[dict]:
    index_dir = _index_directory(root)
    try:
        paths = sorted(index_dir.glob("*.json"))
        signature = tuple((path.name, path.stat().st_mtime_ns, path.stat().st_size) for path in paths)
    except OSError:
        return []

    cache_key = str(root)
    with _cache_lock:
        cached = _index_cache.get(cache_key)
        if cached and cached[0] == signature:
            return cached[1]

    documents = [document for path in paths if (document := _read_shard(path)) is not None]
    with _cache_lock:
        _index_cache[cache_key] = (signature, documents)
    return documents


def search_shared_index(
    root: Path,
    query: str,
    limit: int,
    *,
    search_root: Optional[Path] = None,
) -> Optional[dict]:
    """Search merged shards, or return None until one full snapshot exists."""
    normalized_root = Path(root)
    normalized_search_root = Path(search_root) if search_root is not None else normalized_root
    try:
        normalized_search_root.relative_to(normalized_root)
    except ValueError:
        return None
    documents = _load_documents(normalized_root)
    if not documents or not any(document.get("complete_scan") for document in documents):
        return None

    merged: dict[tuple[str, str], dict] = {}
    for document in documents:
        for entry in document.get("entries", []):
            if not isinstance(entry, dict):
                continue
            relative_path = str(entry.get("relative_path") or "")
            selector = str(entry.get("selector") or "")
            if relative_path:
                merged[(relative_path, selector)] = entry

    needle = str(query or "").lower()
    matched: list[dict] = []
    for (relative_path, selector), entry in merged.items():
        name = str(entry.get("name") or "")
        if needle not in name.lower():
            continue
        relative_parts = _relative_parts(relative_path)
        if not relative_parts:
            continue
        base_path = normalized_root.joinpath(*relative_parts)
        try:
            base_path.relative_to(normalized_search_root)
        except ValueError:
            continue
        rendered_path = str(base_path)
        if selector:
            rendered_path = f"{rendered_path}{_VIRTUAL_SAMPLE_SEPARATOR}{selector}"
        parent_path = base_path.parent
        try:
            parent_label = str(parent_path.relative_to(normalized_search_root)) or "."
        except ValueError:
            parent_label = str(parent_path)
        matched.append({
            "name": name,
            "path": rendered_path,
            "parent": parent_label,
            "parent_path": str(parent_path),
            "is_dir": bool(entry.get("is_dir", False)),
            "is_d_folder": bool(entry.get("is_d_folder", False)),
            "kind": str(entry.get("kind") or "file"),
            "modified": float(entry.get("modified") or 0.0),
        })

    matched.sort(key=lambda item: (item["name"].lower(), item["path"].lower()))
    capped_limit = max(1, int(limit))
    return {
        "path": str(normalized_search_root),
        "items": matched[:capped_limit],
        "truncated": len(matched) > capped_limit,
        "indexed": True,
    }

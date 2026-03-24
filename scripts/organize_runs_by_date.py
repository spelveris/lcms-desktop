#!/usr/bin/env python3
"""Group top-level LC-MS run bundles into YYYYMMDD folders."""

from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
LCMS_APP_DIR = BACKEND_DIR / "lcms_app"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
if str(LCMS_APP_DIR) not in sys.path:
    sys.path.insert(0, str(LCMS_APP_DIR))

from data_reader import (  # noqa: E402
    OLAX_CONTAINER_SUFFIX,
    RSLT_CONTAINER_SUFFIX,
    SUPPORTED_SAMPLE_SUFFIXES,
    infer_sample_date_info,
)


SUPPORTED_TOP_LEVEL_SUFFIXES = {suffix.lower() for suffix in SUPPORTED_SAMPLE_SUFFIXES}
SUPPORTED_TOP_LEVEL_SUFFIXES.update({RSLT_CONTAINER_SUFFIX.lower(), OLAX_CONTAINER_SUFFIX.lower()})


def is_sample_bundle(entry: Path) -> bool:
    if entry.name.startswith("."):
        return False
    return entry.suffix.lower() in SUPPORTED_TOP_LEVEL_SUFFIXES and (entry.is_dir() or entry.is_file())


def is_date_folder(entry: Path) -> bool:
    return entry.is_dir() and entry.name.isdigit() and len(entry.name) == 8 and entry.name.startswith("20")


def _set_path_mtime_ns(path: Path, mtime_ns: int) -> None:
    try:
        stat_result = path.stat()
        os.utime(path, ns=(int(stat_result.st_atime_ns), int(mtime_ns)), follow_symlinks=False)
    except Exception:
        pass


def _latest_nested_file_mtime_ns(path: Path) -> int:
    if path.is_file():
        return int(path.stat().st_mtime_ns)

    latest_ns = None
    for current_root, _dirs, files in os.walk(path):
        current_dir = Path(current_root)
        for filename in files:
            file_path = current_dir / filename
            try:
                file_mtime_ns = int(file_path.stat().st_mtime_ns)
            except Exception:
                continue
            latest_ns = file_mtime_ns if latest_ns is None else max(latest_ns, file_mtime_ns)

    if latest_ns is not None:
        return latest_ns
    return int(path.stat().st_mtime_ns)


def _sync_bundle_directory_mtime(bundle_path: Path) -> None:
    if not bundle_path.is_dir():
        return
    _set_path_mtime_ns(bundle_path, _latest_nested_file_mtime_ns(bundle_path))


def _sync_date_folder_mtimes(root: Path) -> None:
    for date_dir in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not is_date_folder(date_dir):
            continue

        latest_child_ns = None
        for child in sorted(date_dir.iterdir(), key=lambda p: p.name.lower()):
            if is_sample_bundle(child) and child.is_dir():
                _sync_bundle_directory_mtime(child)
            try:
                child_mtime_ns = int(child.stat().st_mtime_ns)
            except Exception:
                continue
            latest_child_ns = child_mtime_ns if latest_child_ns is None else max(latest_child_ns, child_mtime_ns)

        if latest_child_ns is not None:
            _set_path_mtime_ns(date_dir, latest_child_ns)


def organize_top_level_runs(root: Path, apply_changes: bool, manifest_path: Path) -> tuple[int, int, int]:
    rows: list[dict[str, str]] = []
    moved = 0
    skipped = 0
    errors = 0

    entries = sorted(root.iterdir(), key=lambda p: p.name.lower())
    for entry in entries:
        if is_date_folder(entry):
            continue
        if not is_sample_bundle(entry):
            continue

        date_folder, date_source = infer_sample_date_info(str(entry))
        date_folder = (date_folder or "undated").strip() or "undated"
        target_dir = root / date_folder
        target_path = target_dir / entry.name

        status = "move"
        message = ""
        if target_path == entry:
            status = "already-sorted"
            skipped += 1
        elif target_path.exists():
            status = "exists-skip"
            skipped += 1
            message = "destination already exists"
        elif not apply_changes:
            status = "dry-run"
        else:
            try:
                target_dir.mkdir(parents=True, exist_ok=True)
                entry.rename(target_path)
                moved += 1
            except Exception as exc:  # pragma: no cover - best-effort utility
                status = "error"
                message = str(exc)
                errors += 1

        rows.append(
            {
                "source_path": str(entry),
                "destination_path": str(target_path),
                "date_folder": date_folder,
                "date_source": date_source,
                "status": status,
                "message": message,
            }
        )

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "source_path",
                "destination_path",
                "date_folder",
                "date_source",
                "status",
                "message",
            ],
            delimiter="\t",
        )
        writer.writeheader()
        writer.writerows(rows)

    if apply_changes:
        _sync_date_folder_mtimes(root)

    return moved, skipped, errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Move top-level LC-MS run bundles into YYYYMMDD folders.")
    parser.add_argument("root", help="Folder to organize, for example a initials folder like .../DS")
    parser.add_argument("--apply", action="store_true", help="Actually move folders instead of dry-run only")
    parser.add_argument(
        "--manifest",
        default="date-organization-manifest.tsv",
        help="Manifest filename to write inside the root folder",
    )
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        print(f"Invalid root folder: {root}", file=sys.stderr)
        return 2

    manifest_path = root / args.manifest
    moved, skipped, errors = organize_top_level_runs(root, args.apply, manifest_path)
    mode = "applied" if args.apply else "dry-run"
    print(f"{mode}: moved={moved} skipped={skipped} errors={errors}")
    print(str(manifest_path))
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

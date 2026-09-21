"""Additional, read-only reader for Agilent TOF/Q-TOF OpenLab .sirslt data.

Uses the schema/calibration stored in the run, never the quadrupole layout.
Centroids retain their acquired per-scan precision and fractional intensities;
MS/MS is kept in separate channels. No profile resampling is done on import.

MassHunter calibration and split centroid block interpretation are adapted from
rainbow-api (Evan Shi and Eugene Kwan), revision
e63c79e5842fb9882bc2fe6459ce8f773275e34f, rainbow/agilent/masshunter.py.
This module: SPDX-License-Identifier: LGPL-3.0-or-later.
See third_party/rainbow/COPYING and COPYING.LESSER (shipped with the source).
"""

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET

import numpy as np

_NS = {"xs": "http://www.w3.org/2001/XMLSchema"}
_PRIMITIVES = {"byte": "b", "short": "h", "int": "i", "long": "q", "float": "f", "double": "d"}
_PEAK_TYPES = {8: ("<f4", "<f4"), 12: ("<f8", "<f4"), 16: ("<f8", "<f8")}


def is_digest_method(method):
    """Classify the recorded acquisition method, never the sample filename."""
    name = str(method or "").replace("\\", "/").split("/")[-1].lower()
    if re.search(r"(^|[^a-z0-9])intact([^a-z0-9]|$)", name):
        return False
    return bool(re.search(r"(^|[^a-z0-9])(protein[^a-z0-9]*digest(?:ion)?|peptide[^a-z0-9]*mapping)([^a-z0-9]|$)", name))


def _xml(archive, name):
    info = archive.getinfo(name)
    if info.file_size > 1024 * 1024:
        raise ValueError(f"QTOF metadata is unexpectedly large: {name}")
    return ET.fromstring(archive.read(name))


def inspect_qtof(archive):
    """Return metadata only for an explicitly identified TOF/Q-TOF detector."""
    if "MSData/Devices.xml" not in archive.namelist():
        return None
    devices = _xml(archive, "MSData/Devices.xml")
    detector = next((d for d in devices.findall("Device")
                     if (d.findtext("Name") or "").strip().upper() in {"TOF/Q-TOF", "Q-TOF", "TOF"}), None)
    if detector is None:
        return None
    return {
        "model": detector.findtext("ModelNumber") or "TOF/Q-TOF",
        "schema": _xml(archive, "MSData/MSScan.xsd"),
        "calibration": _xml(archive, "MSData/DefaultMassCal.xml"),
    }


def _fields(schema, name, stack=()):
    if name in stack or len(stack) > 8:
        raise ValueError("Recursive QTOF scan schema")
    node = schema.find(f"xs:complexType[@name='{name}']/xs:sequence", _NS)
    if node is None:
        raise ValueError(f"Unsupported QTOF scan schema type: {name}")
    fields = []
    for item in node.findall("xs:element", _NS):
        field, kind = item.get("name"), item.get("type", "").split(":")[-1]
        if field == "SpectrumParamValues":
            continue
        if kind in _PRIMITIVES:
            fields.append((field, _PRIMITIVES[kind]))
        else:
            fields.extend(_fields(schema, kind, (*stack, name)))
    return fields


def read_records(scan_path, schema):
    base = _fields(schema, "ScanRecordType")
    spectra = _fields(schema, "SpectrumParamsType")
    scalar = struct.Struct("<" + "".join(t for _, t in base))
    block = struct.Struct("<" + "".join(t for _, t in spectra))
    # The additional path deliberately supports the documented dual-block
    # layout only: profile plus centroid. Fail closed on an unknown layout.
    stride = scalar.size + 2 * block.size
    size = scan_path.stat().st_size
    if size < 92 or size > 256 * 1024 * 1024:
        raise ValueError("Invalid QTOF scan index size")
    with scan_path.open("rb") as handle:
        handle.seek(0x58)
        start = struct.unpack("<I", handle.read(4))[0]
        if start < 92 or start >= size or (size - start) % stride:
            raise ValueError("Unsupported or incomplete QTOF dual-spectrum scan index")
        handle.seek(start)
        payload = handle.read()
    records = []
    for offset in range(0, len(payload), stride):
        record = dict(zip((n for n, _ in base), scalar.unpack_from(payload, offset)))
        record["spectra"] = [dict(zip((n for n, _ in spectra), block.unpack_from(payload, offset + scalar.size + i * block.size))) for i in range(2)]
        if (record.get("MSLevel") not in {1, 2} or record.get("IonPolarity") not in {0, 1}
                or not np.isfinite(record.get("ScanTime", np.nan)) or record["ScanTime"] < 0):
            raise ValueError("Invalid QTOF scan metadata")
        if records and record["ScanTime"] < records[-1]["ScanTime"]:
            raise ValueError("QTOF scan times are out of order")
        if [s.get("SpectrumFormatID") for s in record["spectra"]] != [1, 2]:
            raise ValueError("Unsupported QTOF profile/centroid spectrum layout")
        records.append(record)
    return records


def calibration_flags(root):
    flags = {}
    for cal in root.iter("DefaultCalibration"):
        cid = int(cal.attrib["DefaultCalibrationID"])
        flags[cid] = 0
        for step in cal.findall("Step"):
            if step.findtext("CalibrationFormula") == "Polynomial":
                value = int(step.findtext("ValueUseFlags") or 0)
                if value < 0 or value.bit_length() > 32 or value.bit_count() > 6:
                    raise ValueError("Unsupported QTOF calibration polynomial")
                flags[cid] = value
    return flags


def calibrate(tof, row, flags):
    """Traditional TOF calibration plus the recorded polynomial refinement."""
    coefficient, base, left, right = row[:4]
    if not np.all(np.isfinite(row)) or coefficient <= 0 or (flags and left >= right):
        raise ValueError("Invalid QTOF mass calibration")
    mz = np.square(coefficient * (tof - base))
    if flags:
        polynomial = np.zeros(flags.bit_length())
        orders = [i for i in range(flags.bit_length()) if flags & (1 << i)]
        polynomial[orders] = row[4:4 + len(orders)]
        mz -= np.polynomial.polynomial.polyval(np.clip(tof, left, right), polynomial)
    return mz


@dataclass
class QtofChannel:
    times: np.ndarray
    tic: np.ndarray
    scans: list
    metadata: list


def read_qtof(bundle, context):
    """Load calibrated instrument centroids; never mix MS1 and MS/MS scans."""
    bundle = Path(bundle)
    indexes = sorted(p for p in bundle.glob("*.MSScan.bin") if not p.name.startswith("._"))
    if len(indexes) != 1:
        raise ValueError("QTOF .sirslt must contain exactly one scan index")
    scan_path = indexes[0]
    stem = scan_path.name[:-len(".MSScan.bin")]
    peak_path = bundle / f"{stem}.MSPeak.bin"
    cal_path = bundle / f"{stem}.MSMassCal.bin"
    records = read_records(scan_path, context["schema"])
    flags = calibration_flags(context["calibration"])
    peak_size = peak_path.stat().st_size
    cal_size = cal_path.stat().st_size
    channels = {}
    max_error = 0.0
    empty = 0
    with peak_path.open("rb") as peaks, cal_path.open("rb") as calibration:
        for index, record in enumerate(records):
            block = record["spectra"][1]
            count, length, offset = (int(block[k]) for k in ("PointCount", "ByteCount", "SpectrumOffset"))
            if count == 0 and length == 0:
                # An empty scan may use -1 as its absent-spectrum offset.
                values = np.empty((0, 2), dtype=float)
                empty += 1
            else:
                if count <= 0 or count > 10_000_000 or length % count or length // count not in _PEAK_TYPES:
                    raise ValueError(f"Unsupported QTOF centroid encoding at scan {index + 1}")
                if offset < 68 or length < 0 or offset + length > peak_size:
                    raise ValueError(f"Incomplete QTOF centroid data at scan {index + 1}")
                # MassCalOffset points to an int32 count followed by the ten
                # doubles. Use the recorded offset, not the scan's ordinal.
                cal_offset = int(record["MassCalOffset"])
                if cal_offset < 72 or cal_offset + 84 > cal_size or record["CalibrationID"] not in flags:
                    raise ValueError(f"Missing QTOF mass calibration at scan {index + 1}")
                calibration.seek(cal_offset)
                if struct.unpack("<i", calibration.read(4))[0] != 10:
                    raise ValueError(f"Unsupported QTOF mass calibration at scan {index + 1}")
                row = np.frombuffer(calibration.read(80), dtype="<f8")
                peaks.seek(offset)
                blob = peaks.read(length)
                x_type, y_type = _PEAK_TYPES[length // count]
                x_bytes = count * np.dtype(x_type).itemsize
                tof = np.frombuffer(blob[:x_bytes], dtype=x_type).astype(float)
                intensity = np.frombuffer(blob[x_bytes:], dtype=y_type).astype(float)
                mz = calibrate(tof, row, flags[record["CalibrationID"]])
                if (not np.all(np.isfinite(mz)) or not np.all(np.isfinite(intensity))
                        or np.any(mz <= 0) or np.any(np.diff(mz) < 0) or np.any(intensity < 0)):
                    raise ValueError(f"Invalid QTOF spectrum at scan {index + 1}")
                # The vendor also records calibrated centroid bounds. Check our
                # transform against them to avoid displaying raw flight times
                # or masses produced by the wrong calibration/layout.
                error = max(abs(mz[0] - block["MinX"]), abs(mz[-1] - block["MaxX"]))
                max_error = max(max_error, error)
                if not np.isfinite(error) or error > 0.002:
                    raise ValueError(f"QTOF mass calibration does not match scan {index + 1}")
                values = np.column_stack((mz, intensity))
            key = (record["IonPolarity"], record["MSLevel"])
            channel = channels.setdefault(key, {"times": [], "tic": [], "scans": [], "metadata": []})
            channel["times"].append(record["ScanTime"])
            channel["tic"].append(record["TIC"])
            channel["scans"].append(values)
            channel["metadata"].append({
                "scan_id": record["ScanID"], "time": record["ScanTime"],
                "ms_level": record["MSLevel"], "precursor_mz": record.get("MzOfInterest"),
                "collision_energy": record.get("CollisionEnergy"),
                "recorded_parent_scan_id": record.get("DDScanID", 0),
            })
    for polarity in (0, 1):
        surveys = {m["scan_id"] for m in channels.get((polarity, 1), {}).get("metadata", [])}
        for meta in channels.get((polarity, 2), {}).get("metadata", []):
            parent = meta["recorded_parent_scan_id"]
            # Only the acquisition's explicit parent link is authoritative.
            # Never invent an MS/MS match using a nearby retention time/mass.
            meta["parent_scan_id"] = parent if parent in surveys else None
    result = {key: QtofChannel(np.asarray(c["times"]), np.asarray(c["tic"]), c["scans"], c["metadata"])
              for key, c in channels.items()}
    info = {"instrument": context["model"], "representation": "calibrated centroid",
            "scan_counts": {str(k): v for k, v in sorted(Counter(r["MSLevel"] for r in records).items())},
            "empty_scans": empty, "max_calibration_bound_error_da": max_error}
    return result, info

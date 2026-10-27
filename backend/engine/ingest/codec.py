"""Compact storage for daily series: values x100 as int32, column-major, zstd-compressed (~0.3 MB per POWER cell)."""

from __future__ import annotations

import json
import struct

import numpy as np
import pandas as pd
import zstandard

MAGIC = b"AFS1"
SCALE = 100
MISSING = np.iinfo(np.int32).min
_LEVEL = 12


def encode(frame: pd.DataFrame) -> bytes:
    if frame.empty:
        raise ValueError("Cannot encode an empty series")
    if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
        raise ValueError("Series index must be sorted and unique")
    full = frame.reindex(pd.date_range(frame.index[0], frame.index[-1], freq="D"))
    values = full.to_numpy(dtype="float64").T
    ints = np.where(np.isnan(values), MISSING, np.round(values * SCALE)).astype("<i4")
    header = json.dumps(
        {"start": full.index[0].strftime("%Y-%m-%d"), "days": len(full), "columns": list(full.columns), "scale": SCALE}
    ).encode()
    payload = zstandard.ZstdCompressor(level=_LEVEL).compress(ints.tobytes())
    return MAGIC + struct.pack("<I", len(header)) + header + payload


def decode(blob: bytes) -> pd.DataFrame:
    if blob[:4] != MAGIC:
        raise ValueError("Not a CropCompass series blob")
    (size,) = struct.unpack("<I", blob[4:8])
    header = json.loads(blob[8 : 8 + size])
    raw = zstandard.ZstdDecompressor().decompress(blob[8 + size :])
    ints = np.frombuffer(raw, dtype="<i4").reshape(len(header["columns"]), header["days"])
    values = np.where(ints == MISSING, np.nan, ints / header["scale"])
    index = pd.date_range(header["start"], periods=header["days"], freq="D")
    return pd.DataFrame(values.T, index=index, columns=header["columns"])

"""Versioned AISStream position contract. No network calls or wall-clock reads."""

import hashlib
import json
import math
from datetime import UTC, datetime

VERSION = "ais-position-v1"
POSITION_TYPES = {"PositionReport", "StandardClassBPositionReport"}


def utc_time(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("timestamp must be a timezone-aware string")
    # AISStream historically includes a redundant UTC suffix after +0000.
    dt = datetime.fromisoformat(value.removesuffix(" UTC"))
    if dt.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return dt.astimezone(UTC).isoformat(timespec="microseconds")


def number(value, field, minimum, maximum, *, exclusive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field}: expected a number")
    if not math.isfinite(value) or value < minimum or value > maximum or (exclusive and value == maximum):
        raise ValueError(f"{field}: out of range")
    return float(value)


def normalize(row) -> dict | None:
    """None means a recognized non-position message; invalid positions raise ValueError."""
    data = json.loads(row["payload"])
    if not isinstance(data, dict):
        raise ValueError("expected a JSON object")
    kind = data.get("MessageType")
    if not isinstance(kind, str) or not kind:
        raise ValueError("missing MessageType")
    if kind not in POSITION_TYPES:
        return None
    meta = data.get("MetaData")
    messages = data.get("Message")
    if not isinstance(meta, dict) or not isinstance(messages, dict):
        raise ValueError("missing metadata or message")
    report = messages.get(kind)
    if not isinstance(report, dict):
        raise ValueError("missing position report")
    if report.get("Valid") is False:
        raise ValueError("provider marked report invalid")
    mmsi = str(meta.get("MMSI", ""))
    if len(mmsi) != 9 or not mmsi.isascii() or not mmsi.isdigit():
        raise ValueError("MMSI must contain nine digits")
    if report.get("UserID") is not None and str(report["UserID"]) != mmsi:
        raise ValueError("metadata and report MMSI disagree")
    source_time = meta.get("time_utc")
    event_time = utc_time(source_time) if source_time else row["received_at"]
    position = {
        "mmsi": mmsi,
        "event_time": event_time,
        "time_basis": "provider" if source_time else "received",
        "lat": number(report.get("Latitude", meta.get("latitude", meta.get("Latitude"))), "latitude", -90, 90),
        "lng": number(report.get("Longitude", meta.get("longitude", meta.get("Longitude"))), "longitude", -180, 180),
    }
    # AIS unavailable sentinels become null, never plausible measurements.
    for field, key, sentinel, limit in [
        ("sog_knots", "Sog", 102.3, 102.3),
        ("cog_deg", "Cog", 360, 360),
        ("heading_deg", "TrueHeading", 511, 360),
    ]:
        value = report.get(key)
        position[field] = None if value is None or value == sentinel else number(value, field, 0, limit, exclusive=True)
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False)
    # Without a provider timestamp identical payloads may be separate observations.
    identity = canonical if source_time else row["event_id"]
    position["event_key"] = hashlib.sha256((row["source"] + "\n" + identity).encode()).hexdigest()
    return position

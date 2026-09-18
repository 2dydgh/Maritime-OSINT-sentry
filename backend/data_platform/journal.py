"""Single-host durable raw journal and transactional, versioned projections.

SQLite is the local staging implementation, not a distributed lakehouse. Export
immutable batches for object storage; keep the online PostGIS path independent.
"""

import gzip
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from .normalize import VERSION, normalize, utc_time

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    version TEXT NOT NULL,
    event_key TEXT NOT NULL,
    raw_seq INTEGER NOT NULL REFERENCES raw_events(seq),
    mmsi TEXT NOT NULL,
    event_time TEXT NOT NULL,
    time_basis TEXT NOT NULL,
    lat REAL NOT NULL, lng REAL NOT NULL,
    sog_knots REAL, cog_deg REAL, heading_deg REAL,
    PRIMARY KEY(version, event_key)
);
CREATE INDEX IF NOT EXISTS position_track ON positions(version, mmsi, event_time, raw_seq);
CREATE TABLE IF NOT EXISTS quality_issues (
    version TEXT NOT NULL,
    raw_seq INTEGER NOT NULL REFERENCES raw_events(seq),
    reason TEXT NOT NULL,
    PRIMARY KEY(version, raw_seq)
);
CREATE TABLE IF NOT EXISTS checkpoints (
    version TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL
);
"""


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, timeout=5, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)

    def close(self):
        with self._lock:
            self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def append(self, payload: str, received_at=None) -> str:
        """Return only after raw input is committed; duplicates remain in raw."""
        received_at = utc_time(received_at or datetime.now(UTC).isoformat())
        event_id = str(uuid4())
        with self._lock, self.db:
            self.db.execute(
                "INSERT INTO raw_events(event_id,source,received_at,payload) VALUES(?,?,?,?)",
                (event_id, "aisstream", received_at, payload),
            )
        return event_id

    def process(self, batch_size=500, *, version=VERSION, transform=normalize):
        """Commit output and checkpoint together. Repeat calls process only new rows."""
        if not 1 <= batch_size <= 10000:
            raise ValueError("batch_size must be 1..10000")
        counts = dict(processed=0, inserted=0, duplicates=0, rejected=0, skipped=0)
        with self._lock, self.db:
            self.db.execute("BEGIN IMMEDIATE")
            checkpoint = self.db.execute("SELECT last_seq FROM checkpoints WHERE version=?", (version,)).fetchone()
            last_seq = checkpoint[0] if checkpoint else 0
            rows = self.db.execute(
                "SELECT * FROM raw_events WHERE seq>? ORDER BY seq LIMIT ?", (last_seq, batch_size)
            ).fetchall()
            for row in rows:
                try:
                    position = transform(row)
                except ValueError as exc:
                    self.db.execute("INSERT INTO quality_issues VALUES(?,?,?)", (version, row["seq"], str(exc)))
                    counts["rejected"] += 1
                else:
                    if position is None:
                        counts["skipped"] += 1
                    else:
                        fields = (
                            "event_key",
                            "mmsi",
                            "event_time",
                            "time_basis",
                            "lat",
                            "lng",
                            "sog_knots",
                            "cog_deg",
                            "heading_deg",
                        )
                        inserted = self.db.execute(
                            "INSERT OR IGNORE INTO positions(version,raw_seq,event_key,mmsi,event_time,time_basis,lat,lng,sog_knots,cog_deg,heading_deg) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (version, row["seq"], *(position[f] for f in fields)),
                        ).rowcount
                        counts["inserted" if inserted else "duplicates"] += 1
                counts["processed"] += 1
            if rows:
                self.db.execute(
                    "INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(version) DO UPDATE SET last_seq=excluded.last_seq",
                    (version, rows[-1]["seq"]),
                )
        return counts

    def status(self, version=VERSION):
        with self._lock:
            raw = self.db.execute("SELECT COUNT(*),COALESCE(MAX(seq),0),MAX(received_at) FROM raw_events").fetchone()
            checkpoint = self.db.execute("SELECT last_seq FROM checkpoints WHERE version=?", (version,)).fetchone()
            last_seq = checkpoint[0] if checkpoint else 0
            return dict(
                version=version,
                raw_events=raw[0],
                latest_received_at=raw[2],
                checkpoint=last_seq,
                pending=self.db.execute("SELECT COUNT(*) FROM raw_events WHERE seq>?", (last_seq,)).fetchone()[0],
                positions=self.db.execute("SELECT COUNT(*) FROM positions WHERE version=?", (version,)).fetchone()[0],
                rejected=self.db.execute("SELECT COUNT(*) FROM quality_issues WHERE version=?", (version,)).fetchone()[
                    0
                ],
            )

    def positions(self, mmsi, limit=100, version=VERSION):
        if not 1 <= limit <= 1000:
            raise ValueError("limit must be 1..1000")
        with self._lock:
            return [
                dict(r)
                for r in self.db.execute(
                    """SELECT p.*, r.event_id, r.source, r.received_at
                FROM positions p JOIN raw_events r ON r.seq=p.raw_seq
                WHERE p.version=? AND p.mmsi=? ORDER BY p.event_time DESC,p.raw_seq DESC LIMIT ?""",
                    (version, mmsi, limit),
                )
            ]

    def export_raw(self, directory, batch_size=1000):
        """Export bounded, content-addressed gzip JSONL objects from a fixed snapshot.

        File names hash the uncompressed envelopes. Repeated exports reuse identical
        objects. Only complete batches are renamed into place; interrupted temp files
        are not datasets. Envelopes include original payload text and stable event IDs.
        """
        if not 1 <= batch_size <= 10000:
            raise ValueError("batch_size must be 1..10000")
        root = Path(directory)
        with self._lock:
            high = self.db.execute("SELECT COALESCE(MAX(seq),0) FROM raw_events").fetchone()[0]
        cursor, objects = 0, []
        while cursor < high:
            with self._lock:
                rows = self.db.execute(
                    "SELECT * FROM raw_events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?", (cursor, high, batch_size)
                ).fetchall()
            groups = {}
            for row in rows:
                day = row["received_at"][:10]
                hour = row["received_at"][11:13]
                key = f"raw/source=aisstream/received_date={day}/hour={hour}"
                envelope = dict(row, envelope_version=1)
                groups.setdefault(key, []).append(
                    json.dumps(envelope, ensure_ascii=False, separators=(",", ":")) + "\n"
                )
            for key, lines in groups.items():
                content = "".join(lines).encode()
                digest = hashlib.sha256(content).hexdigest()
                target = root / key / (digest + ".jsonl.gz")
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    with gzip.open(target, "rb") as f:
                        if f.read() != content:
                            raise ValueError(f"export object checksum mismatch: {target.name}")
                else:
                    fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=target.parent)
                    try:
                        with os.fdopen(fd, "wb") as f:
                            f.write(gzip.compress(content, mtime=0))
                            f.flush()
                            os.fsync(f.fileno())
                        os.replace(tmp, target)
                    finally:
                        Path(tmp).unlink(missing_ok=True)
                objects.append(str(target.relative_to(root)))
            cursor = rows[-1]["seq"]
        manifest = dict(envelope_version=1, high_watermark=high, objects=objects)
        content = json.dumps(manifest, sort_keys=True, indent=2).encode()
        manifest_path = root / ("manifest-" + hashlib.sha256(content).hexdigest() + ".json")
        root.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".pending-", dir=root)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, manifest_path)
        finally:
            Path(tmp).unlink(missing_ok=True)
        return dict(manifest=str(manifest_path), **manifest)

    def restore_raw(self, manifest_path):
        """Idempotently import one complete export manifest, preserving capture IDs.

        A partial import can be rerun. Never glob objects: successive snapshots may
        share records in different tail batches. IDs prevent duplicate raw imports.
        """
        manifest_path = Path(manifest_path).resolve()
        root = manifest_path.parent
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("envelope_version") != 1:
            raise ValueError("unsupported export envelope version")
        inserted = 0
        for name in manifest["objects"]:
            path = (root / name).resolve()
            if not path.is_relative_to(root):
                raise ValueError("object path escapes export directory")
            with gzip.open(path, "rb") as f:
                content = f.read()
            if hashlib.sha256(content).hexdigest() + ".jsonl.gz" != path.name:
                raise ValueError("raw object checksum mismatch")
            with self._lock, self.db:
                for line in content.splitlines():
                    row = json.loads(line)
                    if (
                        row.get("envelope_version") != 1
                        or row.get("source") != "aisstream"
                        or not isinstance(row.get("payload"), str)
                    ):
                        raise ValueError("invalid raw envelope")
                    received_at = utc_time(row["received_at"])
                    existing = self.db.execute(
                        "SELECT source,received_at,payload FROM raw_events WHERE event_id=?", (row["event_id"],)
                    ).fetchone()
                    values = ("aisstream", received_at, row["payload"])
                    if existing is not None:
                        if tuple(existing) != values:
                            raise ValueError("event ID conflicts with existing raw data")
                        continue
                    self.db.execute(
                        "INSERT INTO raw_events(event_id,source,received_at,payload) VALUES(?,?,?,?)",
                        (row["event_id"], *values),
                    )
                    inserted += 1
        return {"stored": inserted}

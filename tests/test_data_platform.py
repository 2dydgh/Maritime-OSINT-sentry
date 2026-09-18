import gzip
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from backend.data_platform.journal import Journal
from backend.data_platform.normalize import normalize, utc_time

FIXTURE = Path(__file__).parent / "fixtures/data_platform/ais-demo.jsonl"
RECEIVED = "2026-09-14T02:00:00Z"


def seed(journal):
    for line in FIXTURE.read_text().splitlines():
        journal.append(line, RECEIVED)


def process_all(journal):
    while journal.process(batch_size=2)["processed"]:
        pass


def test_restart_duplicates_late_events_and_quality(tmp_path):
    path = tmp_path / "journal.sqlite3"
    with Journal(path) as journal:
        seed(journal)
        assert journal.process(2) == dict(processed=2, inserted=1, duplicates=1, rejected=0, skipped=0)
    with Journal(path) as journal:
        process_all(journal)
        status = journal.status()
        assert (status["raw_events"], status["positions"], status["rejected"], status["pending"]) == (5, 2, 1, 0)
        rows = journal.positions("999000001")
        assert rows[0]["event_time"] > rows[1]["event_time"]  # late arrival remains in history
        assert rows[1]["sog_knots"] is None
        assert rows[1]["cog_deg"] is None
        assert rows[1]["heading_deg"] is None
        assert journal.process()["processed"] == 0


def test_unexpected_failure_rolls_back_output_and_checkpoint(tmp_path):
    with Journal(tmp_path / "journal.sqlite3") as journal:
        seed(journal)

        def fail_second(row):
            if row["seq"] == 2:
                raise RuntimeError("simulated worker crash")
            return normalize(row)

        with pytest.raises(RuntimeError):
            journal.process(transform=fail_second)
        assert journal.status()["positions"] == 0
        assert journal.status()["checkpoint"] == 0
        process_all(journal)
        assert journal.status()["positions"] == 2


def test_export_restore_and_replay_preserves_provenance(tmp_path):
    with Journal(tmp_path / "original.sqlite3") as original:
        seed(original)
        # Missing provider timestamp: retain two separate receptions, marked explicitly.
        payload = json.loads(FIXTURE.read_text().splitlines()[0])
        del payload["MetaData"]["time_utc"]
        original.append(json.dumps(payload), RECEIVED)
        original.append(json.dumps(payload), RECEIVED)
        process_all(original)
        first = original.export_raw(tmp_path / "lake", batch_size=3)
        assert original.export_raw(tmp_path / "lake", batch_size=3) == first
        expected = original.positions("999000001")
        assert len([r for r in expected if r["time_basis"] == "received"]) == 2
        with Journal(tmp_path / "restored.sqlite3") as restored:
            assert restored.restore_raw(first["manifest"]) == {"stored": 7}
            assert restored.restore_raw(first["manifest"]) == {"stored": 0}
            process_all(restored)
            # Local sequence is not a cross-store ID; stable raw event ID is.
            strip = lambda rows: sorted(
                [{k: v for k, v in r.items() if k != "raw_seq"} for r in rows], key=lambda r: r["event_id"]
            )
            assert strip(restored.positions("999000001")) == strip(expected)
            original.append(FIXTURE.read_text().splitlines()[0], RECEIVED)
            second = original.export_raw(tmp_path / "lake", batch_size=3)
            assert restored.restore_raw(second["manifest"]) == {"stored": 1}
            process_all(restored)
            assert restored.status()["positions"] == 4


def test_corrupt_export_rejected(tmp_path):
    with Journal(tmp_path / "journal.sqlite3") as journal:
        seed(journal)
        export = journal.export_raw(tmp_path / "lake")
        path = tmp_path / "lake" / export["objects"][0]
        path.write_bytes(gzip.compress(b"corrupt"))
        with pytest.raises(ValueError, match="checksum"):
            journal.restore_raw(export["manifest"])


@pytest.mark.parametrize("payload", ["broken json", "[]", "{}"])
def test_bad_messages_preserved_and_quarantined(tmp_path, payload):
    with Journal(tmp_path / "journal.sqlite3") as journal:
        journal.append(payload, RECEIVED)
        assert journal.process()["rejected"] == 1
        assert journal.status()["raw_events"] == 1


def test_zero_coordinates_and_timestamp_quality(tmp_path):
    with Journal(tmp_path / "journal.sqlite3") as journal:
        payload = json.loads(FIXTURE.read_text().splitlines()[0])
        payload["Message"]["PositionReport"].update(Latitude=0, Longitude=0)
        journal.append(json.dumps(payload), RECEIVED)
        payload["MetaData"]["time_utc"] = "2026-09-14T00:00:00"  # unknown timezone
        journal.append(json.dumps(payload), RECEIVED)
        result = journal.process()
        assert (result["inserted"], result["rejected"]) == (1, 1)
        assert journal.positions("999000001")[0]["lat"] == 0
        assert utc_time("2026-09-14 02:00:00.123456789 +0000 UTC").endswith("02:00:00.123456+00:00")


def test_capture_disabled_and_failure_counted(monkeypatch):
    from backend.data_platform import capture

    mock = Mock()
    monkeypatch.setattr(capture, "get_journal", mock)
    monkeypatch.setattr(capture.config, "DATA_PLATFORM_ENABLED", False)
    capture.capture_message("{}")
    mock.assert_not_called()
    monkeypatch.setattr(capture.config, "DATA_PLATFORM_ENABLED", True)
    mock.side_effect = OSError("disk unavailable")
    metric = capture.capture_total.labels(outcome="failed")
    before = metric._value.get()
    capture.capture_message("{}")
    assert metric._value.get() == before + 1


def test_dataset_api(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routers import datasets

    with Journal(tmp_path / "journal.sqlite3") as journal:
        seed(journal)
        process_all(journal)
        monkeypatch.setattr(datasets.config, "DATA_PLATFORM_ENABLED", True)
        monkeypatch.setattr(datasets, "get_journal", lambda: journal)
        app = FastAPI()
        app.include_router(datasets.router, prefix="/api/v1")
        client = TestClient(app)
        assert client.get("/api/v1/datasets/status").json()["positions"] == 2
        rows = client.get("/api/v1/datasets/positions/999000001?limit=1").json()["positions"]
        assert len(rows) == 1 and rows[0]["source"] == "aisstream"
        assert client.get("/api/v1/datasets/positions/999000001?limit=1001").status_code == 422
        monkeypatch.setattr(datasets.config, "DATA_PLATFORM_ENABLED", False)
        assert client.get("/api/v1/datasets/status").json() == {"enabled": False}
        assert client.get("/api/v1/datasets/positions/999000001").status_code == 503


def test_live_proxy_boundary_captures_before_json_parsing(tmp_path, monkeypatch):
    import io
    import subprocess
    from types import SimpleNamespace

    from backend.services import ais_stream

    with Journal(tmp_path / "live.sqlite3") as journal:
        lines = iter(["not-json\n", '{"error":"synthetic upstream error"}\n'])

        def readline():
            value = next(lines, "")
            if not value:
                ais_stream._ws_running = False
            return value

        process = SimpleNamespace(stdout=SimpleNamespace(readline=readline), stderr=io.StringIO(""))
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: process)
        monkeypatch.setattr(ais_stream, "_ws_running", True)
        monkeypatch.setattr(ais_stream, "_ws_process", None)
        monkeypatch.setattr(ais_stream, "capture_message", journal.append)
        close = Mock()
        monkeypatch.setattr(ais_stream, "close_journal", close)
        ais_stream._run_ais_loop()
        close.assert_called_once()
        assert journal.status()["raw_events"] == 2
        assert journal.process()["rejected"] == 2

import json
import sqlite3

import pytest

from backend.data_platform.operations import backup, inventory


def test_backup_preserves_live_wal_and_does_not_overwrite(tmp_path):
    source = tmp_path / "source.db"
    db = sqlite3.connect(source)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE sample(id INTEGER)")
    db.execute("INSERT INTO sample VALUES(7)")
    db.commit()
    paths = {"journal": source, "missing": tmp_path / "not-created.db"}
    result = inventory(paths)
    assert result["journal"]["rows"]["sample"] == 1 and not result["missing"]["exists"]
    manifest = backup(tmp_path / "copy", paths)
    restored = sqlite3.connect(tmp_path / "copy/journal.sqlite3")
    assert restored.execute("SELECT * FROM sample").fetchall() == [(7,)]
    restored.close()
    assert "sha256" in manifest["files"]["journal"]
    assert json.loads((tmp_path / "copy/manifest.json").read_text()) == manifest
    with pytest.raises(FileExistsError):
        backup(tmp_path / "copy", paths)
    assert db.execute("SELECT * FROM sample").fetchall() == [(7,)]
    db.close()

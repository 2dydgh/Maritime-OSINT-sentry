"""Read-only storage inventory and verified SQLite backups for local operation."""

import argparse
import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from backend import config


def sources():
    return {"journal": Path(config.DATA_PLATFORM_DB)}


def readonly(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def inventory(paths=None):
    result = {}
    for name, path in (paths or sources()).items():
        path = Path(path)
        if not path.exists():
            result[name] = {"exists": False}
            continue
        db = readonly(path)
        try:
            tables = [
                r[0]
                for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            ]
            counts = {
                table: db.execute('SELECT COUNT(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
                for table in tables
            }
            result[name] = {
                "exists": True,
                "bytes": path.stat().st_size,
                "wal_bytes": Path(str(path) + "-wal").stat().st_size if Path(str(path) + "-wal").exists() else 0,
                "rows": counts,
            }
        finally:
            db.close()
    return result


def backup(directory, paths=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "files": {},
        "note": "DB별 일관된 순차 백업이며 전체 서비스의 단일 시점 스냅샷은 아닙니다. 원본을 삭제하지 않습니다.",
    }
    for name, path in (paths or sources()).items():
        path = Path(path)
        if not path.exists():
            continue
        target = directory / (name + ".sqlite3")
        src = readonly(path)
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Backup integrity check failed: " + name)
        finally:
            src.close()
            dst.close()
        digest = hashlib.sha256()
        with target.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        manifest["files"][name] = {"file": target.name, "bytes": target.stat().st_size, "sha256": digest.hexdigest()}
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    command = commands.add_parser("backup")
    command.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(inventory() if args.command == "status" else backup(args.directory), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

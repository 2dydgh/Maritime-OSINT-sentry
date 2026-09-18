"""Local ingest/process/export commands; never create cloud resources."""

import argparse
import json
import time
from pathlib import Path

from backend import config

from .journal import Journal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=config.DATA_PLATFORM_DB)
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("ingest", help="Store one AISStream JSON message per line")
    ingest.add_argument("file", type=Path)
    process = commands.add_parser("process", help="Incrementally normalize saved raw messages")
    process.add_argument("--follow", action="store_true", help="Poll for new raw messages every second")
    commands.add_parser("status")
    positions = commands.add_parser("positions")
    positions.add_argument("mmsi")
    positions.add_argument("--limit", type=int, default=100)
    export = commands.add_parser("export", help="Export a raw snapshot into immutable object files")
    export.add_argument("directory", type=Path)
    restore = commands.add_parser("restore", help="Import raw objects from an export manifest")
    restore.add_argument("manifest", type=Path)
    args = parser.parse_args()
    with Journal(args.db) as journal:
        if args.command == "ingest":
            count = 0
            with args.file.open() as f:
                for line in f:
                    if line.strip():
                        journal.append(line.rstrip("\r\n"))
                        count += 1
            result = {"stored": count}
        elif args.command == "process":
            total = {}
            try:
                while True:
                    batch = journal.process()
                    for key, value in batch.items():
                        total[key] = total.get(key, 0) + value
                    if not batch["processed"]:
                        if not args.follow:
                            break
                        time.sleep(1)
            except KeyboardInterrupt:
                pass
            result = total
        elif args.command == "status":
            result = journal.status()
        elif args.command == "positions":
            result = journal.positions(args.mmsi, args.limit)
        elif args.command == "restore":
            result = journal.restore_raw(args.manifest)
        else:
            result = journal.export_raw(args.directory)
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

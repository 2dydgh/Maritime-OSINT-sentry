"""
Data Fetcher Service

Manages periodic data snapshots for the API layer.
Runs on a 60-second interval to update latest_data.
"""

import logging
import time
from typing import Dict, List, Any

from apscheduler.schedulers.background import BackgroundScheduler

from .ais_stream import get_ais_vessels

logger = logging.getLogger(__name__)

# Global data store
latest_data: Dict[str, Any] = {
    "ships": [],
    "ships_by_type": {},
    "ship_count": 0,
    "last_updated": None,
}

_scheduler: BackgroundScheduler = None


def _group_ships_by_type(ships: List[dict]) -> Dict[str, List[dict]]:
    """Group ships by their type."""
    by_type: Dict[str, List[dict]] = {}
    for ship in ships:
        ship_type = ship.get("type", "unknown")
        if ship_type not in by_type:
            by_type[ship_type] = []
        by_type[ship_type].append(ship)
    return by_type


def fetch_ships() -> None:
    """Fetch current ship data and update latest_data."""
    try:
        ships = get_ais_vessels()
        ships_by_type = _group_ships_by_type(ships)

        latest_data["ships"] = ships
        latest_data["ships_by_type"] = ships_by_type
        latest_data["ship_count"] = len(ships)
        latest_data["last_updated"] = time.time()

        # Count by type for logging
        type_counts = {k: len(v) for k, v in ships_by_type.items() if v}
        logger.info(f"Data fetcher: {len(ships)} ships - {type_counts}")

    except Exception as e:
        logger.error(f"Error fetching ship data: {e}")


def start_data_fetcher() -> None:
    """Start the periodic data fetcher."""
    global _scheduler

    if _scheduler is not None:
        logger.warning("Data fetcher already running")
        return

    # Initial fetch
    fetch_ships()

    # Start scheduler
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(fetch_ships, 'interval', seconds=60, id='fetch_ships')
    _scheduler.start()

    logger.info("Data fetcher started (60s interval)")


def stop_data_fetcher() -> None:
    """Stop the periodic data fetcher."""
    global _scheduler

    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Data fetcher stopped")


def get_latest_data() -> Dict[str, Any]:
    """Get the latest data snapshot."""
    return latest_data

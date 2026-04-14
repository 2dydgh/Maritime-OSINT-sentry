"""
OpenSky Network REST API poller for real-time aircraft tracking.
Polls the OpenSky /states/all endpoint and maintains a live in-memory cache
of aircraft positions, classified by type (civilian/military/helicopter/other).
"""

import logging
import threading
import time

import httpx

from backend.config import OPENSKY_USERNAME, OPENSKY_PASSWORD

logger = logging.getLogger(__name__)

OPENSKY_API_URL = "https://opensky-network.org/api/states/all"
POLL_INTERVAL = 10  # seconds between polls

# ICAO24 hex address prefix → military nation
# Sources: ICAO Doc 9303 / aircraft address block allocations
_MILITARY_PREFIXES: dict[str, str] = {
    "ae": "US",
    "af": "US",
    "43c": "UK",
    "3a": "FR",
    "3f": "DE",
    "15": "RU",
    "78": "CN",
    "71": "KR",
    "84": "JP",
    "73": "IL",
    "7c": "AU",
}


def _is_military(icao24: str) -> bool:
    """Return True if the ICAO24 address falls within a known military block."""
    addr = icao24.lower().strip()
    for prefix in _MILITARY_PREFIXES:
        if addr.startswith(prefix):
            return True
    return False


def classify_aircraft(category: int, icao24: str) -> str:
    """
    Classify an aircraft into a rendering category.

    OpenSky category codes:
      0  = No information
      1  = No ADS-B emitter category info
      2  = Light (< 15 500 lbs)
      3  = Small (15 500 to 75 000 lbs)
      4  = Large (75 000 to 300 000 lbs)
      5  = High vortex large
      6  = Heavy (> 300 000 lbs)
      7  = High performance (> 5g, > 400 kts)
      8  = Rotorcraft
      9  = Glider / sailplane
      10 = Lighter-than-air
      11 = Parachutist / skydiver
      12 = Ultralight / hang-glider / paraglider
      13 = Reserved
      14 = Unmanned aerial vehicle
      15 = Space / transatmospheric vehicle
      16 = Surface vehicle — emergency
      17 = Surface vehicle — service
      18 = Point obstacle
      19 = Cluster obstacle
      20 = Line obstacle
    """
    # Military ICAO block takes priority
    if _is_military(icao24):
        return "military"

    # Rotorcraft → helicopter
    if category == 8:
        return "helicopter"

    # Conventional powered aircraft (categories 2-6)
    if 2 <= category <= 6:
        return "civilian"

    # High-performance aircraft → military-like behaviour
    if category == 7:
        return "military"

    # No category info (0 or 1) — default to civilian (most aircraft are)
    if category in (0, 1):
        return "civilian"

    return "other"


# Global aircraft store: icao24 → aircraft dict
_aircraft: dict[str, dict] = {}
_aircraft_lock = threading.Lock()

_tracker_thread: threading.Thread | None = None
_tracker_running = False


def get_aircraft() -> list[dict]:
    """
    Return a snapshot of currently tracked airborne aircraft.

    Prunes entries not updated within the last 60 seconds and skips
    aircraft reported as on_ground.
    """
    now = time.time()
    stale_cutoff = now - 60  # 60-second staleness window

    with _aircraft_lock:
        total_before = len(_aircraft)
        # Prune stale entries in-place
        stale_keys = [k for k, v in _aircraft.items() if v.get("_updated", 0) < stale_cutoff]
        for k in stale_keys:
            del _aircraft[k]

        ground_count = 0
        no_pos_count = 0
        result = []
        for icao24, ac in _aircraft.items():
            # Skip ground traffic
            if ac.get("on_ground"):
                ground_count += 1
                continue
            if ac.get("lat") is None or ac.get("lng") is None:
                no_pos_count += 1
                continue

            result.append({
                "icao24": icao24,
                "callsign": ac.get("callsign", ""),
                "lat": ac.get("lat"),
                "lng": ac.get("lng"),
                "altitude": ac.get("altitude"),
                "velocity": ac.get("velocity"),
                "heading": ac.get("heading"),
                "vertical_rate": ac.get("vertical_rate"),
                "on_ground": ac.get("on_ground", False),
                "category": ac.get("type", "other"),
                "origin_country": ac.get("origin_country", ""),
            })

    logger.info(f"get_aircraft: total={total_before}, pruned={len(stale_keys)}, ground={ground_count}, no_pos={no_pos_count}, airborne={len(result)}")
    return result


def _poll_opensky() -> None:
    """
    Fetch the current state vectors from OpenSky and update the in-memory cache.

    OpenSky state vector field indices:
      0  icao24
      1  callsign
      2  origin_country
      3  time_position
      4  last_contact
      5  longitude
      6  latitude
      7  baro_altitude
      8  on_ground
      9  velocity
      10 true_track  (heading)
      11 vertical_rate
      12 sensors
      13 geo_altitude
      14 squawk
      15 spi
      16 position_source
      17 category
    """
    auth = None
    if OPENSKY_USERNAME and OPENSKY_PASSWORD:
        auth = (OPENSKY_USERNAME, OPENSKY_PASSWORD)

    with httpx.Client(timeout=15.0) as client:
        if auth:
            response = client.get(OPENSKY_API_URL, auth=auth)
        else:
            response = client.get(OPENSKY_API_URL)

        response.raise_for_status()
        data = response.json()

    states = data.get("states") or []
    now = time.time()

    with _aircraft_lock:
        for sv in states:
            if not sv or len(sv) < 17:
                continue

            icao24 = (sv[0] or "").strip()
            if not icao24:
                continue

            lat = sv[6]
            lng = sv[5]

            # Skip aircraft without a valid position
            if lat is None or lng is None:
                continue

            callsign = (sv[1] or "").strip()
            origin_country = sv[2] or ""
            on_ground = bool(sv[8])
            baro_altitude = sv[7]
            geo_altitude = sv[13]
            altitude = baro_altitude if baro_altitude is not None else geo_altitude
            velocity = sv[9]
            heading = sv[10]
            vertical_rate = sv[11]
            category = int(sv[17]) if len(sv) > 17 and sv[17] is not None else 0

            _aircraft[icao24] = {
                "icao24": icao24,
                "callsign": callsign,
                "origin_country": origin_country,
                "lat": lat,
                "lng": lng,
                "altitude": altitude,
                "velocity": velocity,
                "heading": heading,
                "vertical_rate": vertical_rate,
                "on_ground": on_ground,
                "category": category,
                "type": classify_aircraft(category, icao24),
                "_updated": now,
            }

    with _aircraft_lock:
        dict_size = len(_aircraft)
    logger.info(f"OpenSky poll complete: {len(states)} state vectors received, dict size after update: {dict_size}")


def _tracker_loop() -> None:
    """
    Background polling loop with exponential backoff on failure.
    Sleeps in 1-second increments so the thread responds quickly to shutdown.
    """
    backoff = POLL_INTERVAL  # start at normal interval

    while _tracker_running:
        try:
            _poll_opensky()
            backoff = POLL_INTERVAL  # reset on success
        except Exception as exc:
            logger.error(f"OpenSky poll failed: {exc}")
            backoff = min(backoff * 2, 120)  # double up to 120 s max
            logger.info(f"Retrying OpenSky poll in {backoff}s")

        # Sleep in 1-second increments for quick shutdown response
        elapsed = 0
        while _tracker_running and elapsed < backoff:
            time.sleep(1)
            elapsed += 1


def start_aircraft_tracker() -> None:
    """Start the OpenSky polling loop in a daemon background thread."""
    global _tracker_thread, _tracker_running

    if _tracker_thread and _tracker_thread.is_alive():
        logger.info("Aircraft tracker already running")
        return

    _tracker_running = True
    _tracker_thread = threading.Thread(
        target=_tracker_loop,
        daemon=True,
        name="aircraft-tracker",
    )
    _tracker_thread.start()
    logger.info("Aircraft tracker background thread started")


def stop_aircraft_tracker() -> None:
    """Signal the background polling thread to stop."""
    global _tracker_running
    _tracker_running = False
    logger.info("Aircraft tracker stopping...")

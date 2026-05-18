"""Mock vessel simulator for Korean coastal demo mode.

Spawns 25-30 simulated vessels around major Korean ports. Vessels move
along port-to-port routes with light randomization. Active only when demo
mode is toggled on.

Movement (tick + background loop) added in Task 10.
"""
import logging
import math
import random
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

# ── Korean port seeds (lat, lng) ──────────────────────────────────────
_PORTS = {
    "busan":     (35.08, 129.10),
    "ulsan":     (35.49, 129.42),
    "gwangyang": (34.90, 127.75),
    "mokpo":     (34.78, 126.39),
    "incheon":   (37.45, 126.50),
    "pyeongtaek":(36.95, 126.78),
    "jeju":      (33.51, 126.53),
}

# ── Constants ─────────────────────────────────────────────────────────
_EARTH_RADIUS_NM = 3440.065
KOREA_BBOX = (33.0, 39.5, 124.0, 132.0)

# ── State ──────────────────────────────────────────────────────────────
_lock = threading.Lock()
_vessels: dict[int, dict] = {}
_active = False
_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None

_next_mmsi = 999_000_001


def is_active() -> bool:
    return _active


def snapshot() -> list[dict]:
    """Return mock vessels in get_ais_vessels-compatible shape."""
    with _lock:
        return [_to_ais_shape(v) for v in _vessels.values()]


def _to_ais_shape(v: dict) -> dict:
    return {
        "mmsi": v["mmsi"],
        "name": v["name"],
        "type": v["type"],
        "lat":  round(v["lat"], 5),
        "lng":  round(v["lng"], 5),
        "heading": int(v["cog"]) % 360,
        "sog":  round(v["sog"], 1),
        "cog":  round(v["cog"], 1),
        "callsign": v["callsign"],
        "destination": v["destination"],
        "imo": 0,
        "country": "KR",
        "length": v["length"],
        "beam":   v["beam"],
        "draught": v["draught"],
        "eta": "",
        "ais_class": v["ais_class"],
        "status": "기관 항해 중",
        "is_simulated": True,
    }


def _next_destination(origin: str) -> str:
    others = [p for p in _PORTS if p != origin]
    return random.choice(others).upper()


def _spawn_initial() -> None:
    """Spawn 3-5 vessels near each port (total ~25-30)."""
    global _next_mmsi
    type_pool = [("cargo", "A"), ("tanker", "A"), ("fishing", "B")] * 3
    for port_name, (lat0, lng0) in _PORTS.items():
        n = random.randint(3, 5)
        for _ in range(n):
            jitter_lat = random.uniform(-0.15, 0.15)
            jitter_lng = random.uniform(-0.15, 0.15)
            vtype, ais_class = random.choice(type_pool)
            cog = random.uniform(0, 360)
            sog = random.uniform(8.0, 16.0) if vtype != "fishing" else random.uniform(3.0, 8.0)
            v = {
                "mmsi": _next_mmsi,
                "name": f"SIM-{port_name[:3].upper()}-{_next_mmsi % 1000:03d}",
                "type": vtype,
                "lat": lat0 + jitter_lat,
                "lng": lng0 + jitter_lng,
                "sog": sog,
                "cog": cog,
                "callsign": f"V{_next_mmsi % 10000}",
                "destination": _next_destination(port_name),
                "length": random.randint(80, 280) if ais_class == "A" else random.randint(15, 50),
                "beam":   random.randint(15, 40) if ais_class == "A" else random.randint(4, 10),
                "draught": random.uniform(5.0, 14.0) if ais_class == "A" else random.uniform(1.5, 4.0),
                "ais_class": ais_class,
                "_origin": port_name,
            }
            _vessels[_next_mmsi] = v
            _next_mmsi += 1


def _forward_project(lat: float, lng: float, cog_deg: float, dist_nm: float) -> tuple[float, float]:
    """Move (lat, lng) along bearing cog by dist_nm. Returns new (lat, lng)."""
    to_rad = math.pi / 180
    to_deg = 180 / math.pi
    lat1 = lat * to_rad
    lon1 = lng * to_rad
    brng = cog_deg * to_rad
    d = dist_nm / _EARTH_RADIUS_NM
    lat2 = math.asin(math.sin(lat1) * math.cos(d) +
                     math.cos(lat1) * math.sin(d) * math.cos(brng))
    lon2 = lon1 + math.atan2(math.sin(brng) * math.sin(d) * math.cos(lat1),
                             math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return lat2 * to_deg, lon2 * to_deg


def _bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial bearing in degrees from (lat1,lng1) to (lat2,lng2)."""
    to_rad = math.pi / 180
    to_deg = 180 / math.pi
    dLon = (lng2 - lng1) * to_rad
    y = math.sin(dLon) * math.cos(lat2 * to_rad)
    x = math.cos(lat1 * to_rad) * math.sin(lat2 * to_rad) - \
        math.sin(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.cos(dLon)
    return (math.atan2(y, x) * to_deg + 360) % 360


def _tick_once(dt_sec: float = 1.0) -> None:
    """Advance every mock vessel by dt_sec seconds."""
    with _lock:
        for v in _vessels.values():
            v["cog"] = (v["cog"] + random.uniform(-2.0, 2.0)) % 360
            v["sog"] = max(2.0, min(20.0, v["sog"] + random.uniform(-0.5, 0.5)))
            dist_nm = v["sog"] * (dt_sec / 3600.0)
            new_lat, new_lng = _forward_project(v["lat"], v["lng"], v["cog"], dist_nm)

            min_lat, max_lat, min_lng, max_lng = KOREA_BBOX
            if not (min_lat + 0.2 < new_lat < max_lat - 0.2 and
                    min_lng + 0.2 < new_lng < max_lng - 0.2):
                # Out of bounds — pick a new target port and aim toward it (don't advance this tick)
                target = _PORTS[random.choice(list(_PORTS.keys()))]
                v["cog"] = _bearing(v["lat"], v["lng"], target[0], target[1])
            else:
                v["lat"] = new_lat
                v["lng"] = new_lng


def _run_loop() -> None:
    """Background loop — advances mock vessels until stop_event is set."""
    last = time.time()
    while not _stop_event.is_set():
        now = time.time()
        dt = now - last
        last = now
        try:
            _tick_once(dt_sec=dt)
        except Exception:
            logger.exception("mock vessel tick failed")
        _stop_event.wait(timeout=1.0)


def start() -> None:
    """Start the mock simulator: clear state, spawn vessels, run background loop."""
    global _active, _thread
    if _active:
        return
    with _lock:
        _vessels.clear()
        _spawn_initial()
    _active = True
    _stop_event.clear()
    _thread = threading.Thread(target=_run_loop, daemon=True, name="mock-vessel-loop")
    _thread.start()
    logger.info("mock_vessel_service started with %d vessels", len(_vessels))


def stop() -> None:
    """Stop the simulator, join the thread, clear state."""
    global _active, _thread
    _active = False
    _stop_event.set()
    if _thread is not None:
        _thread.join(timeout=2.0)
        _thread = None
    _stop_event.clear()
    with _lock:
        _vessels.clear()

"""Mock vessel simulator for Korean coastal demo mode.

Spawns 25-30 simulated vessels around major Korean ports. Vessels move
along port-to-port routes with light randomization. Active only when demo
mode is toggled on.

Movement (tick + background loop) added in Task 10.
"""
import logging
import random
import threading
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

# ── State ──────────────────────────────────────────────────────────────
_lock = threading.Lock()
_vessels: dict[int, dict] = {}
_active = False

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


def start() -> None:
    """Start the mock simulator: clear state, spawn initial vessels."""
    global _active
    if _active:
        return
    with _lock:
        _vessels.clear()
        _spawn_initial()
    _active = True
    logger.info("mock_vessel_service started with %d vessels", len(_vessels))


def stop() -> None:
    """Stop the simulator and clear state."""
    global _active
    _active = False
    with _lock:
        _vessels.clear()

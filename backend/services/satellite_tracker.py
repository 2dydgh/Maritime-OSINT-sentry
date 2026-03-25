"""
Satellite Tracker Service

Fetches live GP orbital elements from CelesTrak and propagates positions
using SGP4. Filters to intelligence-relevant satellites only.

Uses fetch_with_curl to bypass CDN blocks that affect plain Python HTTP.
"""

import logging
import math
import time
import re
from datetime import datetime
from cachetools import TTLCache
from .network_utils import fetch_with_curl

logger = logging.getLogger(__name__)

# Cache GP data — re-download from CelesTrak only every 30 minutes
_sat_gp_cache = {"data": None, "last_fetch": 0}

# Results cache — 30 min TTL
_results_cache = TTLCache(maxsize=1, ttl=1800)

# Intel satellite classification DB — matches original Shadowbroker list exactly
_SAT_INTEL_DB = [
    # Military reconnaissance / imaging
    ("USA 224", {"country": "USA", "mission": "military_recon", "sat_type": "KH-11 Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/KH-11_KENNEN"}),
    ("USA 245", {"country": "USA", "mission": "military_recon", "sat_type": "KH-11 Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/KH-11_KENNEN"}),
    ("USA 290", {"country": "USA", "mission": "military_recon", "sat_type": "KH-11 Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/KH-11_KENNEN"}),
    ("USA 314", {"country": "USA", "mission": "military_recon", "sat_type": "KH-11 Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/KH-11_KENNEN"}),
    ("USA 338", {"country": "USA", "mission": "military_recon", "sat_type": "Keyhole Successor", "wiki": "https://en.wikipedia.org/wiki/KH-11_KENNEN"}),
    ("TOPAZ", {"country": "Russia", "mission": "military_recon", "sat_type": "Optical Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/Persona_(satellite)"}),
    ("PERSONA", {"country": "Russia", "mission": "military_recon", "sat_type": "Optical Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/Persona_(satellite)"}),
    ("KONDOR", {"country": "Russia", "mission": "military_sar", "sat_type": "SAR Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/Kondor_(satellite)"}),
    ("BARS-M", {"country": "Russia", "mission": "military_recon", "sat_type": "Mapping Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/Bars-M"}),
    ("YAOGAN", {"country": "China", "mission": "military_recon", "sat_type": "Remote Sensing / ELINT", "wiki": "https://en.wikipedia.org/wiki/Yaogan"}),
    ("GAOFEN", {"country": "China", "mission": "military_recon", "sat_type": "High-Res Imaging", "wiki": "https://en.wikipedia.org/wiki/Gaofen"}),
    ("JILIN", {"country": "China", "mission": "commercial_imaging", "sat_type": "Video / Imaging", "wiki": "https://en.wikipedia.org/wiki/Jilin-1"}),
    ("OFEK", {"country": "Israel", "mission": "military_recon", "sat_type": "Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/Ofeq"}),
    ("CSO", {"country": "France", "mission": "military_recon", "sat_type": "Optical Reconnaissance", "wiki": "https://en.wikipedia.org/wiki/CSO_(satellite)"}),
    ("IGS", {"country": "Japan", "mission": "military_recon", "sat_type": "Intelligence Gathering", "wiki": "https://en.wikipedia.org/wiki/Information_Gathering_Satellite"}),
    # SAR
    ("CAPELLA", {"country": "USA", "mission": "sar", "sat_type": "SAR Imaging", "wiki": "https://en.wikipedia.org/wiki/Capella_Space"}),
    ("ICEYE", {"country": "Finland", "mission": "sar", "sat_type": "SAR Microsatellite", "wiki": "https://en.wikipedia.org/wiki/ICEYE"}),
    ("COSMO-SKYMED", {"country": "Italy", "mission": "sar", "sat_type": "SAR Constellation", "wiki": "https://en.wikipedia.org/wiki/COSMO-SkyMed"}),
    ("TANDEM", {"country": "Germany", "mission": "sar", "sat_type": "SAR Interferometry", "wiki": "https://en.wikipedia.org/wiki/TanDEM-X"}),
    ("PAZ", {"country": "Spain", "mission": "sar", "sat_type": "SAR Imaging", "wiki": "https://en.wikipedia.org/wiki/PAZ_(satellite)"}),
    # Commercial imaging
    ("WORLDVIEW", {"country": "USA", "mission": "commercial_imaging", "sat_type": "Maxar High-Res", "wiki": "https://en.wikipedia.org/wiki/WorldView-3"}),
    ("GEOEYE", {"country": "USA", "mission": "commercial_imaging", "sat_type": "Maxar Imaging", "wiki": "https://en.wikipedia.org/wiki/GeoEye-1"}),
    ("PLEIADES", {"country": "France", "mission": "commercial_imaging", "sat_type": "Airbus Imaging", "wiki": "https://en.wikipedia.org/wiki/Pl%C3%A9iades_(satellite)"}),
    ("SPOT", {"country": "France", "mission": "commercial_imaging", "sat_type": "Airbus Medium-Res", "wiki": "https://en.wikipedia.org/wiki/SPOT_(satellite)"}),
    ("PLANET", {"country": "USA", "mission": "commercial_imaging", "sat_type": "PlanetScope", "wiki": "https://en.wikipedia.org/wiki/Planet_Labs"}),
    ("SKYSAT", {"country": "USA", "mission": "commercial_imaging", "sat_type": "Planet Video", "wiki": "https://en.wikipedia.org/wiki/SkySat"}),
    ("BLACKSKY", {"country": "USA", "mission": "commercial_imaging", "sat_type": "BlackSky Imaging", "wiki": "https://en.wikipedia.org/wiki/BlackSky"}),
    # SIGINT
    ("NROL", {"country": "USA", "mission": "sigint", "sat_type": "Classified NRO", "wiki": "https://en.wikipedia.org/wiki/National_Reconnaissance_Office"}),
    ("MENTOR", {"country": "USA", "mission": "sigint", "sat_type": "SIGINT / ELINT", "wiki": "https://en.wikipedia.org/wiki/Mentor_(satellite)"}),
    ("LUCH", {"country": "Russia", "mission": "sigint", "sat_type": "Relay / SIGINT", "wiki": "https://en.wikipedia.org/wiki/Luch_(satellite)"}),
    ("SHIJIAN", {"country": "China", "mission": "sigint", "sat_type": "ELINT / Tech Demo", "wiki": "https://en.wikipedia.org/wiki/Shijian"}),
    ("HAWK", {"country": "USA", "mission": "sigint", "sat_type": "RF SIGINT / Maritime", "wiki": "https://en.wikipedia.org/wiki/HawkEye_360"}),
    # Navigation
    ("NAVSTAR", {"country": "USA", "mission": "navigation", "sat_type": "GPS", "wiki": "https://en.wikipedia.org/wiki/GPS_satellite_blocks"}),
    ("GLONASS", {"country": "Russia", "mission": "navigation", "sat_type": "GLONASS", "wiki": "https://en.wikipedia.org/wiki/GLONASS"}),
    ("BEIDOU", {"country": "China", "mission": "navigation", "sat_type": "BeiDou", "wiki": "https://en.wikipedia.org/wiki/BeiDou"}),
    ("GALILEO", {"country": "EU", "mission": "navigation", "sat_type": "Galileo", "wiki": "https://en.wikipedia.org/wiki/Galileo_(satellite_navigation)"}),
    # Early warning
    ("SBIRS", {"country": "USA", "mission": "early_warning", "sat_type": "Missile Warning", "wiki": "https://en.wikipedia.org/wiki/Space-Based_Infrared_System"}),
    ("TUNDRA", {"country": "Russia", "mission": "early_warning", "sat_type": "Missile Warning", "wiki": "https://en.wikipedia.org/wiki/Tundra_(satellite)"}),
    # Space stations
    ("ISS", {"country": "Intl", "mission": "space_station", "sat_type": "Space Station", "wiki": "https://en.wikipedia.org/wiki/International_Space_Station"}),
    ("TIANGONG", {"country": "China", "mission": "space_station", "sat_type": "Space Station", "wiki": "https://en.wikipedia.org/wiki/Tiangong_space_station"}),
]


def _gmst(jd_ut1: float) -> float:
    """Greenwich Mean Sidereal Time in radians from Julian Date."""
    t = (jd_ut1 - 2451545.0) / 36525.0
    gmst_sec = (67310.54841 + (876600.0 * 3600 + 8640184.812866) * t
                + 0.093104 * t * t - 6.2e-6 * t * t * t)
    return (gmst_sec % 86400) / 86400.0 * 2 * math.pi


def _fetch_satellites_from_tle_api():
    """Fallback: fetch satellite TLEs from tle.ivanstanojevic.me when CelesTrak is blocked."""
    search_terms = set()
    for key, _ in _SAT_INTEL_DB:
        term = key.split()[0] if len(key.split()) > 1 and key.split()[0] in ("USA", "NROL") else key
        search_terms.add(term)

    # 디스크 캐시를 먼저 로드해서 기존 데이터 보존
    existing = _load_gp_cache() or []
    seen_ids = {s.get("NORAD_CAT_ID") for s in existing}
    new_count = 0

    for i, term in enumerate(search_terms):
        try:
            # Rate limit: 1.5초 간격으로 요청
            if i > 0:
                time.sleep(1.5)
            url = f"https://tle.ivanstanojevic.me/api/tle/?search={term}&page_size=100&format=json"
            response = fetch_with_curl(url, timeout=10)
            if response.status_code != 200:
                logger.debug(f"TLE fallback search '{term}' returned {response.status_code}")
                continue
            data = response.json()
            for member in data.get("member", []):
                sat_id = member.get("satelliteId")
                if sat_id in seen_ids:
                    continue
                seen_ids.add(sat_id)
                line1 = member.get("line1", "")
                line2 = member.get("line2", "")
                if not (line1.startswith("1 ") and line2.startswith("2 ")):
                    continue
                gp = _tle_to_gp(member.get("name", "UNKNOWN"), sat_id, line1, line2)
                if gp:
                    existing.append(gp)
                    new_count += 1
            logger.debug(f"TLE fallback search '{term}': done ({len(existing)} total)")
        except Exception as e:
            logger.debug(f"TLE fallback search '{term}' failed: {e}")

    # 결과를 디스크에 저장 (다음 시작 시 즉시 사용)
    if existing:
        _save_gp_cache(existing)
    logger.info(f"TLE fallback: {new_count} new, {len(existing)} total (cached to disk)")
    return existing


def _tle_to_gp(name, norad_id, line1, line2):
    """Convert TLE line1/line2 to GP-style dict."""
    try:
        incl = float(line2[8:16].strip())
        raan = float(line2[17:25].strip())
        ecc = float("0." + line2[26:33].strip())
        argp = float(line2[34:42].strip())
        ma = float(line2[43:51].strip())
        mm = float(line2[52:63].strip())
        bstar_str = line1[53:61].strip()
        bstar = 0.0
        if bstar_str:
            try:
                mantissa = float(bstar_str[:-2]) / 1e5
                exponent = int(bstar_str[-2:])
                bstar = mantissa * (10 ** exponent)
            except Exception:
                pass
        epoch_yr = int(line1[18:20])
        epoch_day = float(line1[20:32].strip())
        year = 2000 + epoch_yr if epoch_yr < 57 else 1900 + epoch_yr
        from datetime import timedelta
        epoch_dt = datetime(year, 1, 1) + timedelta(days=epoch_day - 1)
        return {
            "OBJECT_NAME": name,
            "NORAD_CAT_ID": norad_id,
            "MEAN_MOTION": mm,
            "ECCENTRICITY": ecc,
            "INCLINATION": incl,
            "RA_OF_ASC_NODE": raan,
            "ARG_OF_PERICENTER": argp,
            "MEAN_ANOMALY": ma,
            "BSTAR": bstar,
            "EPOCH": epoch_dt.strftime("%Y-%m-%dT%H:%M:%S"),
        }
    except Exception:
        return None


import os, json as _json

_SAT_CACHE_FILE = os.path.join(os.path.dirname(__file__), "sat_gp_cache.json")

def _save_gp_cache(data):
    """Save GP data to disk for persistence across restarts."""
    try:
        with open(_SAT_CACHE_FILE, "w") as f:
            _json.dump(data, f)
        logger.debug(f"Saved {len(data)} GP records to disk cache")
    except Exception as e:
        logger.warning(f"Failed to save GP cache: {e}")

def _load_gp_cache():
    """Load GP data from disk cache."""
    try:
        if os.path.exists(_SAT_CACHE_FILE):
            with open(_SAT_CACHE_FILE) as f:
                data = _json.load(f)
            logger.info(f"Loaded {len(data)} GP records from disk cache")
            return data
    except Exception as e:
        logger.warning(f"Failed to load GP cache: {e}")
    return None


def fetch_intel_satellites():
    """Fetch and return the current list of intelligence satellite positions."""
    if "data" in _results_cache:
        return _results_cache["data"]

    sats = []
    try:
        from sgp4.api import Satrec, WGS72, jday

        # Fetch/refresh GP data from CelesTrak every 30 minutes
        now_ts = time.time()
        if _sat_gp_cache["data"] is None or (now_ts - _sat_gp_cache["last_fetch"]) > 1800:
            # 1) 디스크 캐시를 먼저 로드 — 즉시 사용 가능하게
            if _sat_gp_cache["data"] is None:
                disk_data = _load_gp_cache()
                if disk_data:
                    _sat_gp_cache["data"] = disk_data
                    _sat_gp_cache["last_fetch"] = now_ts
                    logger.info("Satellites: Using disk cache while attempting online refresh")

            # 2) 온라인 갱신 시도 (짧은 타임아웃, 실패해도 캐시 데이터로 동작)
            online_success = False
            gp_urls = [
                "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
                "https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
            ]
            for url in gp_urls:
                try:
                    response = fetch_with_curl(url, timeout=5)
                    if response.status_code == 200:
                        gp_data = response.json()
                        if isinstance(gp_data, list) and len(gp_data) > 100:
                            _sat_gp_cache["data"] = gp_data
                            _sat_gp_cache["last_fetch"] = now_ts
                            _save_gp_cache(gp_data)
                            logger.info(f"Satellites: Downloaded {len(gp_data)} GP records from {url}")
                            online_success = True
                            break
                except Exception as e:
                    logger.warning(f"Satellites: Failed to fetch from {url}: {e}")

            # 3) CelesTrak 실패 + 캐시도 없을 때만 TLE fallback
            if not online_success and _sat_gp_cache["data"] is None:
                logger.info("Satellites: CelesTrak unreachable and no cache, trying TLE fallback API...")
                fallback_data = _fetch_satellites_from_tle_api()
                if fallback_data and len(fallback_data) > 5:
                    _sat_gp_cache["data"] = fallback_data
                    _sat_gp_cache["last_fetch"] = now_ts

        data = _sat_gp_cache["data"]
        if not data:
            logger.warning("No satellite GP data available from any source")
            return []

        # Filter to intel-classified satellites
        classified = []
        for sat in data:
            name = sat.get("OBJECT_NAME", "UNKNOWN").upper()
            intel = None
            for key, meta in _SAT_INTEL_DB:
                if key.upper() in name:
                    intel = dict(meta)
                    break
            if not intel:
                continue
            entry = {
                "id": sat.get("NORAD_CAT_ID"),
                "name": sat.get("OBJECT_NAME", "UNKNOWN"),
                "MEAN_MOTION": sat.get("MEAN_MOTION"),
                "ECCENTRICITY": sat.get("ECCENTRICITY"),
                "INCLINATION": sat.get("INCLINATION"),
                "RA_OF_ASC_NODE": sat.get("RA_OF_ASC_NODE"),
                "ARG_OF_PERICENTER": sat.get("ARG_OF_PERICENTER"),
                "MEAN_ANOMALY": sat.get("MEAN_ANOMALY"),
                "BSTAR": sat.get("BSTAR"),
                "EPOCH": sat.get("EPOCH"),
            }
            entry.update(intel)
            classified.append(entry)

        logger.info(f"Satellites: {len(classified)} intel-classified out of {len(data)} total")

        # Propagate with SGP4
        now = datetime.utcnow()
        jd, fr = jday(now.year, now.month, now.day, now.hour, now.minute,
                      now.second + now.microsecond / 1e6)

        for s in classified:
            try:
                mean_motion = s.get("MEAN_MOTION")
                ecc = s.get("ECCENTRICITY")
                incl = s.get("INCLINATION")
                raan = s.get("RA_OF_ASC_NODE")
                argp = s.get("ARG_OF_PERICENTER")
                ma = s.get("MEAN_ANOMALY")
                bstar = s.get("BSTAR", 0)
                epoch_str = s.get("EPOCH")
                norad_id = s.get("id", 0)

                if mean_motion is None or ecc is None or incl is None or not epoch_str:
                    continue

                epoch_dt = datetime.strptime(epoch_str[:19], "%Y-%m-%dT%H:%M:%S")
                epoch_jd, epoch_fr = jday(epoch_dt.year, epoch_dt.month, epoch_dt.day,
                                          epoch_dt.hour, epoch_dt.minute, epoch_dt.second)

                sat_obj = Satrec()
                sat_obj.sgp4init(
                    WGS72, "i", norad_id,
                    (epoch_jd + epoch_fr) - 2433281.5,
                    bstar, 0.0, 0.0, ecc,
                    math.radians(argp), math.radians(incl),
                    math.radians(ma),
                    mean_motion * 2 * math.pi / 1440.0,
                    math.radians(raan)
                )

                e, r, v = sat_obj.sgp4(jd, fr)
                if e != 0:
                    continue

                x, y, z = r
                vx, vy, vz = v
                gmst = _gmst(jd + fr)
                lng_rad = math.atan2(y, x) - gmst
                lat_rad = math.atan2(z, math.sqrt(x * x + y * y))
                alt_km = math.sqrt(x * x + y * y + z * z) - 6371.0

                lat_deg = math.degrees(lat_rad)
                lng_deg = math.degrees(lng_rad) % 360
                lng_deg = lng_deg - 360 if lng_deg > 180 else lng_deg

                # Ground-relative velocity → speed & heading
                omega_e = 7.2921159e-5
                vx_g = vx + omega_e * y
                vy_g = vy - omega_e * x
                cos_lat = math.cos(lat_rad)
                sin_lat = math.sin(lat_rad)
                ecef_lng = lng_rad + gmst
                cos_lng = math.cos(ecef_lng)
                sin_lng = math.sin(ecef_lng)
                v_east = -sin_lng * vx_g + cos_lng * vy_g
                v_north = (-sin_lat * cos_lng * vx_g - sin_lat * sin_lng * vy_g
                           + cos_lat * vz)
                ground_speed_kms = math.sqrt(v_east ** 2 + v_north ** 2)
                speed_knots = round(ground_speed_kms * 1943.84, 1)
                heading = round(math.degrees(math.atan2(v_east, v_north)) % 360, 1)

                # Wikipedia link for USA-NNN classified satellites
                wiki = s.get("wiki", "")
                usa_match = re.search(r"USA[\s\-]*(\d+)", s.get("name", ""))
                if usa_match:
                    wiki = f"https://en.wikipedia.org/wiki/USA-{usa_match.group(1)}"

                sats.append({
                    "id": str(norad_id),
                    "name": s.get("name", "UNKNOWN"),
                    "lat": round(lat_deg, 4),
                    "lng": round(lng_deg, 4),
                    "alt_km": round(alt_km, 1),
                    "speed_knots": speed_knots,
                    "heading": heading,
                    "mission": s.get("mission"),
                    "country": s.get("country"),
                    "sat_type": s.get("sat_type"),
                    "wiki": wiki,
                    # GP orbital elements for client-side propagation
                    "gp": {
                        "MEAN_MOTION": mean_motion,
                        "ECCENTRICITY": ecc,
                        "INCLINATION": incl,
                        "RA_OF_ASC_NODE": raan,
                        "ARG_OF_PERICENTER": argp,
                        "MEAN_ANOMALY": ma,
                        "BSTAR": bstar,
                        "EPOCH": epoch_str,
                    },
                })

            except Exception:
                continue

        logger.info(f"Satellites: {len(sats)} successfully positioned")

    except Exception as e:
        logger.error(f"Satellite fetch error: {e}")

    if sats:
        _results_cache["data"] = sats
    return sats

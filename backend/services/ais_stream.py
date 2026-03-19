"""
AIS Stream WebSocket client for real-time maritime vessel tracking.
Connects to aisstream.io and maintains a live dictionary of global vessel positions.
"""

import asyncio
import json
import logging
import threading
import time
from datetime import datetime, timezone
import os

from . import history_writer
from backend.services.metrics import ais_messages_total, ais_vessels_active, alerts_fired_total

logger = logging.getLogger(__name__)

AIS_WS_URL = "wss://stream.aisstream.io/v0/stream"
from backend.config import AIS_API_KEY
API_KEY = AIS_API_KEY

# AIS vessel type code classification
# See: https://coast.noaa.gov/data/marinecadastre/ais/VesselTypeCodes2018.pdf
def classify_vessel(ais_type: int, mmsi: int) -> str:
    """Classify a vessel by its AIS type code into a rendering category."""
    if 80 <= ais_type <= 89:
        return "tanker"        # Oil/Chemical/Gas tankers → RED
    if 70 <= ais_type <= 79:
        return "cargo"         # Cargo ships, container vessels → RED
    if 60 <= ais_type <= 69:
        return "passenger"     # Cruise ships, ferries → GRAY
    if ais_type in (36, 37):
        return "yacht"         # Sailing/Pleasure craft → DARK BLUE
    if ais_type == 35:
        return "military_vessel"  # Military → YELLOW
    # MMSI-based military detection: military MMSIs often start with certain prefixes
    mmsi_str = str(mmsi)
    if mmsi_str.startswith("3380") or mmsi_str.startswith("3381"):
        return "military_vessel"  # US Navy
    if ais_type in (30, 31, 32, 33, 34):
        return "other"         # Fishing, towing, dredging, diving, etc.
    if ais_type in (50, 51, 52, 53, 54, 55, 56, 57, 58, 59):
        return "other"         # Pilot, SAR, tug, port tender, etc.
    return "unknown"            # Not yet classified — will update when ShipStaticData arrives


# MMSI Maritime Identification Digit (MID) → Country mapping
# First 3 digits of MMSI (for 9-digit MMSIs) encode the flag state
MID_COUNTRY = {
    201: "Albania", 202: "Andorra", 203: "Austria", 204: "Portugal", 205: "Belgium",
    206: "Belarus", 207: "Bulgaria", 208: "Vatican", 209: "Cyprus", 210: "Cyprus",
    211: "Germany", 212: "Cyprus", 213: "Georgia", 214: "Moldova", 215: "Malta",
    216: "Armenia", 218: "Germany", 219: "Denmark", 220: "Denmark", 224: "Spain",
    225: "Spain", 226: "France", 227: "France", 228: "France", 229: "Malta",
    230: "Finland", 231: "Faroe Islands", 232: "United Kingdom", 233: "United Kingdom",
    234: "United Kingdom", 235: "United Kingdom", 236: "Gibraltar", 237: "Greece",
    238: "Croatia", 239: "Greece", 240: "Greece", 241: "Greece", 242: "Morocco",
    243: "Hungary", 244: "Netherlands", 245: "Netherlands", 246: "Netherlands",
    247: "Italy", 248: "Malta", 249: "Malta", 250: "Ireland", 251: "Iceland",
    252: "Liechtenstein", 253: "Luxembourg", 254: "Monaco", 255: "Portugal",
    256: "Malta", 257: "Norway", 258: "Norway", 259: "Norway", 261: "Poland",
    263: "Portugal", 264: "Romania", 265: "Sweden", 266: "Sweden", 267: "Slovakia",
    268: "San Marino", 269: "Switzerland", 270: "Czech Republic", 271: "Turkey",
    272: "Ukraine", 273: "Russia", 274: "North Macedonia", 275: "Latvia",
    276: "Estonia", 277: "Lithuania", 278: "Slovenia",
    301: "Anguilla", 303: "Alaska", 304: "Antigua", 305: "Antigua",
    306: "Netherlands Antilles", 307: "Aruba", 308: "Bahamas", 309: "Bahamas",
    310: "Bermuda", 311: "Bahamas", 312: "Belize", 314: "Barbados", 316: "Canada",
    319: "Cayman Islands", 321: "Costa Rica", 323: "Cuba", 325: "Dominica",
    327: "Dominican Republic", 329: "Guadeloupe", 330: "Grenada", 331: "Greenland",
    332: "Guatemala", 334: "Honduras", 336: "Haiti", 338: "United States",
    339: "Jamaica", 341: "Saint Kitts", 343: "Saint Lucia", 345: "Mexico",
    347: "Martinique", 348: "Montserrat", 350: "Nicaragua", 351: "Panama",
    352: "Panama", 353: "Panama", 354: "Panama", 355: "Panama",
    356: "Panama", 357: "Panama", 358: "Puerto Rico", 359: "El Salvador",
    361: "Saint Pierre", 362: "Trinidad", 364: "Turks and Caicos",
    366: "United States", 367: "United States", 368: "United States", 369: "United States",
    370: "Panama", 371: "Panama", 372: "Panama", 373: "Panama",
    374: "Panama", 375: "Saint Vincent", 376: "Saint Vincent", 377: "Saint Vincent",
    378: "British Virgin Islands", 379: "US Virgin Islands",
    401: "Afghanistan", 403: "Saudi Arabia", 405: "Bangladesh", 408: "Bahrain",
    410: "Bhutan", 412: "China", 413: "China", 414: "China",
    416: "Taiwan", 417: "Sri Lanka", 419: "India", 422: "Iran",
    423: "Azerbaijan", 425: "Iraq", 428: "Israel", 431: "Japan",
    432: "Japan", 434: "Turkmenistan", 436: "Kazakhstan", 437: "Uzbekistan",
    438: "Jordan", 440: "South Korea", 441: "South Korea", 443: "Palestine",
    445: "North Korea", 447: "Kuwait", 450: "Lebanon", 451: "Kyrgyzstan",
    453: "Macao", 455: "Maldives", 457: "Mongolia", 459: "Nepal",
    461: "Oman", 463: "Pakistan", 466: "Qatar", 468: "Syria",
    470: "UAE", 472: "Tajikistan", 473: "Yemen", 475: "Tonga",
    477: "Hong Kong", 478: "Bosnia",
    501: "Antarctica", 503: "Australia", 506: "Myanmar",
    508: "Brunei", 510: "Micronesia", 511: "Palau", 512: "New Zealand",
    514: "Cambodia", 515: "Cambodia", 516: "Christmas Island",
    518: "Cook Islands", 520: "Fiji", 523: "Cocos Islands",
    525: "Indonesia", 529: "Kiribati", 531: "Laos", 533: "Malaysia",
    536: "Northern Mariana Islands", 538: "Marshall Islands",
    540: "New Caledonia", 542: "Niue", 544: "Nauru", 546: "French Polynesia",
    548: "Philippines", 553: "Papua New Guinea", 555: "Pitcairn",
    557: "Solomon Islands", 559: "American Samoa", 561: "Samoa",
    563: "Singapore", 564: "Singapore", 565: "Singapore", 566: "Singapore",
    567: "Thailand", 570: "Tonga", 572: "Tuvalu", 574: "Vietnam",
    576: "Vanuatu", 577: "Vanuatu", 578: "Wallis and Futuna",
    601: "South Africa", 603: "Angola", 605: "Algeria", 607: "Benin",
    609: "Botswana", 610: "Burundi", 611: "Cameroon", 612: "Cape Verde",
    613: "Central African Republic", 615: "Congo", 616: "Comoros",
    617: "DR Congo", 618: "Ivory Coast", 619: "Djibouti",
    620: "Egypt", 621: "Equatorial Guinea", 622: "Ethiopia",
    624: "Eritrea", 625: "Gabon", 626: "Gambia", 627: "Ghana",
    629: "Guinea", 630: "Guinea-Bissau", 631: "Kenya", 632: "Lesotho",
    633: "Liberia", 634: "Liberia", 635: "Liberia", 636: "Liberia",
    637: "Libya", 642: "Madagascar", 644: "Malawi", 645: "Mali",
    647: "Mauritania", 649: "Mauritius", 650: "Mozambique",
    654: "Namibia", 655: "Niger", 656: "Nigeria", 657: "Guinea",
    659: "Rwanda", 660: "Senegal", 661: "Sierra Leone",
    662: "Somalia", 663: "South Africa", 664: "Sudan",
    667: "Tanzania", 668: "Togo", 669: "Tunisia", 670: "Uganda",
    671: "Egypt", 672: "Tanzania", 674: "Zambia", 675: "Zimbabwe",
    676: "Comoros", 677: "Tanzania",
}

def get_country_from_mmsi(mmsi: int) -> str:
    """Look up flag state from MMSI Maritime Identification Digit."""
    mmsi_str = str(mmsi)
    if len(mmsi_str) == 9:
        mid = int(mmsi_str[:3])
        return MID_COUNTRY.get(mid, "UNKNOWN")
    return "UNKNOWN"


# Global vessel store: MMSI → vessel dict
_vessels: dict[int, dict] = {}
_vessels_lock = threading.Lock()
_ws_thread: threading.Thread | None = None
_ws_running = False

# -----------------------------------------------------------------------
# Anomaly Detection — alert queue for Live Feed
# -----------------------------------------------------------------------
import collections
_alert_queue: collections.deque = collections.deque(maxlen=200)
_alert_lock = threading.Lock()

# Track per-vessel previous state for change detection
_vessel_prev: dict[int, dict] = {}  # mmsi → {sog, destination, last_seen}

# Cooldown: don't re-alert for same vessel within N seconds
_alert_cooldown: dict[str, float] = {}  # f"{mmsi}_{alert_type}" → last_alert_ts
_ALERT_COOLDOWN_S = 300  # 5 minutes


def _maybe_alert(alert_type: str, mmsi: int, data: dict):
    """Push an anomaly alert to the queue with cooldown."""
    key = f"{mmsi}_{alert_type}"
    now = time.time()
    with _alert_lock:
        if now - _alert_cooldown.get(key, 0) < _ALERT_COOLDOWN_S:
            return
        _alert_cooldown[key] = now
        _alert_queue.append({
            "id": f"{alert_type}_{mmsi}_{int(now)}",
            "type": alert_type,
            "mmsi": mmsi,
            "ts": datetime.now(timezone.utc).isoformat(),
            **data,
        })
        alerts_fired_total.labels(alert_type=alert_type).inc()


def get_alerts(max_count: int = 50) -> list[dict]:
    """Return the most recent anomaly alerts (newest first)."""
    with _alert_lock:
        return list(reversed(list(_alert_queue)))[:max_count]


def check_signal_loss():
    """Scan for vessels that stopped transmitting (called periodically)."""
    now = time.time()
    cutoff = now - 3600  # 60 minutes = signal lost
    warn_cutoff = now - 1800  # 30 minutes = warn
    with _vessels_lock:
        for mmsi, v in list(_vessels.items()):
            updated = v.get("_updated", now)
            name = v.get("name", "UNKNOWN")
            lat = v.get("lat")
            lng = v.get("lng")
            if lat is None or lng is None:
                continue
            minutes_ago = int((now - updated) / 60)
            if updated < warn_cutoff and v.get("type") in ("military_vessel", "cargo", "tanker"):
                _maybe_alert("signal_lost", mmsi, {
                    "name": name,
                    "lat": lat,
                    "lng": lng,
                    "minutes_ago": minutes_ago,
                    "vessel_type": v.get("type", "unknown"),
                    "country": get_country_from_mmsi(mmsi),
                    "message": f"📡 {name} — AIS 신호 소실 ({minutes_ago}분 전 마지막 수신)",
                    "severity": "high" if updated < cutoff else "medium",
                })

import os
CACHE_FILE = os.path.join(os.path.dirname(__file__), "ais_cache.json")


def _save_cache():
    """Save vessel data to disk for persistence across restarts."""
    try:
        with _vessels_lock:
            # Convert int keys to strings for JSON
            data = {str(k): v for k, v in _vessels.items()}
        with open(CACHE_FILE, 'w') as f:
            json.dump(data, f)
        logger.info(f"AIS cache saved: {len(data)} vessels")
    except Exception as e:
        logger.error(f"Failed to save AIS cache: {e}")


def _load_cache():
    """Load vessel data from disk on startup."""
    global _vessels
    if not os.path.exists(CACHE_FILE):
        return
    try:
        with open(CACHE_FILE, 'r') as f:
            data = json.load(f)
        now = time.time()
        stale_cutoff = now - 3600  # Accept vessels up to 1 hour old on restart
        loaded = 0
        with _vessels_lock:
            for k, v in data.items():
                if v.get("_updated", 0) > stale_cutoff:
                    _vessels[int(k)] = v
                    loaded += 1
        logger.info(f"AIS cache loaded: {loaded} vessels from disk")
    except Exception as e:
        logger.error(f"Failed to load AIS cache: {e}")


def get_vessel_metadata(mmsi: int) -> dict | None:
    """Get metadata for a specific vessel by MMSI (name, type, country, etc.)."""
    with _vessels_lock:
        v = _vessels.get(mmsi)
        if v:
            return {
                "mmsi": mmsi,
                "name": v.get("name", "UNKNOWN"),
                "type": v.get("type", "unknown"),
                "country": get_country_from_mmsi(mmsi),
                "callsign": v.get("callsign", ""),
                "destination": v.get("destination", "") or "UNKNOWN",
                "imo": v.get("imo", 0),
            }
    return None


def get_all_vessel_metadata() -> dict[int, dict]:
    """Get metadata for all tracked vessels as a dict keyed by MMSI."""
    with _vessels_lock:
        return {
            mmsi: {
                "name": v.get("name", "UNKNOWN"),
                "type": v.get("type", "unknown"),
                "country": get_country_from_mmsi(mmsi),
            }
            for mmsi, v in _vessels.items()
            if v.get("name")  # Only vessels with known metadata
        }


def get_ais_vessels() -> list[dict]:
    """Return a snapshot of tracked AIS vessels, excluding 'other' type, pruning stale."""
    now = time.time()
    stale_cutoff = now - 900  # 15 minutes

    with _vessels_lock:
        # Prune stale vessels
        stale_keys = [k for k, v in _vessels.items() if v.get("_updated", 0) < stale_cutoff]
        for k in stale_keys:
            del _vessels[k]
        
        result = []
        for mmsi, v in _vessels.items():
            v_type = v.get("type", "unknown")
            # Skip 'other' vessels (fishing, tug, pilot, etc.) to reduce load
            if v_type == "other":
                continue
            # Skip vessels without valid position
            if not v.get("lat") or not v.get("lng"):
                continue
            
            result.append({
                "mmsi": mmsi,
                "name": v.get("name", "UNKNOWN"),
                "type": v_type,
                "lat": round(v.get("lat", 0), 5),
                "lng": round(v.get("lng", 0), 5),
                "heading": v.get("heading", 0),
                "sog": round(v.get("sog", 0), 1),
                "cog": round(v.get("cog", 0), 1),
                "callsign": v.get("callsign", ""),
                "destination": v.get("destination", "") or "UNKNOWN",
                "imo": v.get("imo", 0),
                "country": get_country_from_mmsi(mmsi),
                "length": v.get("length", 0),
                "beam": v.get("beam", 0),
                "draught": v.get("draught", 0),
                "eta": v.get("eta", ""),
            })
        ais_vessels_active.set(len(result))
        return result


def _ais_stream_loop():
    """Main loop: spawn node proxy and process messages from stdout."""
    import subprocess
    import os

    proxy_script = os.path.join(os.path.dirname(os.path.dirname(__file__)), "ais_proxy.js")
    backoff = 1  # Exponential backoff starting at 1 second

    while _ws_running:
        try:
            logger.info("Starting Node.js AIS Stream Proxy...")
            process = subprocess.Popen(
                ['node', proxy_script, API_KEY],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )
            
            # Drain stderr in a background thread to prevent deadlock
            import threading
            def _drain_stderr():
                for errline in iter(process.stderr.readline, ''):
                    errline = errline.strip()
                    if errline:
                        logger.warning(f"AIS proxy stderr: {errline}")
            threading.Thread(target=_drain_stderr, daemon=True).start()
            
            logger.info("AIS Stream proxy started — receiving vessel data")
            
            msg_count = 0
            for raw_msg in iter(process.stdout.readline, ''):
                if not _ws_running:
                    process.terminate()
                    break
                
                raw_msg = raw_msg.strip()
                if not raw_msg:
                    continue
                
                try:
                    data = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue
                
                if "error" in data:
                    logger.error(f"AIS Stream error: {data['error']}")
                    continue
                
                msg_type = data.get("MessageType", "")
                metadata = data.get("MetaData", {})
                message = data.get("Message", {})
                
                mmsi = metadata.get("MMSI", 0)
                if not mmsi:
                    continue
                
                with _vessels_lock:
                    if mmsi not in _vessels:
                        _vessels[mmsi] = {"_updated": time.time()}
                    vessel = _vessels[mmsi]
                
                # Update position from PositionReport or StandardClassBPositionReport
                if msg_type in ("PositionReport", "StandardClassBPositionReport"):
                    report = message.get(msg_type, {})
                    lat = report.get("Latitude", metadata.get("latitude", 0))
                    lng = report.get("Longitude", metadata.get("longitude", 0))
                    
                    # Skip invalid positions
                    if lat == 0 and lng == 0:
                        continue
                    if abs(lat) > 90 or abs(lng) > 180:
                        continue
                    
                    with _vessels_lock:
                        vessel["lat"] = lat
                        vessel["lng"] = lng
                        vessel["sog"] = report.get("Sog", 0)
                        vessel["cog"] = report.get("Cog", 0)
                        heading = report.get("TrueHeading", 511)
                        vessel["heading"] = heading if heading != 511 else report.get("Cog", 0)
                        vessel["_updated"] = time.time()
                        # Use metadata name if we don't have one yet
                        if not vessel.get("name") or vessel["name"] == "UNKNOWN":
                            vessel["name"] = metadata.get("ShipName", "UNKNOWN").strip() or "UNKNOWN"

                    # --- Record position to history writer for DB persistence ---
                    try:
                        sog_val = report.get("Sog", 0) or 0
                        heading_val = vessel.get("heading", 0) or 0
                        ship_type = vessel.get("type", "unknown") or "unknown"
                        ship_name = vessel.get("name", "UNKNOWN") or "UNKNOWN"
                        history_writer.record_position(
                            mmsi=mmsi,
                            lat=lat,
                            lng=lng,
                            sog=sog_val,
                            heading=heading_val,
                            ship_type=ship_type,
                            ship_name=ship_name
                        )
                    except Exception as e:
                        # DB 기록 실패해도 실시간 기능은 계속 동작
                        logger.warning(f"History record failed for MMSI {mmsi}: {e}")

                    ais_messages_total.labels(message_type="position").inc()

                    # --- Anomaly: Speeding vessel ---
                    sog = report.get("Sog", 0)
                    v_name = vessel.get("name", "UNKNOWN")
                    v_type = vessel.get("type", "unknown")
                    # Alert on cargo/tanker/military going faster than 25 knots (very fast for large ships)
                    # Or any vessel > 35 knots (abnormal for any commercial vessel)
                    if sog and ((sog > 25 and v_type in ("cargo", "tanker", "military_vessel")) or sog > 35):
                        _maybe_alert("speeding", mmsi, {
                            "name": v_name,
                            "lat": lat,
                            "lng": lng,
                            "sog": round(sog, 1),
                            "vessel_type": v_type,
                            "country": get_country_from_mmsi(mmsi),
                            "message": f"🚨 {v_name} — 과속 감지 ({sog:.1f} kts, 유형: {v_type})",
                            "severity": "high" if sog > 35 else "medium",
                        })
                
                # Update static data from ShipStaticData
                elif msg_type == "ShipStaticData":
                    static = message.get("ShipStaticData", {})
                    ais_type = static.get("Type", 0)
                    
                    new_dest = (static.get("Destination", "") or "").strip().replace("@", "")
                    v_name_static = (static.get("Name", "") or metadata.get("ShipName", "UNKNOWN")).strip() or "UNKNOWN"

                    # Parse vessel dimensions (A+B=length, C+D=beam)
                    dimension = static.get("Dimension", {})
                    dim_a = dimension.get("A", 0) or 0
                    dim_b = dimension.get("B", 0) or 0
                    dim_c = dimension.get("C", 0) or 0
                    dim_d = dimension.get("D", 0) or 0
                    length = dim_a + dim_b
                    beam = dim_c + dim_d
                    draught = static.get("MaximumStaticDraught", 0) or 0

                    # Parse ETA
                    eta_raw = static.get("Eta", {})
                    eta_str = ""
                    if eta_raw:
                        eta_month = eta_raw.get("Month", 0) or 0
                        eta_day = eta_raw.get("Day", 0) or 0
                        eta_hour = eta_raw.get("Hour", 24)
                        eta_minute = eta_raw.get("Minute", 60)
                        if 1 <= eta_month <= 12 and 1 <= eta_day <= 31:
                            eta_str = f"{eta_month:02d}-{eta_day:02d}"
                            if eta_hour < 24 and eta_minute < 60:
                                eta_str += f" {eta_hour:02d}:{eta_minute:02d}"

                    with _vessels_lock:
                        old_dest = vessel.get("destination", "")
                        vessel["name"] = v_name_static
                        vessel["callsign"] = (static.get("CallSign", "") or "").strip()
                        vessel["imo"] = static.get("ImoNumber", 0)
                        vessel["destination"] = new_dest
                        vessel["ais_type_code"] = ais_type
                        vessel["type"] = classify_vessel(ais_type, mmsi)
                        vessel["_updated"] = time.time()
                        if length > 0:
                            vessel["length"] = length
                        if beam > 0:
                            vessel["beam"] = beam
                        if draught > 0:
                            vessel["draught"] = round(draught / 10, 1)
                        if eta_str:
                            vessel["eta"] = eta_str
                        cur_lat = vessel.get("lat")
                        cur_lng = vessel.get("lng")

                    ais_messages_total.labels(message_type="static_data").inc()

                    # Backfill unknown ship_type in DB for this MMSI
                    classified_type = vessel.get("type", "unknown")
                    if classified_type and classified_type not in ("unknown", "other"):
                        history_writer.update_ship_type(mmsi, classified_type)

                    # --- Anomaly: Destination change ---
                    if (old_dest and new_dest and old_dest != new_dest
                            and old_dest not in ("UNKNOWN", "@", "")
                            and new_dest not in ("UNKNOWN", "@", "")):
                        _maybe_alert("dest_change", mmsi, {
                            "name": v_name_static,
                            "lat": cur_lat,
                            "lng": cur_lng,
                            "old_destination": old_dest,
                            "new_destination": new_dest,
                            "vessel_type": classify_vessel(ais_type, mmsi),
                            "country": get_country_from_mmsi(mmsi),
                            "message": f"🔀 {v_name_static} — 목적지 변경: {old_dest} → {new_dest}",
                            "severity": "medium",
                        })
                
                msg_count += 1
                if msg_count % 5000 == 0:
                    with _vessels_lock:
                        # Inline pruning: remove vessels not updated in 15 minutes
                        prune_cutoff = time.time() - 900
                        stale = [k for k, v in _vessels.items() if v.get("_updated", 0) < prune_cutoff]
                        for k in stale:
                            del _vessels[k]
                        count = len(_vessels)
                    if stale:
                        logger.info(f"AIS pruned {len(stale)} stale vessels")
                    logger.info(f"AIS Stream: processed {msg_count} messages, tracking {count} vessels")
                    _save_cache()  # Auto-save every 5000 messages (~60 seconds)
                        
        except Exception as e:
            logger.error(f"AIS proxy connection error: {e}")
            if _ws_running:
                logger.info(f"Restarting AIS proxy in {backoff}s (exponential backoff)...")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)  # Double up to 60s max
            continue
        # Reset backoff on successful connection (got at least some messages)
        backoff = 1


def _run_ais_loop():
    """Thread target: run the AIS loop."""
    try:
        _ais_stream_loop()
    except Exception as e:
        logger.error(f"AIS Stream thread crashed: {e}")


def start_ais_stream():
    """Start the AIS WebSocket stream in a background thread."""
    global _ws_thread, _ws_running
    if _ws_thread and _ws_thread.is_alive():
        logger.info("AIS Stream already running")
        return
    
    # Load cached vessel data from disk
    _load_cache()
    
    _ws_running = True
    _ws_thread = threading.Thread(target=_run_ais_loop, daemon=True, name="ais-stream")
    _ws_thread.start()
    logger.info("AIS Stream background thread started")


def stop_ais_stream():
    """Stop the AIS WebSocket stream and save cache."""
    global _ws_running
    _ws_running = False
    _save_cache()  # Save on shutdown
    logger.info("AIS Stream stopping...")

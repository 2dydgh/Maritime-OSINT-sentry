"""
Port search service using searoute's built-in port database.
Supports Korean and English port name search.
"""

import json
import os
import logging

logger = logging.getLogger(__name__)

# Korean port name -> English mapping
KO_PORT_NAMES = {
    "부산": "Busan",
    "인천": "Incheon",
    "울산": "Ulsan",
    "여수": "Yeosu",
    "광양": "Gwangyang",
    "목포": "Mokpo",
    "평택": "Pyeongtaek",
    "마산": "Masan",
    "포항": "Pohang",
    "동해": "Donghae",
    "속초": "Sokcho",
    "제주": "Jeju",
    "군산": "Gunsan",
    "대산": "Daesan",
    "삼천포": "Sacheon",
    "통영": "Tongyeong",
    "거제": "Geoje",
    "진해": "Jinhae",
    "장항": "Janghang",
    "완도": "Wando",
    "서귀포": "Seogwipo",
    "싱가포르": "Singapore",
    "상하이": "Shanghai",
    "도쿄": "Tokyo",
    "요코하마": "Yokohama",
    "오사카": "Osaka",
    "홍콩": "Hong Kong",
    "로테르담": "Rotterdam",
    "함부르크": "Hamburg",
    "두바이": "Dubai",
}

# Database name -> modern/canonical English name
# The searoute database uses older romanizations for some ports
_NAME_CANONICAL = {
    "Pusan": "Busan",
    "Chemulpo": "Incheon",
}

# Reverse: modern name -> database name (for search)
_NAME_ALIASES = {v.lower(): k.lower() for k, v in _NAME_CANONICAL.items()}

_ports = []


def _load_ports():
    """Load port data from searoute's built-in ports.geojson."""
    global _ports
    if _ports:
        return

    try:
        import searoute
        pkg_dir = os.path.dirname(searoute.__file__)
        ports_path = os.path.join(pkg_dir, "data", "ports.geojson")

        with open(ports_path, encoding="utf-8") as f:
            data = json.load(f)

        for feat in data.get("features", []):
            props = feat.get("properties", {})
            coords = feat.get("geometry", {}).get("coordinates", [])
            if len(coords) >= 2:
                raw_name = props.get("name", "Unknown")
                display_name = _NAME_CANONICAL.get(raw_name, raw_name)
                _ports.append({
                    "name": display_name,
                    "raw_name": raw_name,
                    "country": props.get("cty", "Unknown"),
                    "port_code": props.get("port", ""),
                    "lng": coords[0],
                    "lat": coords[1],
                })

        logger.info(f"Loaded {len(_ports)} ports from searoute database")
    except Exception as e:
        logger.error(f"Failed to load port data: {e}")


def search_ports(query: str, max_results: int = 10) -> list[dict]:
    """Search ports by name (Korean or English). Returns up to max_results matches."""
    _load_ports()

    if not query or not query.strip():
        return []

    q = query.strip()

    # Korean -> English translation
    en_query = KO_PORT_NAMES.get(q, None)
    search_term = (en_query or q).lower()

    # Also check if the search term has an alias (e.g. "busan" -> "pusan")
    alias_term = _NAME_ALIASES.get(search_term)

    matches = []
    for port in _ports:
        name_lower = port["name"].lower()
        raw_lower = port["raw_name"].lower()
        matched = search_term in name_lower or search_term in raw_lower
        if not matched and alias_term:
            matched = alias_term in name_lower or alias_term in raw_lower
        if matched:
            # Exact prefix match on display name ranks higher
            score = 0 if name_lower.startswith(search_term) else 1
            matches.append((score, port))

    matches.sort(key=lambda x: (x[0], x[1]["name"]))

    # Deduplicate by name+country (same port, multiple entries)
    seen = set()
    results = []
    for _, port in matches:
        key = (port["name"].lower(), port["country"].lower())
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "name": port["name"],
            "country": port["country"],
            "port_code": port["port_code"],
            "lng": port["lng"],
            "lat": port["lat"],
        })
        if len(results) >= max_results:
            break
    return results

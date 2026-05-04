"""
LLM Tool Definitions and Executor for Maritime OSINT Agent.

Provides Ollama-compatible tool definitions and a dispatcher that calls
the appropriate backend service functions.
"""

import math
import logging
from typing import Any

from backend.services import ais_stream, collision_analyzer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Known Korean port coordinates
# ---------------------------------------------------------------------------
KOREAN_PORTS: dict[str, dict] = {
    "busan":     {"lat": 35.10,  "lon": 129.05, "name": "부산항"},
    "incheon":   {"lat": 37.45,  "lon": 126.60, "name": "인천항"},
    "ulsan":     {"lat": 35.50,  "lon": 129.38, "name": "울산항"},
    "gwangyang": {"lat": 34.90,  "lon": 127.70, "name": "광양항"},
    "pyeongtaek":{"lat": 36.97,  "lon": 126.83, "name": "평택항"},
    "mokpo":     {"lat": 34.78,  "lon": 126.38, "name": "목포항"},
    "jeju":      {"lat": 33.52,  "lon": 126.53, "name": "제주항"},
}

# Area search radius in nautical miles
AREA_SEARCH_RADIUS_NM = 20.0

# ---------------------------------------------------------------------------
# Ollama-compatible TOOL_DEFINITIONS
# ---------------------------------------------------------------------------
TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "get_ships",
            "description": (
                "현재 추적 중인 AIS 선박 목록을 반환합니다. "
                "선박 유형(type)으로 필터링하거나 전체 목록을 가져올 수 있습니다. "
                "각 선박의 MMSI, 이름, 유형, 위치(위도·경도), 속도, 침로, 상태 등이 포함됩니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": (
                            "필터링할 선박 유형. "
                            "가능한 값: cargo, tanker, passenger, fishing, military, tug, other. "
                            "생략하면 전체 선박을 반환합니다."
                        ),
                        "enum": ["cargo", "tanker", "passenger", "fishing", "military", "tug", "other"],
                    },
                    "limit": {
                        "type": "integer",
                        "description": "반환할 최대 선박 수. 기본값 50, 최대 200.",
                        "default": 50,
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_collision_risks",
            "description": (
                "현재 충돌 위험이 있는 선박 쌍 목록을 반환합니다. "
                "거리 기반(TCPA/DCPA) 위험과 ML 모델 기반 위험을 모두 포함합니다. "
                "source 파라미터로 분석 방식을 선택할 수 있습니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": (
                            "분석 소스 선택. "
                            "'distance': TCPA/DCPA 거리 기반, "
                            "'ml': ML 모델(XGBoost) 기반, "
                            "'all': 두 분석 모두 포함 (기본값)."
                        ),
                        "enum": ["distance", "ml", "all"],
                        "default": "all",
                    },
                    "severity": {
                        "type": "string",
                        "description": (
                            "거리 기반 분석의 심각도 필터. "
                            "'danger': 위험, 'caution': 경고, 'warning': 주의. "
                            "생략하면 전체 심각도를 반환합니다."
                        ),
                        "enum": ["danger", "caution", "warning"],
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_area_status",
            "description": (
                "특정 항구 또는 해역 반경 20해리 내의 선박 현황을 반환합니다. "
                "한국 주요 항구(부산, 인천, 울산, 광양, 평택, 목포, 제주) 또는 "
                "임의의 위도·경도 좌표를 지정할 수 있습니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "string",
                        "description": (
                            "한국 항구 이름 (영문 소문자). "
                            "busan, incheon, ulsan, gwangyang, pyeongtaek, mokpo, jeju 중 하나."
                        ),
                        "enum": ["busan", "incheon", "ulsan", "gwangyang", "pyeongtaek", "mokpo", "jeju"],
                    },
                    "lat": {
                        "type": "number",
                        "description": "중심 위도 (port 미지정 시 필수).",
                    },
                    "lon": {
                        "type": "number",
                        "description": "중심 경도 (port 미지정 시 필수).",
                    },
                    "radius_nm": {
                        "type": "number",
                        "description": "검색 반경(해리). 기본값 20nm.",
                        "default": 20.0,
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fly_to",
            "description": (
                "지도 카메라를 특정 위치로 이동합니다. "
                "항구 이름, 선박 MMSI, 또는 직접 좌표를 지정할 수 있습니다. "
                "프론트엔드 지도에 즉시 반영됩니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "string",
                        "description": "이동할 한국 항구 이름. busan, incheon, ulsan, gwangyang, pyeongtaek, mokpo, jeju 중 하나.",
                        "enum": ["busan", "incheon", "ulsan", "gwangyang", "pyeongtaek", "mokpo", "jeju"],
                    },
                    "mmsi": {
                        "type": "integer",
                        "description": "이동할 선박의 MMSI 번호. 해당 선박 위치로 카메라를 이동합니다.",
                    },
                    "lat": {
                        "type": "number",
                        "description": "이동할 위도 (port, mmsi 미지정 시 사용).",
                    },
                    "lon": {
                        "type": "number",
                        "description": "이동할 경도 (port, mmsi 미지정 시 사용).",
                    },
                    "zoom": {
                        "type": "number",
                        "description": "카메라 줌 레벨 (1~20). 기본값 10.",
                        "default": 10,
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "filter_ships",
            "description": (
                "지도에 표시되는 선박을 유형별로 필터링합니다. "
                "특정 선박 유형만 보이거나 전체를 표시하도록 프론트엔드에 명령을 전달합니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "types": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "표시할 선박 유형 목록. "
                            "가능한 값: cargo, tanker, passenger, fishing, military, tug, other. "
                            "빈 배열이면 전체 표시."
                        ),
                    },
                    "show_all": {
                        "type": "boolean",
                        "description": "true이면 모든 선박 유형을 표시합니다. types보다 우선합니다.",
                        "default": False,
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_ship_detail",
            "description": (
                "특정 선박의 상세 정보를 반환합니다. "
                "MMSI 또는 선박 이름으로 검색할 수 있습니다. "
                "위치, 속도, 침로, 목적지, 선박 제원(길이·폭), 국적 등이 포함됩니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "mmsi": {
                        "type": "integer",
                        "description": "조회할 선박의 MMSI 번호.",
                    },
                    "name": {
                        "type": "string",
                        "description": "조회할 선박 이름 (부분 일치 검색 지원).",
                    },
                },
                "required": [],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Haversine distance helper
# ---------------------------------------------------------------------------
def _haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points in nautical miles."""
    R_NM = 3440.065  # Earth radius in nautical miles
    rlat1 = math.radians(lat1)
    rlat2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    return R_NM * c


# ---------------------------------------------------------------------------
# Individual tool implementations
# ---------------------------------------------------------------------------

def _tool_get_ships(arguments: dict) -> dict:
    """Return AIS vessel list, optionally filtered by type."""
    ship_type = arguments.get("type")
    limit = int(arguments.get("limit", 50))
    limit = min(limit, 200)

    vessels = ais_stream.get_ais_vessels()

    if ship_type:
        # Normalize: "military" matches "military_vessel" in the data
        normalized = "military_vessel" if ship_type == "military" else ship_type
        vessels = [v for v in vessels if v.get("type") == normalized]

    vessels = vessels[:limit]

    return {
        "count": len(vessels),
        "ships": [
            {
                "mmsi": v["mmsi"],
                "name": v.get("name", "UNKNOWN"),
                "type": v.get("type", "unknown"),
                "lat": v.get("lat"),
                "lon": v.get("lng"),
                "speed": v.get("sog", 0),
                "course": v.get("cog", 0),
                "heading": v.get("heading", 0),
                "status": v.get("status", ""),
                "destination": v.get("destination", "UNKNOWN"),
                "length": v.get("length", 0),
                "beam": v.get("beam", 0),
                "country": v.get("country", "UNKNOWN"),
            }
            for v in vessels
        ],
    }


def _tool_get_collision_risks(arguments: dict) -> dict:
    """Return current collision risk data from distance and/or ML analysis."""
    source = arguments.get("source", "all")
    severity_filter = arguments.get("severity")

    result: dict[str, Any] = {}

    if source in ("distance", "all"):
        distance_risks = collision_analyzer.get_distance_risks()
        if severity_filter:
            distance_risks = [r for r in distance_risks if r.get("severity") == severity_filter]
        result["distance_risks"] = [
            {
                "ship_a": {
                    "mmsi": r["ship_a"]["mmsi"],
                    "name": r["ship_a"].get("name", "UNKNOWN"),
                    "type": r["ship_a"].get("type", "unknown"),
                    "lat": r["ship_a"]["lat"],
                    "lon": r["ship_a"]["lng"],
                    "speed": r["ship_a"].get("sog", 0),
                },
                "ship_b": {
                    "mmsi": r["ship_b"]["mmsi"],
                    "name": r["ship_b"].get("name", "UNKNOWN"),
                    "type": r["ship_b"].get("type", "unknown"),
                    "lat": r["ship_b"]["lat"],
                    "lon": r["ship_b"]["lng"],
                    "speed": r["ship_b"].get("sog", 0),
                },
                "tcpa_min": r["tcpa_min"],
                "dcpa_nm": r["dcpa_nm"],
                "current_dist_nm": r["current_dist_nm"],
                "severity": r["severity"],
                "encounter": r.get("encounter", "unknown"),
            }
            for r in distance_risks
        ]
        result["distance_risk_count"] = len(result["distance_risks"])

    if source in ("ml", "all"):
        ml_risks = collision_analyzer.get_ml_risks()
        result["ml_risks"] = [
            {
                "ship_a": {
                    "mmsi": r["ship_a"]["mmsi"],
                    "name": r["ship_a"].get("name", "UNKNOWN"),
                    "lat": r["ship_a"]["lat"],
                    "lon": r["ship_a"]["lng"],
                },
                "ship_b": {
                    "mmsi": r["ship_b"]["mmsi"],
                    "name": r["ship_b"].get("name", "UNKNOWN"),
                    "lat": r["ship_b"]["lat"],
                    "lon": r["ship_b"]["lng"],
                },
                "risk_level": r["risk_level"],
                "risk_label": r["risk_label"],
                "current_dist_nm": r["current_dist_nm"],
                "tcpa_min": r["tcpa_min"],
            }
            for r in ml_risks
        ]
        result["ml_risk_count"] = len(result["ml_risks"])

    return result


def _tool_get_area_status(arguments: dict) -> dict:
    """Return vessels within a radius of a port or coordinate."""
    port_key = arguments.get("port")
    radius_nm = float(arguments.get("radius_nm", AREA_SEARCH_RADIUS_NM))

    if port_key:
        port_info = KOREAN_PORTS.get(port_key)
        if not port_info:
            return {"error": f"알 수 없는 항구: {port_key}"}
        center_lat = port_info["lat"]
        center_lon = port_info["lon"]
        area_name = port_info["name"]
    else:
        lat = arguments.get("lat")
        lon = arguments.get("lon")
        if lat is None or lon is None:
            return {"error": "port 또는 lat/lon 좌표를 지정해야 합니다."}
        center_lat = float(lat)
        center_lon = float(lon)
        area_name = f"({center_lat:.3f}, {center_lon:.3f})"

    vessels = ais_stream.get_ais_vessels()

    nearby = []
    type_counts: dict[str, int] = {}
    for v in vessels:
        v_lat = v.get("lat")
        v_lng = v.get("lng")
        if v_lat is None or v_lng is None:
            continue
        dist = _haversine_distance(center_lat, center_lon, v_lat, v_lng)
        if dist <= radius_nm:
            v_type = v.get("type", "unknown")
            type_counts[v_type] = type_counts.get(v_type, 0) + 1
            nearby.append({
                "mmsi": v["mmsi"],
                "name": v.get("name", "UNKNOWN"),
                "type": v_type,
                "lat": v_lat,
                "lon": v_lng,
                "speed": v.get("sog", 0),
                "destination": v.get("destination", "UNKNOWN"),
                "distance_nm": round(dist, 2),
                "country": v.get("country", "UNKNOWN"),
            })

    # Sort by distance
    nearby.sort(key=lambda x: x["distance_nm"])

    return {
        "area": area_name,
        "center_lat": center_lat,
        "center_lon": center_lon,
        "radius_nm": radius_nm,
        "total_count": len(nearby),
        "type_summary": type_counts,
        "ships": nearby,
    }


def _tool_fly_to(arguments: dict) -> dict:
    """Resolve fly_to target and return action payload for the frontend."""
    port_key = arguments.get("port")
    mmsi = arguments.get("mmsi")
    zoom = float(arguments.get("zoom", 10))

    if port_key:
        port_info = KOREAN_PORTS.get(port_key)
        if not port_info:
            return {"error": f"알 수 없는 항구: {port_key}"}
        return {
            "action": "fly_to",
            "lat": port_info["lat"],
            "lon": port_info["lon"],
            "zoom": zoom,
            "label": port_info["name"],
        }

    if mmsi is not None:
        vessels = ais_stream.get_ais_vessels()
        target = next((v for v in vessels if v["mmsi"] == int(mmsi)), None)
        if not target:
            return {"error": f"MMSI {mmsi} 선박을 찾을 수 없습니다."}
        return {
            "action": "fly_to",
            "lat": target["lat"],
            "lon": target["lng"],
            "zoom": zoom,
            "label": target.get("name", str(mmsi)),
            "mmsi": int(mmsi),
        }

    lat = arguments.get("lat")
    lon = arguments.get("lon")
    if lat is None or lon is None:
        return {"error": "port, mmsi, 또는 lat/lon 중 하나를 지정해야 합니다."}

    return {
        "action": "fly_to",
        "lat": float(lat),
        "lon": float(lon),
        "zoom": zoom,
        "label": f"({float(lat):.4f}, {float(lon):.4f})",
    }


def _tool_filter_ships(arguments: dict) -> dict:
    """Return filter action payload for the frontend."""
    show_all = arguments.get("show_all", False)
    types = arguments.get("types", [])

    if show_all:
        active_types = []  # empty means show all on the frontend
        label = "모든 선박 유형 표시"
    else:
        # Normalize "military" → "military_vessel" for frontend consistency
        active_types = [
            "military_vessel" if t == "military" else t
            for t in (types or [])
        ]
        if active_types:
            label = f"선박 필터: {', '.join(active_types)}"
        else:
            label = "모든 선박 유형 표시"

    return {
        "action": "filter_ships",
        "types": active_types,
        "show_all": show_all or not active_types,
        "label": label,
    }


def _tool_get_ship_detail(arguments: dict) -> dict:
    """Return detailed information for a single vessel by MMSI or name."""
    mmsi = arguments.get("mmsi")
    name_query = arguments.get("name", "").strip().upper()

    if mmsi is None and not name_query:
        return {"error": "mmsi 또는 name 중 하나를 지정해야 합니다."}

    vessels = ais_stream.get_ais_vessels()
    target = None

    if mmsi is not None:
        target = next((v for v in vessels if v["mmsi"] == int(mmsi)), None)
    elif name_query:
        # Exact match first, then partial
        exact = [v for v in vessels if v.get("name", "").upper() == name_query]
        if exact:
            target = exact[0]
        else:
            partial = [v for v in vessels if name_query in v.get("name", "").upper()]
            if partial:
                target = partial[0]

    if not target:
        identifier = f"MMSI {mmsi}" if mmsi is not None else f"이름 '{name_query}'"
        return {"error": f"{identifier} 선박을 찾을 수 없습니다. 현재 추적 중인 선박이 아닐 수 있습니다."}

    return {
        "mmsi": target["mmsi"],
        "name": target.get("name", "UNKNOWN"),
        "type": target.get("type", "unknown"),
        "lat": target.get("lat"),
        "lon": target.get("lng"),
        "speed": target.get("sog", 0),
        "course": target.get("cog", 0),
        "heading": target.get("heading", 0),
        "status": target.get("status", ""),
        "destination": target.get("destination", "UNKNOWN"),
        "length": target.get("length", 0),
        "beam": target.get("beam", 0),
        "draught": target.get("draught", 0),
        "country": target.get("country", "UNKNOWN"),
        "callsign": target.get("callsign", ""),
        "imo": target.get("imo", 0),
        "ais_class": target.get("ais_class", "A"),
        "eta": target.get("eta", ""),
    }


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------
_TOOL_HANDLERS = {
    "get_ships":           _tool_get_ships,
    "get_collision_risks": _tool_get_collision_risks,
    "get_area_status":     _tool_get_area_status,
    "fly_to":              _tool_fly_to,
    "filter_ships":        _tool_filter_ships,
    "get_ship_detail":     _tool_get_ship_detail,
}


def execute_tool(name: str, arguments: dict) -> dict:
    """Dispatch a tool call by name and return the result dict.

    Args:
        name: Tool name matching one of the TOOL_DEFINITIONS entries.
        arguments: Parsed arguments dict from the LLM tool-call response.

    Returns:
        Result dict. Always a dict — errors are returned as {"error": "..."}.
    """
    handler = _TOOL_HANDLERS.get(name)
    if handler is None:
        logger.warning("Unknown tool requested: %s", name)
        return {"error": f"알 수 없는 도구: {name}"}

    try:
        result = handler(arguments)
        logger.debug("Tool '%s' executed successfully", name)
        return result
    except Exception as exc:
        logger.exception("Tool '%s' raised an exception: %s", name, exc)
        return {"error": f"도구 실행 오류 ({name}): {exc}"}

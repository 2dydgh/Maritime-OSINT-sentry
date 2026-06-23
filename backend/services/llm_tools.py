"""
LLM Tool Definitions and Executor for Maritime OSINT Agent.

Provides Ollama-compatible tool definitions and a dispatcher that calls
the appropriate backend service functions.
"""

import json
import math
import os
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
                "선박 유형(type) 또는 국적(country)으로 필터링하거나 전체 목록을 가져올 수 있습니다. "
                "각 선박의 MMSI, 이름, 유형, 위치(위도·경도), 속도, 침로, 상태, 국적이 포함됩니다. "
                "응답에는 'total_in_system' (시스템 전체 추적 척수)와 'returned' (이번 응답에 포함된 척수)가 같이 옵니다 — "
                "두 값이 다르면 일부만 반환된 것이므로 답변에서 그렇게 명시하세요."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": (
                            "필터링할 선박 유형. "
                            "가능한 값: cargo, tanker, passenger, fishing, military, tug, other. "
                            "생략하면 유형 필터 없음."
                        ),
                        "enum": ["cargo", "tanker", "passenger", "fishing", "military", "tug", "other"],
                    },
                    "country": {
                        "type": "string",
                        "description": (
                            "국적으로 필터링 (대소문자 무시, 부분 일치 허용). "
                            "예: 'Japan', 'Korea', 'China', 'USA', 'Russia', 'Norway'. "
                            "사용자가 '○○ 국적'이라고 하면 반드시 이 인자를 사용하세요."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": "반환할 최대 선박 수. 기본값 50, 최대 500. 국적/유형 필터를 쓸 때는 매칭 결과가 적으니 limit를 넉넉하게 (예: 500) 잡으세요.",
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
                "특정 항구 또는 해역 반경 내의 선박 현황을 반환합니다. "
                "한국 주요 항구(부산, 인천, 울산, 광양, 평택, 목포, 제주) 또는 "
                "임의의 위도·경도 좌표 + 반경(radius_nm)을 지정할 수 있습니다. "
                "*해역* 단위 검색(예: '일본 주변 해역', '동중국해', '도쿄만')에는 lat/lon에 해당 중심 좌표를 넣고 "
                "radius_nm을 100~400 정도로 넓게 잡으세요. 일본 중심: lat=36, lon=138 / 도쿄만: lat=35.5, lon=139.7 등."
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
    {
        "type": "function",
        "function": {
            "name": "set_roll_scenario",
            "description": (
                "현재 열려있는 횡요각(roll) 화면에 가상의 기상 시나리오를 적용합니다. "
                "사용자가 풍속, 파고, 파주기, 파향, 시간 가속을 임의로 설정해 시뮬레이션하고 싶을 때 사용합니다. "
                "횡요각 화면이 닫혀 있으면 적용되지 않으며, 사용자에게 화면을 먼저 열도록 안내해야 합니다. "
                "지정하지 않은 파라미터는 실제 관측값을 그대로 유지합니다. clear=true 이면 모든 override를 해제합니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "wind_speed": {
                        "type": "number",
                        "description": "풍속 (노트, kt). 일반 범위 0~80.",
                    },
                    "wave_height": {
                        "type": "number",
                        "description": "유의파고 (미터, m). 일반 범위 0~15.",
                    },
                    "wave_period": {
                        "type": "number",
                        "description": "파주기 (초, s). 일반 범위 3~20.",
                    },
                    "wave_direction": {
                        "type": "number",
                        "description": "파향 (도, degree, 0=북쪽, 90=동쪽).",
                    },
                    "time_scale": {
                        "type": "number",
                        "description": "시간 가속 배율 (1=실시간, 5=5배속). 범위 0.25~10.",
                    },
                    "ship_speed": {
                        "type": "number",
                        "description": "선박 속력/속도/SOG (노트, kt). 사용자가 '속력', '속도', 'speed', 'SOG', '노트' 등을 언급하면 이 인자로 전달. 일반 범위 0~30.",
                    },
                    "clear": {
                        "type": "boolean",
                        "description": "true 이면 적용 중인 모든 override를 초기화하고 실제 관측값으로 복귀.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "return_to_globe",
            "description": (
                "현재 열려있는 전용 화면(횡요각 등)을 닫고 지구본 메인 지도로 돌아갑니다. "
                "사용자가 '지구본으로', '메인으로', '뒤로', '닫아줘', '나가', '지도로 돌아가' 같은 표현을 쓰거나 "
                "다른 위치로 이동을 요청하면 fly_to 호출 전에 이 도구를 먼저 호출하세요. "
                "이미 지구본 화면이라면 아무 일도 일어나지 않습니다(안전한 no-op)."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_roll_viewer",
            "description": (
                "특정 선박의 횡요각(roll) 시뮬레이션 화면을 엽니다. "
                "사용자가 '○○ 배 횡요각 보여줘', '○○ 선박 선택해서 횡요각', "
                "'○○ 띄워줘' 같이 *특정 선박의 횡요각/롤 화면*을 요청하면 이 도구를 호출하세요. "
                "MMSI를 알면 mmsi 인자로 직접, 이름만 알면 name 인자로 호출하세요 — 백엔드가 이름→MMSI 변환을 처리합니다. "
                "이미 같은 선박의 횡요각 화면이 열려 있으면 안전한 no-op."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "mmsi": {
                        "type": "integer",
                        "description": "열고 싶은 선박의 MMSI 번호. 알면 우선 사용.",
                    },
                    "name": {
                        "type": "string",
                        "description": "선박 이름 (부분 일치 검색). mmsi 미지정 시 사용.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_capsize",
            "description": (
                "현재 열려있는 횡요각 화면의 선박을 실제로 전복(capsize)시켜 시각화합니다. "
                "선박이 한쪽으로 점점 기울어 복원력을 잃고 침몰하는 모습이 약 11초에 걸쳐 재생됩니다. "
                "사용자가 '전복', '뒤집혀', '침몰', '가라앉아', 'capsize', 'sink' 등을 언급하면 이 도구를 호출하세요. "
                "방향(direction)이 지정되지 않으면 무작위로 한쪽으로 기울어집니다. "
                "clear=true 이면 진행 중인 전복 시뮬레이션을 즉시 해제합니다(선박 자세는 자연 복귀). "
                "횡요각 화면이 닫혀 있으면 적용되지 않으니 사용자에게 화면을 먼저 열도록 안내해야 합니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "description": "전복 방향. port=좌현(왼쪽), starboard=우현(오른쪽), random=무작위. 미지정 시 random.",
                        "enum": ["port", "starboard", "random"],
                    },
                    "delay_seconds": {
                        "type": "number",
                        "description": (
                            "전복 시작까지 대기할 시간(초, 0~60). 기본값 0(즉시 전복). "
                            "set_turn_scenario와 함께 호출되는 '선회하다가 전복' 같은 복합 시나리오에서는 "
                            "선회가 충분히 발달한 뒤 전복되도록 6~8초 정도 지연을 주세요. "
                            "지연 동안에는 정상 물리(선회 헤들 등)가 그대로 작동합니다."
                        ),
                    },
                    "clear": {
                        "type": "boolean",
                        "description": "true 이면 진행 중인 전복을 해제하고 정상 자세로 복귀합니다.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_turn_scenario",
            "description": (
                "현재 열려있는 횡요각 화면에서 선회(코너링) 시뮬레이션을 시작하거나 중지합니다. "
                "선박이 좌현/우현으로 선회할 때 발생하는 횡요각 변화를 시각화합니다. "
                "사용자가 '선회', '회전', '코너링', '돌아', 'turn', 'cornering' 같은 표현을 쓰면 이 도구를 사용하세요. "
                "방향(direction)을 지정하지 않으면 무작위(좌/우)로 선회합니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "active": {
                        "type": "boolean",
                        "description": "true=시나리오 시작, false=중지. 사용자가 '시작/멈춰/정지' 등 의도를 명확히 한 경우 그에 맞춰 지정.",
                    },
                    "direction": {
                        "type": "string",
                        "description": "선회 방향. port=좌현(왼쪽), starboard=우현(오른쪽), random=무작위. 미지정 시 random.",
                        "enum": ["port", "starboard", "random"],
                    },
                },
                "required": ["active"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_route_screen",
            "description": (
                "항로(경로 추론) 화면을 엽니다. 사용자가 '항로', '경로', '루트', '항로 화면' 등을 "
                "언급하며 화면 전환을 원할 때 사용하세요. 특정 구간 경로까지 바로 그리려면 "
                "open_route_screen 대신 plan_route를 사용하세요."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan_route",
            "description": (
                "항로 화면에서 출발지→도착지 해상 경로를 추론해 그립니다. 한국 항구 이름"
                "(busan, incheon, ulsan, gwangyang, pyeongtaek, mokpo, jeju) 또는 'lat,lng' "
                "좌표를 from/to에 넘기세요. 선박 크기 등급(A~E)을 지정하면 깊이 인식 경로에 반영됩니다. "
                "예: '부산에서 광양까지 C급 항로'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "from": {
                        "type": "string",
                        "description": "출발지. 한국 항구 키 또는 'lat,lng' (예: '35.1,129.05').",
                    },
                    "to": {
                        "type": "string",
                        "description": "도착지. 한국 항구 키 또는 'lat,lng'.",
                    },
                    "size_class": {
                        "type": "string",
                        "description": "선박 크기 등급. A(1~20m) B(21~40m) C(41~80m) D(81~200m) E(201m+). 미지정 시 변경 안 함.",
                        "enum": ["A", "B", "C", "D", "E"],
                    },
                },
                "required": ["from", "to"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_route_size_class",
            "description": (
                "항로 화면의 선박 크기 등급(A~E)을 변경합니다. 이미 경로가 그려져 있으면 "
                "사용자가 다시 plan_route를 요청할 때 새 등급이 적용됩니다."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "size_class": {
                        "type": "string",
                        "description": "A(1~20m) B(21~40m) C(41~80m) D(81~200m) E(201m+).",
                        "enum": ["A", "B", "C", "D", "E"],
                    },
                },
                "required": ["size_class"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "toggle_hazard_zones",
            "description": (
                "지도 위 사고/위험 구역(해상 사고 위험 격자) 오버레이를 켜거나 끕니다. "
                "사용자가 '사고', '위험구역', '사고 위험', 'hazard' 등을 언급하며 표시/숨김을 "
                "원할 때 사용하세요."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "on": {
                        "type": "boolean",
                        "description": "true=사고 위험구역 표시, false=숨김. 기본값 true.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_hazard_summary",
            "description": (
                "특정 해역의 해상 사고 위험을 요약합니다. 한국 항구 키 또는 lat/lon/반경(해리)을 "
                "지정하면 해당 구역의 위험 등급 분포를 알려줍니다. 사용자가 '이 근처 사고 위험', "
                "'부산 앞바다 위험도' 같은 질문을 할 때 사용하세요."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "string",
                        "description": "한국 항구 키 (busan, incheon, ...). 지정 시 lat/lon 불필요.",
                    },
                    "lat": {"type": "number", "description": "중심 위도 (port 미지정 시)."},
                    "lon": {"type": "number", "description": "중심 경도 (port 미지정 시)."},
                    "radius_nm": {"type": "number", "description": "검색 반경(해리). 기본 30nm."},
                },
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
    """Return AIS vessel list, optionally filtered by type and/or country."""
    ship_type = arguments.get("type")
    country = (arguments.get("country") or "").strip().lower()
    limit = int(arguments.get("limit", 50))
    limit = min(limit, 500)

    all_vessels = ais_stream.get_ais_vessels()
    total_in_system = len(all_vessels)

    vessels = all_vessels
    if ship_type:
        # Normalize: "military" matches "military_vessel" in the data
        normalized = "military_vessel" if ship_type == "military" else ship_type
        vessels = [v for v in vessels if v.get("type") == normalized]

    if country:
        # Substring match (case-insensitive) so "japan" matches "Japan", "JP", etc.
        vessels = [v for v in vessels if country in (v.get("country") or "").lower()]

    matched = len(vessels)
    vessels = vessels[:limit]

    return {
        "total_in_system": total_in_system,
        "matched": matched,
        "returned": len(vessels),
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


def _tool_return_to_globe(arguments: dict) -> dict:
    """Close any dedicated panel (roll viewer, etc.) and return to the globe view."""
    return {
        "action": "return_to_globe",
        "label": "지구본 메인 지도로 복귀",
    }


def _tool_open_roll_viewer(arguments: dict) -> dict:
    """Resolve target ship and return open_roll_viewer action for the frontend."""
    mmsi = arguments.get("mmsi")
    name_query = (arguments.get("name") or "").strip().upper()

    if mmsi is None and not name_query:
        return {"error": "mmsi 또는 name 중 하나를 지정해야 합니다."}

    vessels = ais_stream.get_ais_vessels()
    target = None

    if mmsi is not None:
        try:
            mmsi_int = int(mmsi)
        except (TypeError, ValueError):
            return {"error": f"잘못된 MMSI: {mmsi}"}
        target = next((v for v in vessels if v["mmsi"] == mmsi_int), None)
    elif name_query:
        exact = [v for v in vessels if v.get("name", "").upper() == name_query]
        if exact:
            target = exact[0]
        else:
            partial = [v for v in vessels if name_query in v.get("name", "").upper()]
            if partial:
                target = partial[0]

    if not target:
        identifier = f"MMSI {mmsi}" if mmsi is not None else f"이름 '{name_query}'"
        return {"error": f"{identifier} 선박을 찾을 수 없습니다."}

    return {
        "action": "open_roll_viewer",
        "mmsi": int(target["mmsi"]),
        "name": target.get("name", "UNKNOWN"),
        "label": f"횡요각 화면 열기: {target.get('name', 'UNKNOWN')} (MMSI {target['mmsi']})",
    }


def _tool_trigger_capsize(arguments: dict) -> dict:
    """Return capsize trigger/clear action for the frontend."""
    if arguments.get("clear"):
        return {
            "action": "trigger_capsize",
            "clear": True,
            "label": "전복 시뮬레이션 해제 (정상 자세 복귀)",
        }

    direction = arguments.get("direction", "random")
    # Frontend convention: -1 = port (좌현), 1 = starboard (우현), 0 = random.
    dir_map = {"port": -1, "starboard": 1, "random": 0}
    dir_value = dir_map.get(direction, 0)
    label_dir = {"port": "좌현", "starboard": "우현", "random": "무작위 방향"}.get(direction, "무작위 방향")

    raw_delay = arguments.get("delay_seconds", 0)
    try:
        delay = max(0.0, min(60.0, float(raw_delay)))
    except (TypeError, ValueError):
        delay = 0.0

    label = f"전복 시뮬레이션 시작 ({label_dir})"
    if delay > 0:
        label += f" — {delay:.0f}초 후 발동"

    return {
        "action": "trigger_capsize",
        "direction": dir_value,
        "delay_seconds": delay,
        "label": label,
    }


def _tool_set_turn_scenario(arguments: dict) -> dict:
    """Return turn-scenario start/stop action for the frontend."""
    active = bool(arguments.get("active"))
    direction = arguments.get("direction", "random")
    # Sim coordinate convention: -1 visually rotates the ship to the right (starboard / 우현),
    # +1 to the left (port / 좌현). LLM tool exposes nautical names; we map them here.
    dir_map = {"port": 1, "starboard": -1, "random": 0}
    dir_value = dir_map.get(direction, 0)

    if active:
        if direction == "port":
            label = "선회 시나리오 시작 (좌현)"
        elif direction == "starboard":
            label = "선회 시나리오 시작 (우현)"
        else:
            label = "선회 시나리오 시작 (무작위 방향)"
    else:
        label = "선회 시나리오 중지"

    return {
        "action": "set_turn_scenario",
        "active": active,
        "direction": dir_value,
        "label": label,
    }


def _tool_set_roll_scenario(arguments: dict) -> dict:
    """Return roll-scenario override action for the frontend.

    The frontend roll viewer applies the override only if it is currently open.
    All parameters are optional — omitted ones retain their observed values.
    """
    if arguments.get("clear"):
        return {
            "action": "set_roll_scenario",
            "clear": True,
            "label": "횡요각 시나리오 초기화 (실제 관측값 복귀)",
        }

    # Accept both snake_case (canonical) and camelCase / shorthand aliases — small LLMs sometimes
    # invent alternate names. Pick the first non-None value among aliases per key.
    def _pick(*keys):
        for k in keys:
            v = arguments.get(k)
            if v is not None:
                return v
        return None

    params: dict = {}
    if (v := _pick("wind_speed", "windSpeed", "wind")) is not None:
        params["windSpeed"] = float(v)
    if (v := _pick("wave_height", "waveHeight", "wave")) is not None:
        params["waveHeight"] = float(v)
    if (v := _pick("wave_period", "wavePeriod", "period")) is not None:
        params["wavePeriod"] = float(v)
    if (v := _pick("wave_direction", "waveDirection", "direction")) is not None:
        params["waveDirection"] = float(v) % 360
    if (v := _pick("time_scale", "timeScale", "speed_factor")) is not None:
        params["timeScale"] = max(0.25, min(10.0, float(v)))
    if (v := _pick("ship_speed", "shipSpeed", "speed", "sog")) is not None:
        params["shipSpeed"] = max(0.0, min(35.0, float(v)))

    if not params:
        return {"error": "최소 한 개 이상의 시나리오 파라미터를 지정해야 합니다."}

    label_parts = []
    if "windSpeed" in params:    label_parts.append(f"풍속 {params['windSpeed']:.0f}kt")
    if "waveHeight" in params:   label_parts.append(f"파고 {params['waveHeight']:.1f}m")
    if "wavePeriod" in params:   label_parts.append(f"주기 {params['wavePeriod']:.0f}s")
    if "waveDirection" in params: label_parts.append(f"파향 {params['waveDirection']:.0f}°")
    if "timeScale" in params:    label_parts.append(f"시간 {params['timeScale']:.1f}×")
    if "shipSpeed" in params:    label_parts.append(f"속력 {params['shipSpeed']:.1f}kt")

    return {
        "action": "set_roll_scenario",
        "params": params,
        "label": "횡요각 시나리오 적용: " + ", ".join(label_parts),
    }


# ---------------------------------------------------------------------------
# Route (항로) + Hazard (사고) screen tools
# ---------------------------------------------------------------------------
def _resolve_point(spec: str):
    """Resolve a 'from'/'to' spec → (lat, lng, name) or None.

    Accepts a known Korean port key (busan, incheon, ...) or a 'lat,lng' string.
    """
    if not spec:
        return None
    key = spec.strip().lower()
    port = KOREAN_PORTS.get(key)
    if port:
        return port["lat"], port["lon"], port["name"]
    if "," in spec:
        try:
            lat_s, lng_s = spec.split(",", 1)
            return float(lat_s), float(lng_s), f"({float(lat_s):.2f}, {float(lng_s):.2f})"
        except (ValueError, TypeError):
            return None
    return None


def _tool_open_route_screen(arguments: dict) -> dict:
    return {"action": "open_route_screen", "label": "항로 화면 열기"}


def _tool_plan_route(arguments: dict) -> dict:
    frm = _resolve_point(arguments.get("from", ""))
    to = _resolve_point(arguments.get("to", ""))
    if not frm:
        return {"error": f"출발지를 인식할 수 없습니다: {arguments.get('from')!r}. 한국 항구 이름 또는 'lat,lng'를 쓰세요."}
    if not to:
        return {"error": f"도착지를 인식할 수 없습니다: {arguments.get('to')!r}. 한국 항구 이름 또는 'lat,lng'를 쓰세요."}
    size_class = (arguments.get("size_class") or "").strip().upper() or None
    if size_class and size_class not in ("A", "B", "C", "D", "E"):
        size_class = None
    return {
        "action": "plan_route",
        "fromLat": frm[0], "fromLng": frm[1], "fromName": frm[2],
        "toLat": to[0], "toLng": to[1], "toName": to[2],
        "sizeClass": size_class,
        "label": f"항로 추론: {frm[2]} → {to[2]}" + (f" ({size_class}급)" if size_class else ""),
    }


def _tool_set_route_size_class(arguments: dict) -> dict:
    cls = (arguments.get("size_class") or "").strip().upper()
    if cls not in ("A", "B", "C", "D", "E"):
        return {"error": "size_class는 A~E 중 하나여야 합니다."}
    return {"action": "set_route_size_class", "size_class": cls, "label": f"선박 크기 등급 {cls} 적용"}


def _tool_toggle_hazard_zones(arguments: dict) -> dict:
    on = arguments.get("on")
    on = True if on is None else bool(on)
    return {
        "action": "toggle_hazard_zones",
        "on": on,
        "label": "사고 위험구역 " + ("표시" if on else "숨김"),
    }


_HAZARD_CACHE_PATH = os.path.join(os.path.dirname(__file__), "hazard_cells_cache.json")
_hazard_cells_cache: list | None = None


def _load_hazard_cells() -> list:
    global _hazard_cells_cache
    if _hazard_cells_cache is None:
        try:
            with open(_HAZARD_CACHE_PATH, "r", encoding="utf-8") as f:
                _hazard_cells_cache = json.load(f).get("cells", [])
        except (OSError, ValueError) as exc:
            logger.warning("Could not load hazard cells cache: %s", exc)
            _hazard_cells_cache = []
    return _hazard_cells_cache


def _tool_get_hazard_summary(arguments: dict) -> dict:
    port_key = arguments.get("port")
    if port_key:
        port = KOREAN_PORTS.get(str(port_key).strip().lower())
        if not port:
            return {"error": f"알 수 없는 항구: {port_key}"}
        lat, lon, area_name = port["lat"], port["lon"], port["name"]
    else:
        lat, lon = arguments.get("lat"), arguments.get("lon")
        if lat is None or lon is None:
            return {"error": "port 또는 lat/lon을 지정해야 합니다."}
        lat, lon = float(lat), float(lon)
        area_name = f"({lat:.2f}, {lon:.2f})"

    radius_nm = float(arguments.get("radius_nm", 30))
    cells = _load_hazard_cells()
    near = []
    for c in cells:
        d = _haversine_distance(lat, lon, c["lat"], c["lng"])
        if d <= radius_nm:
            near.append((d, c))

    if not near:
        return {
            "area": area_name, "radius_nm": radius_nm, "cell_count": 0,
            "summary": f"{area_name} 반경 {radius_nm:.0f}nm 내 사고 위험 격자 데이터가 없습니다.",
        }

    danger = [c for _, c in near if c.get("score", 0) >= 70]
    caution = [c for _, c in near if 40 <= c.get("score", 0) < 70]
    low = [c for _, c in near if c.get("score", 0) < 40]
    top = sorted(near, key=lambda x: -x[1].get("score", 0))[:3]
    top_causes = [
        {"cause": c.get("cause", "—"), "score": round(c.get("score", 0), 1),
         "dist_nm": round(d, 1)}
        for d, c in top
    ]
    return {
        "area": area_name,
        "radius_nm": radius_nm,
        "cell_count": len(near),
        "danger_count": len(danger),
        "caution_count": len(caution),
        "low_count": len(low),
        "max_score": round(top[0][1].get("score", 0), 1),
        "top_hazards": top_causes,
        "summary": (
            f"{area_name} 반경 {radius_nm:.0f}nm: 위험 {len(danger)} · 주의 {len(caution)} · "
            f"양호 {len(low)} 격자. 최고 위험도 {round(top[0][1].get('score', 0), 1)}점."
        ),
    }


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------
_TOOL_HANDLERS = {
    "open_route_screen":    _tool_open_route_screen,
    "plan_route":           _tool_plan_route,
    "set_route_size_class": _tool_set_route_size_class,
    "toggle_hazard_zones":  _tool_toggle_hazard_zones,
    "get_hazard_summary":   _tool_get_hazard_summary,
    "get_ships":           _tool_get_ships,
    "get_collision_risks": _tool_get_collision_risks,
    "get_area_status":     _tool_get_area_status,
    "fly_to":              _tool_fly_to,
    "filter_ships":        _tool_filter_ships,
    "get_ship_detail":     _tool_get_ship_detail,
    "set_roll_scenario":   _tool_set_roll_scenario,
    "set_turn_scenario":   _tool_set_turn_scenario,
    "open_roll_viewer":    _tool_open_roll_viewer,
    "trigger_capsize":     _tool_trigger_capsize,
    "return_to_globe":     _tool_return_to_globe,
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

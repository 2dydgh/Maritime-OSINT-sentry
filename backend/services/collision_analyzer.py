"""
Collision Risk Analyzer — 거리 기반 + ML 모델 이중 분석

1단계: 공간 그리드로 근접 선박 쌍 필터링 (5nm 이내)
2단계: 정지 선박(SOG < 0.5kts) 제외
3단계-A: TCPA/DCPA 계산 후 임계값 기반 위험도 분류 (거리 기반)
3단계-B: da10-service ML 모델 호출 (XGBoost 충돌 위험도 0~3)
"""

import os
import math
import time
import asyncio
import threading
import logging
from datetime import datetime, timezone

import httpx

from backend.services import land_filter

logger = logging.getLogger(__name__)

# --- 상수 ---
NM_TO_KM = 1.852
EARTH_RADIUS_KM = 6371.0
PROXIMITY_NM = 5.0           # 1단계 근접 필터 반경
MIN_SOG_KTS = 1.0            # 2단계 정지/저속 선박 제외 기준 (GPS 오차 + 조류 영향 감안)
DCPA_DANGER_NM = 0.5         # 위험: DCPA < 0.5nm
DCPA_WARNING_NM = 1.0        # 경고: DCPA < 1.0nm
TCPA_MAX_MIN = 20            # TCPA 20분 이내만 관심
TCPA_MIN_MIN = 1.0           # TCPA 1분 미만은 이미 해소 직전 → 스킵

# 조우 유형별 DCPA 임계값 (head-on은 정상 교행이 많아 엄격하게)
HEAD_ON_ANGLE = 30.0         # COG 차이 150~210도 → head-on 판정
DCPA_DANGER_HEAD_ON_NM = 0.3 # head-on 위험: DCPA < 0.3nm
DCPA_WARNING_HEAD_ON_NM = 0.5  # head-on 경고: DCPA < 0.5nm

# 그리드 셀 크기 (도 단위, ~5nm ≈ 0.083도)
GRID_CELL_DEG = 0.1

# ML 모델 서비스 URL
COLLISION_MODEL_URL = os.environ.get("COLLISION_MODEL_URL", "http://localhost:5050")
ML_TIMEOUT_SEC = 3.0

# ML 위험도 라벨
ML_RISK_LABELS = {0: "안전", 1: "주의", 2: "경고", 3: "위험"}


def _to_radians(deg):
    return deg * math.pi / 180.0


def _haversine_nm(lat1, lon1, lat2, lon2):
    """두 좌표 간 거리를 해리(nm)로 계산."""
    rlat1, rlon1 = _to_radians(lat1), _to_radians(lon1)
    rlat2, rlon2 = _to_radians(lat2), _to_radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    c = 2 * math.asin(math.sqrt(a))
    return (EARTH_RADIUS_KM * c) / NM_TO_KM


def _sog_cog_to_velocity(sog_kts, cog_deg):
    """SOG(kts)와 COG(도)를 nm/min 단위 (vx, vy) 벡터로 변환."""
    sog_nm_per_min = sog_kts / 60.0
    cog_rad = _to_radians(cog_deg)
    vx = sog_nm_per_min * math.sin(cog_rad)
    vy = sog_nm_per_min * math.cos(cog_rad)
    return vx, vy


def _compute_tcpa_dcpa(lat1, lon1, sog1, cog1, lat2, lon2, sog2, cog2):
    """두 선박 간 TCPA(분)와 DCPA(nm) 계산."""
    avg_lat_rad = _to_radians((lat1 + lat2) / 2.0)
    cos_lat = math.cos(avg_lat_rad)

    rx = (lon2 - lon1) * 60.0 * cos_lat
    ry = (lat2 - lat1) * 60.0

    vx1, vy1 = _sog_cog_to_velocity(sog1, cog1)
    vx2, vy2 = _sog_cog_to_velocity(sog2, cog2)

    dvx = vx2 - vx1
    dvy = vy2 - vy1

    vv = dvx * dvx + dvy * dvy
    if vv < 1e-12:
        dist = math.sqrt(rx * rx + ry * ry)
        return float('inf'), dist

    rv = rx * dvx + ry * dvy
    tcpa = -rv / vv

    cx = rx + dvx * tcpa
    cy = ry + dvy * tcpa
    dcpa = math.sqrt(cx * cx + cy * cy)

    return tcpa, dcpa


def _bearing_between(lat1, lon1, lat2, lon2):
    """A에서 B를 바라보는 방위각(도) 계산."""
    rlat1, rlon1 = _to_radians(lat1), _to_radians(lon1)
    rlat2, rlon2 = _to_radians(lat2), _to_radians(lon2)
    dlon = rlon2 - rlon1
    x = math.sin(dlon) * math.cos(rlat2)
    y = math.cos(rlat1) * math.sin(rlat2) - math.sin(rlat1) * math.cos(rlat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _angle_diff(a, b):
    """두 각도 사이의 최소 차이 (0~180)."""
    d = abs((a - b + 180) % 360 - 180)
    return d


def _classify_encounter(cog1, cog2):
    """두 선박의 COG로 조우 유형 판별.

    Returns:
        "head-on"   — 반항 (COG 차이 ≈ 180°)
        "overtaking" — 추월 (COG 차이 ≈ 0°)
        "crossing"  — 횡단 (그 외)
    """
    diff = _angle_diff(cog1, cog2)
    if diff >= (180 - HEAD_ON_ANGLE):   # 150~180도
        return "head-on"
    if diff <= HEAD_ON_ANGLE:           # 0~30도
        return "overtaking"
    return "crossing"


def _cog_lines_converge(x1, y1, vx1, vy1, x2, y2, vx2, vy2):
    """두 COG 투영선이 앞쪽에서 교차하거나 수렴하는지 판별.

    두 선박의 속도 벡터를 직선으로 투영했을 때:
    - 교차점이 양쪽 모두 전방(t > 0)에 있으면 True
    - 방향이 거의 평행(overtaking)이면 최소 거리가 줄어드는지로 판별

    Returns:
        True면 COG 경로가 수렴 → 충돌 분석 필요
    """
    # 투영선: P1 + t1*V1 = P2 + t2*V2 를 풀면
    # (vx1)*t1 - (vx2)*t2 = x2 - x1
    # (vy1)*t1 - (vy2)*t2 = y2 - y1
    det = vx1 * (-vy2) - vy1 * (-vx2)  # = -(vx1*vy2 - vy1*vx2)
    dx = x2 - x1
    dy = y2 - y1

    if abs(det) < 1e-9:
        # 거의 평행 → overtaking 상황, 거리가 줄어들면 수렴
        return True  # 평행은 _classify_encounter에서 overtaking으로 처리

    t1 = (dx * (-vy2) - dy * (-vx2)) / det
    t2 = (vx1 * dy - vy1 * dx) / det

    # 양쪽 모두 전방(t > 0)에 교차점이 있어야 수렴
    return t1 > 0 and t2 > 0


def _is_collision_candidate(lat1, lon1, sog1, cog1, lat2, lon2, sog2, cog2):
    """충돌 후보인지 판별: 접근 중 + COG 투영선 수렴 + 위험 기하 형성.

    1) range rate < 0 (거리가 줄어들고 있음)
    2) COG 투영선 교차/수렴 체크 (전방에서 만나는지)
    3) 베어링 체크 — head-on/crossing은 양쪽 모두 상대를 향해야 하고,
       overtaking은 한 척만 향하면 됨 (뒤에서 따라잡는 선박)
    """
    avg_lat_rad = _to_radians((lat1 + lat2) / 2.0)
    cos_lat = math.cos(avg_lat_rad)

    # 상대 위치 벡터 (A → B, nm)
    rx = (lon2 - lon1) * 60.0 * cos_lat
    ry = (lat2 - lat1) * 60.0
    rng = math.sqrt(rx * rx + ry * ry)
    if rng < 1e-6:
        return True

    # 1) range rate 체크
    vx1, vy1 = _sog_cog_to_velocity(sog1, cog1)
    vx2, vy2 = _sog_cog_to_velocity(sog2, cog2)
    dvx = vx2 - vx1
    dvy = vy2 - vy1
    range_rate = (rx * dvx + ry * dvy) / rng
    if range_rate >= 0:
        return False  # 멀어지는 중

    # 2) COG 투영선 교차/수렴 체크
    x1_nm = 0.0
    y1_nm = 0.0
    x2_nm = rx
    y2_nm = ry
    if not _cog_lines_converge(x1_nm, y1_nm, vx1, vy1, x2_nm, y2_nm, vx2, vy2):
        return False  # 투영선이 전방에서 만나지 않음

    # 3) 베어링 체크 — 조우 유형에 따라 다른 기준 적용
    bearing_a_to_b = _bearing_between(lat1, lon1, lat2, lon2)
    bearing_b_to_a = (bearing_a_to_b + 180) % 360
    a_faces_b = _angle_diff(cog1, bearing_a_to_b) <= 90
    b_faces_a = _angle_diff(cog2, bearing_b_to_a) <= 90

    encounter = _classify_encounter(cog1, cog2)
    if encounter == "overtaking":
        return a_faces_b or b_faces_a
    # head-on, crossing: 양쪽 모두 상대를 향해야 진짜 위험
    return a_faces_b and b_faces_a


def _build_grid(vessels):
    """선박들을 공간 그리드에 배치. O(n) 시간."""
    grid = {}
    for v in vessels:
        cell_x = int(v["lng"] / GRID_CELL_DEG)
        cell_y = int(v["lat"] / GRID_CELL_DEG)
        key = (cell_x, cell_y)
        if key not in grid:
            grid[key] = []
        grid[key].append(v)
    return grid


def _get_neighbor_cells(cell_x, cell_y):
    """자기 셀 + 인접 8개 셀 반환."""
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            yield (cell_x + dx, cell_y + dy)


def _build_proximity_pairs(vessels: list[dict]) -> list[dict]:
    """5nm 이내 이동 중인 선박 쌍을 필터링하고 TCPA/DCPA를 계산.

    Returns:
        근접 쌍 목록 (ship_a, ship_b, tcpa_min, dcpa_nm, current_dist_nm 포함)
    """
    moving = [v for v in vessels if v.get("sog", 0) >= MIN_SOG_KTS]
    if len(moving) < 2:
        return []

    grid = _build_grid(moving)
    pairs = []
    checked = set()

    for v in moving:
        mmsi_a = v["mmsi"]
        cell_x = int(v["lng"] / GRID_CELL_DEG)
        cell_y = int(v["lat"] / GRID_CELL_DEG)

        for neighbor in _get_neighbor_cells(cell_x, cell_y):
            for other in grid.get(neighbor, []):
                mmsi_b = other["mmsi"]
                if mmsi_a >= mmsi_b:
                    continue
                pair_key = (mmsi_a, mmsi_b)
                if pair_key in checked:
                    continue
                checked.add(pair_key)

                dist = _haversine_nm(v["lat"], v["lng"], other["lat"], other["lng"])
                if dist > PROXIMITY_NM:
                    continue

                # 육지 차폐 필터: 두 선박 사이에 육지가 있으면 스킵
                if land_filter.is_land_between(
                    v["lat"], v["lng"], other["lat"], other["lng"]
                ):
                    continue

                # 충돌 후보 판별: 접근 중 + 최소 한 척이 상대를 향해야 통과
                if not _is_collision_candidate(
                    v["lat"], v["lng"], v["sog"], v["cog"],
                    other["lat"], other["lng"], other["sog"], other["cog"],
                ):
                    continue

                tcpa, dcpa = _compute_tcpa_dcpa(
                    v["lat"], v["lng"], v["sog"], v["cog"],
                    other["lat"], other["lng"], other["sog"], other["cog"],
                )

                # TCPA가 음수(이미 지나감), 해소 직전(< 1분), 너무 먼 미래면 스킵
                if tcpa < TCPA_MIN_MIN or tcpa > TCPA_MAX_MIN:
                    continue

                encounter = _classify_encounter(v["cog"], other["cog"])

                pairs.append({
                    "ship_a": v,
                    "ship_b": other,
                    "tcpa_min": round(tcpa, 1),
                    "dcpa_nm": round(dcpa, 3),
                    "current_dist_nm": round(dist, 2),
                    "encounter": encounter,
                })

    return pairs


def _make_ship_info(v: dict) -> dict:
    """선박 데이터에서 응답용 정보 추출."""
    return {
        "mmsi": v["mmsi"],
        "name": v.get("name", "UNKNOWN"),
        "type": v.get("type", "unknown"),
        "lat": v["lat"],
        "lng": v["lng"],
        "sog": v["sog"],
        "cog": v["cog"],
        "country": v.get("country", "UNKNOWN"),
    }


def analyze_distance_risks(proximity_pairs: list[dict]) -> list[dict]:
    """거리 기반 DCPA/TCPA 임계값 판정. 조우 유형별 차등 임계값 적용."""
    risks = []
    now_ts = datetime.now(timezone.utc).isoformat()

    for pair in proximity_pairs:
        dcpa = pair["dcpa_nm"]
        encounter = pair.get("encounter", "crossing")

        # head-on은 정상 교행이 많으므로 임계값을 엄격하게 적용
        if encounter == "head-on":
            danger_thresh = DCPA_DANGER_HEAD_ON_NM
            warning_thresh = DCPA_WARNING_HEAD_ON_NM
        else:
            danger_thresh = DCPA_DANGER_NM
            warning_thresh = DCPA_WARNING_NM

        if dcpa > warning_thresh:
            continue

        severity = "danger" if dcpa < danger_thresh else "warning"

        risks.append({
            "ship_a": _make_ship_info(pair["ship_a"]),
            "ship_b": _make_ship_info(pair["ship_b"]),
            "tcpa_min": pair["tcpa_min"],
            "dcpa_nm": pair["dcpa_nm"],
            "current_dist_nm": pair["current_dist_nm"],
            "severity": severity,
            "encounter": encounter,
            "ts": now_ts,
        })

    risks.sort(key=lambda r: (0 if r["severity"] == "danger" else 1, r["tcpa_min"]))
    return risks


def _compute_os_risk(dcpa: float, rng: float, tcpa_min: float) -> float:
    """dOsRisk 근사 계산: (1 - DCPA/RNG) * (1 - TCPA/TCPA_MAX) * 93"""
    if rng <= 0 or dcpa >= rng or tcpa_min >= TCPA_MAX_MIN:
        return 0.0
    return (1 - dcpa / rng) * (1 - tcpa_min / TCPA_MAX_MIN) * 93.0


async def _call_ml_model(pairs: list[dict]) -> list[int]:
    """da10-service /collision/xg/predict에 배치 POST 호출.

    Returns:
        위험도 배열 (0~3), 실패 시 빈 리스트
    """
    if not pairs:
        return []

    # 배치 입력 구성 (쉼표 구분 문자열)
    dDCPA, dTCPA, RNG, dOsRisk = [], [], [], []
    os_dSOG, st_dSOG, os_dCOG, st_dCOG = [], [], [], []
    dOsCPADist, dTsCPADist = [], []
    os_dLat, os_dLon, st_dLat, st_dLon = [], [], [], []

    for p in pairs:
        a, b = p["ship_a"], p["ship_b"]
        tcpa = p["tcpa_min"]
        dcpa = p["dcpa_nm"]
        rng = p["current_dist_nm"]

        dDCPA.append(str(dcpa))
        dTCPA.append(str(tcpa))
        RNG.append(str(rng))
        dOsRisk.append(str(round(_compute_os_risk(dcpa, rng, tcpa), 2)))
        os_dSOG.append(str(a["sog"]))
        st_dSOG.append(str(b["sog"]))
        os_dCOG.append(str(a["cog"]))
        st_dCOG.append(str(b["cog"]))
        # dOsCPADist = SOG_a * TCPA / 60 (nm)
        dOsCPADist.append(str(round(a["sog"] * tcpa / 60.0, 4)))
        dTsCPADist.append(str(round(b["sog"] * tcpa / 60.0, 4)))
        os_dLat.append(str(a["lat"]))
        os_dLon.append(str(a["lng"]))
        st_dLat.append(str(b["lat"]))
        st_dLon.append(str(b["lng"]))

    payload = {
        "dDCPA": ",".join(dDCPA),
        "dTCPA": ",".join(dTCPA),
        "RNG": ",".join(RNG),
        "dOsRisk": ",".join(dOsRisk),
        "os_dSOG": ",".join(os_dSOG),
        "st_dSOG": ",".join(st_dSOG),
        "os_dCOG": ",".join(os_dCOG),
        "st_dCOG": ",".join(st_dCOG),
        "dOsCPADist": ",".join(dOsCPADist),
        "dTsCPADist": ",".join(dTsCPADist),
        "os_dLat": ",".join(os_dLat),
        "os_dLon": ",".join(os_dLon),
        "st_dLat": ",".join(st_dLat),
        "st_dLon": ",".join(st_dLon),
    }

    try:
        async with httpx.AsyncClient(timeout=ML_TIMEOUT_SEC) as client:
            resp = await client.post(f"{COLLISION_MODEL_URL}/collision/xg/predict", json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data.get("xg_prediction", [])
    except Exception as e:
        logger.warning(f"ML model call failed: {e}")
        return []


async def analyze_ml_risks(proximity_pairs: list[dict]) -> list[dict]:
    """ML 모델 기반 충돌 위험도 분석. 근접 쌍 전체를 대상으로 호출."""
    if not proximity_pairs:
        return []

    predictions = await _call_ml_model(proximity_pairs)
    if not predictions:
        return []

    risks = []
    now_ts = datetime.now(timezone.utc).isoformat()

    for i, pair in enumerate(proximity_pairs):
        if i >= len(predictions):
            break
        risk_level = int(predictions[i])
        if risk_level == 0:
            continue  # 안전은 제외

        risks.append({
            "ship_a": _make_ship_info(pair["ship_a"]),
            "ship_b": _make_ship_info(pair["ship_b"]),
            "risk_level": risk_level,
            "risk_label": ML_RISK_LABELS.get(risk_level, "알수없음"),
            "current_dist_nm": pair["current_dist_nm"],
            "tcpa_min": pair["tcpa_min"],
            "dcpa_nm": pair["dcpa_nm"],
            "ts": now_ts,
        })

    # 위험도 높은 순, 같으면 TCPA 짧은 순
    risks.sort(key=lambda r: (-r["risk_level"], r["tcpa_min"]))
    return risks


# --- 캐시: 주기적으로 분석 결과를 갱신 ---
_cached_distance_risks: list[dict] = []
_cached_ml_risks: list[dict] = []
_cache_lock = threading.Lock()
_cache_updated: float = 0


def get_distance_risks() -> list[dict]:
    """캐시된 거리 기반 충돌 위험 결과를 반환."""
    with _cache_lock:
        return list(_cached_distance_risks)


def get_ml_risks() -> list[dict]:
    """캐시된 ML 기반 충돌 위험 결과를 반환."""
    with _cache_lock:
        return list(_cached_ml_risks)


async def update_collision_cache(vessels: list[dict]):
    """충돌 분석을 실행하고 캐시를 갱신. 주기적으로 호출."""
    global _cached_distance_risks, _cached_ml_risks, _cache_updated
    start = time.monotonic()

    # 공통 근접 쌍 필터링
    proximity_pairs = _build_proximity_pairs(vessels)

    # 거리 기반 분석 (동기)
    distance_risks = analyze_distance_risks(proximity_pairs)

    # ML 모델 분석 (비동기)
    ml_risks = await analyze_ml_risks(proximity_pairs)

    with _cache_lock:
        _cached_distance_risks = distance_risks
        _cached_ml_risks = ml_risks
        _cache_updated = time.time()

    elapsed_ms = (time.monotonic() - start) * 1000
    if distance_risks or ml_risks:
        logger.info(
            f"Collision analysis: {len(distance_risks)} distance + {len(ml_risks)} ML risks "
            f"from {len(proximity_pairs)} pairs ({elapsed_ms:.1f}ms)"
        )

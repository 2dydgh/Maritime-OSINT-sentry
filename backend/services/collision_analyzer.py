"""
Collision Risk Analyzer — TCPA/DCPA 기반 선박 충돌 위험 분석

1단계: 공간 그리드로 근접 선박 쌍 필터링 (5nm 이내)
2단계: 정지 선박(SOG < 0.5kts) 제외
3단계: TCPA/DCPA 계산 후 임계값 기반 위험도 분류
"""

import math
import time
import threading
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# --- 상수 ---
NM_TO_KM = 1.852
EARTH_RADIUS_KM = 6371.0
PROXIMITY_NM = 5.0           # 1단계 근접 필터 반경
MIN_SOG_KTS = 0.5            # 2단계 정지 선박 제외 기준
DCPA_DANGER_NM = 0.5         # 위험: DCPA < 0.5nm
DCPA_WARNING_NM = 1.0        # 경고: DCPA < 1.0nm
TCPA_MAX_MIN = 20            # TCPA 20분 이내만 관심

# 그리드 셀 크기 (도 단위, ~5nm ≈ 0.083도)
GRID_CELL_DEG = 0.1


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
    """SOG(kts)와 COG(도)를 nm/min 단위 (vx, vy) 벡터로 변환.
    vx = 동쪽 방향, vy = 북쪽 방향
    """
    sog_nm_per_min = sog_kts / 60.0
    cog_rad = _to_radians(cog_deg)
    vx = sog_nm_per_min * math.sin(cog_rad)
    vy = sog_nm_per_min * math.cos(cog_rad)
    return vx, vy


def _compute_tcpa_dcpa(lat1, lon1, sog1, cog1, lat2, lon2, sog2, cog2):
    """두 선박 간 TCPA(분)와 DCPA(nm) 계산.

    Returns:
        (tcpa_min, dcpa_nm) — TCPA < 0이면 이미 지나간 상태
    """
    # 상대 위치 (nm 단위 근사, 소규모 거리에서 유효)
    avg_lat_rad = _to_radians((lat1 + lat2) / 2.0)
    cos_lat = math.cos(avg_lat_rad)

    # 경도 1도 ≈ 60nm * cos(lat), 위도 1도 ≈ 60nm
    rx = (lon2 - lon1) * 60.0 * cos_lat  # nm, 동쪽 양수
    ry = (lat2 - lat1) * 60.0            # nm, 북쪽 양수

    # 속도 벡터 (nm/min)
    vx1, vy1 = _sog_cog_to_velocity(sog1, cog1)
    vx2, vy2 = _sog_cog_to_velocity(sog2, cog2)

    # 상대 속도 (r = pos2 - pos1 이므로 v = vel2 - vel1)
    dvx = vx2 - vx1
    dvy = vy2 - vy1

    vv = dvx * dvx + dvy * dvy
    if vv < 1e-12:
        # 상대 속도 거의 0 → 거리 변화 없음
        dist = math.sqrt(rx * rx + ry * ry)
        return float('inf'), dist

    rv = rx * dvx + ry * dvy
    tcpa = -rv / vv  # 분 단위

    # DCPA: 최근접점에서의 거리
    cx = rx + dvx * tcpa
    cy = ry + dvy * tcpa
    dcpa = math.sqrt(cx * cx + cy * cy)

    return tcpa, dcpa


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


def analyze_collision_risks(vessels: list[dict]) -> list[dict]:
    """전체 선박 목록에서 충돌 위험 쌍을 분석.

    Args:
        vessels: get_ais_vessels()가 반환하는 선박 목록

    Returns:
        위험도 순으로 정렬된 충돌 위험 목록
    """
    start = time.monotonic()

    # 2단계: 정지 선박 제외
    moving = [v for v in vessels if v.get("sog", 0) >= MIN_SOG_KTS]

    if len(moving) < 2:
        return []

    # 1단계: 공간 그리드 구축
    grid = _build_grid(moving)

    risks = []
    checked = set()

    for v in moving:
        mmsi_a = v["mmsi"]
        cell_x = int(v["lng"] / GRID_CELL_DEG)
        cell_y = int(v["lat"] / GRID_CELL_DEG)

        # 인접 셀의 선박들만 검사
        for neighbor in _get_neighbor_cells(cell_x, cell_y):
            for other in grid.get(neighbor, []):
                mmsi_b = other["mmsi"]
                if mmsi_a >= mmsi_b:
                    continue
                pair_key = (mmsi_a, mmsi_b)
                if pair_key in checked:
                    continue
                checked.add(pair_key)

                # 실제 거리 확인 (그리드는 근사치이므로)
                dist = _haversine_nm(v["lat"], v["lng"], other["lat"], other["lng"])
                if dist > PROXIMITY_NM:
                    continue

                # TCPA/DCPA 계산
                tcpa, dcpa = _compute_tcpa_dcpa(
                    v["lat"], v["lng"], v["sog"], v["cog"],
                    other["lat"], other["lng"], other["sog"], other["cog"],
                )

                # TCPA가 음수(이미 지나감)이거나 너무 먼 미래면 스킵
                if tcpa < 0 or tcpa > TCPA_MAX_MIN:
                    continue

                # DCPA 임계값 체크
                if dcpa > DCPA_WARNING_NM:
                    continue

                if dcpa < DCPA_DANGER_NM:
                    severity = "danger"
                else:
                    severity = "warning"

                risks.append({
                    "ship_a": {
                        "mmsi": mmsi_a,
                        "name": v.get("name", "UNKNOWN"),
                        "type": v.get("type", "unknown"),
                        "lat": v["lat"],
                        "lng": v["lng"],
                        "sog": v["sog"],
                        "cog": v["cog"],
                        "country": v.get("country", "UNKNOWN"),
                    },
                    "ship_b": {
                        "mmsi": mmsi_b,
                        "name": other.get("name", "UNKNOWN"),
                        "type": other.get("type", "unknown"),
                        "lat": other["lat"],
                        "lng": other["lng"],
                        "sog": other["sog"],
                        "cog": other["cog"],
                        "country": other.get("country", "UNKNOWN"),
                    },
                    "tcpa_min": round(tcpa, 1),
                    "dcpa_nm": round(dcpa, 3),
                    "current_dist_nm": round(dist, 2),
                    "severity": severity,
                    "ts": datetime.now(timezone.utc).isoformat(),
                })

    # 위험도 순 정렬: danger > warning, 같으면 TCPA 짧은 순
    risks.sort(key=lambda r: (0 if r["severity"] == "danger" else 1, r["tcpa_min"]))

    elapsed_ms = (time.monotonic() - start) * 1000
    if risks:
        logger.info(f"Collision analysis: {len(risks)} risks found from {len(moving)} moving vessels ({elapsed_ms:.1f}ms)")

    return risks


# --- 캐시: 주기적으로 분석 결과를 갱신 ---
_cached_risks: list[dict] = []
_cache_lock = threading.Lock()
_cache_updated: float = 0


def get_collision_risks() -> list[dict]:
    """캐시된 충돌 위험 결과를 반환."""
    with _cache_lock:
        return list(_cached_risks)


def update_collision_cache(vessels: list[dict]):
    """충돌 분석을 실행하고 캐시를 갱신. 주기적으로 호출."""
    global _cached_risks, _cache_updated
    risks = analyze_collision_risks(vessels)
    with _cache_lock:
        _cached_risks = risks
        _cache_updated = time.time()

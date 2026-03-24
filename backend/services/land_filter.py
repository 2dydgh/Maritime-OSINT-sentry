# backend/services/land_filter.py
"""육지 차폐 필터 — 두 좌표 사이 직선이 육지를 관통하는지 검사.

Natural Earth 10m Land shapefile을 로드하여 Shapely로 교차 검사.
서버 시작 시 load_land_index()를 1회 호출하면,
이후 is_land_between()은 메모리 내 인덱스로 빠르게 판정.
"""
import logging
from pathlib import Path

from shapely.geometry import LineString, shape
from shapely.ops import unary_union
from shapely import prepared

logger = logging.getLogger(__name__)

# 모듈 레벨 상태
_land_geom = None          # Union된 육지 MultiPolygon
_prepared_land = None      # PreparedGeometry (교차 검사 가속)
_loaded = False


def load_land_index(shapefile_path: str) -> None:
    """shapefile을 로드하고 육지 인덱스를 구축한다.

    서버 시작 시 1회 호출. ~2-5초 소요 (10m 해상도 기준).
    """
    global _land_geom, _prepared_land, _loaded

    path = Path(shapefile_path)
    if not path.exists():
        logger.warning(f"Land shapefile not found: {shapefile_path}")
        return

    import json

    # .shp 대신 GeoJSON도 지원
    if path.suffix == ".geojson" or path.suffix == ".json":
        with open(path) as f:
            geojson = json.load(f)
        polygons = [shape(feat["geometry"]) for feat in geojson["features"]]
    else:
        # shapefile은 pyshp로 읽기
        try:
            import shapefile as shp  # pyshp
            reader = shp.Reader(str(path))
            polygons = [shape(sr.__geo_interface__) for sr in reader.shapes()]
        except ImportError:
            logger.error("pyshp not installed. Run: pip install pyshp")
            return

    _land_geom = unary_union(polygons)
    _prepared_land = prepared.prep(_land_geom)
    _loaded = True
    logger.info(
        f"Land index loaded: {len(polygons)} polygons from {path.name}"
    )


def is_land_between(lat1: float, lon1: float, lat2: float, lon2: float) -> bool:
    """두 좌표 사이 직선이 육지와 교차하면 True.

    데이터 미로드 시 False 반환 (= 필터링 안 함, 안전한 기본값).
    """
    if not _loaded or _prepared_land is None:
        return False

    line = LineString([(lon1, lat1), (lon2, lat2)])
    return _prepared_land.intersects(line)


def is_loaded() -> bool:
    """육지 데이터 로드 여부."""
    return _loaded

# backend/services/land_filter.py
"""육지 차폐 필터 — 두 좌표 사이 직선이 육지를 관통하는지 검사.

GSHHG 또는 Natural Earth shapefile을 로드하여 Shapely STRtree로 교차 검사.
서버 시작 시 load_land_index()를 1회 호출하면,
이후 is_land_between()은 메모리 내 인덱스로 빠르게 판정.
"""
import logging
from pathlib import Path

from shapely.geometry import LineString, shape
from shapely.validation import make_valid
from shapely import STRtree

logger = logging.getLogger(__name__)

# 모듈 레벨 상태
_land_geom = None          # 개별 폴리곤 리스트
_land_tree = None          # STRtree 공간 인덱스
_loaded = False


def load_land_index(shapefile_path: str) -> None:
    """shapefile을 로드하고 STRtree 인덱스를 구축한다.

    서버 시작 시 1회 호출.
    """
    global _land_geom, _land_tree, _loaded

    path = Path(shapefile_path)
    if not path.exists():
        logger.warning(f"Land shapefile not found: {shapefile_path}")
        return

    import json

    # .shp 대신 GeoJSON도 지원
    if path.suffix == ".geojson" or path.suffix == ".json":
        with open(path) as f:
            geojson = json.load(f)
        raw_polygons = [shape(feat["geometry"]) for feat in geojson["features"]]
    else:
        # shapefile은 pyshp로 읽기
        try:
            import shapefile as shp  # pyshp
            reader = shp.Reader(str(path))
            raw_polygons = [shape(sr.__geo_interface__) for sr in reader.shapes()]
        except ImportError:
            logger.error("pyshp not installed. Run: pip install pyshp")
            return

    # invalid geometry 수정 (GSHHG 등 고해상도 데이터에 필요)
    polygons = []
    for p in raw_polygons:
        if not p.is_valid:
            p = make_valid(p)
        if not p.is_empty:
            polygons.append(p)

    _land_geom = polygons
    _land_tree = STRtree(polygons)
    _loaded = True
    logger.info(
        f"Land index loaded: {len(polygons)} polygons from {path.name}"
    )


def is_land_between(lat1: float, lon1: float, lat2: float, lon2: float) -> bool:
    """두 좌표 사이 직선이 육지와 교차하면 True.

    데이터 미로드 시 False 반환 (= 필터링 안 함, 안전한 기본값).
    """
    if not _loaded or _land_tree is None:
        return False

    line = LineString([(lon1, lat1), (lon2, lat2)])
    hits = _land_tree.query(line, predicate="intersects")
    return len(hits) > 0


def is_loaded() -> bool:
    """육지 데이터 로드 여부."""
    return _loaded

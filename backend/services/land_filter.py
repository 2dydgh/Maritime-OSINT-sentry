# backend/services/land_filter.py
"""육지 차폐 필터 — 두 좌표 사이 직선이 육지를 관통하는지 검사.

GSHHG 또는 Natural Earth shapefile을 로드하여 Shapely STRtree로 교차 검사.
서버 시작 시 start_land_index_loading()을 호출하면 백그라운드에서 비동기 로딩,
이후 is_land_between()은 메모리 내 인덱스로 빠르게 판정.
로딩 완료 전에는 False 반환 (필터링 안 함, 안전한 기본값).
"""
import asyncio
import logging
import pickle
import time
from pathlib import Path

from shapely.geometry import LineString, shape
from shapely.validation import make_valid
from shapely import STRtree

logger = logging.getLogger(__name__)

# 모듈 레벨 상태
_land_geom = None          # 개별 폴리곤 리스트
_land_tree = None          # STRtree 공간 인덱스
_loaded = False
_loading_task = None        # 백그라운드 로딩 태스크


def _get_cache_path(shapefile_path: str) -> Path:
    """shapefile 경로에 대응하는 pickle 캐시 경로를 반환."""
    return Path(shapefile_path).with_suffix(".pkl")


def _load_land_index_sync(shapefile_path: str) -> None:
    """shapefile을 로드하고 STRtree 인덱스를 구축한다 (동기, CPU 집약적)."""
    global _land_geom, _land_tree, _loaded

    path = Path(shapefile_path)
    if not path.exists():
        logger.warning(f"Land shapefile not found: {shapefile_path}")
        return

    start = time.monotonic()
    cache_path = _get_cache_path(shapefile_path)

    # 1) pickle 캐시가 있고, shapefile보다 새로우면 캐시에서 로드
    if cache_path.exists() and cache_path.stat().st_mtime >= path.stat().st_mtime:
        try:
            with open(cache_path, "rb") as f:
                polygons = pickle.load(f)
            _land_geom = polygons
            _land_tree = STRtree(polygons)
            _loaded = True
            elapsed = time.monotonic() - start
            logger.info(
                f"Land index loaded from cache: {len(polygons)} polygons "
                f"in {elapsed:.2f}s ({cache_path.name})"
            )
            return
        except Exception as e:
            logger.warning(f"Cache load failed, falling back to shapefile: {e}")

    # 2) shapefile에서 원본 로드
    import json

    if path.suffix in (".geojson", ".json"):
        with open(path) as f:
            geojson = json.load(f)
        raw_polygons = [shape(feat["geometry"]) for feat in geojson["features"]]
    else:
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

    # 3) pickle 캐시 저장 (다음 시작 시 빠른 로드)
    try:
        with open(cache_path, "wb") as f:
            pickle.dump(polygons, f, protocol=pickle.HIGHEST_PROTOCOL)
        logger.info(f"Land polygon cache saved: {cache_path.name}")
    except Exception as e:
        logger.warning(f"Failed to save polygon cache: {e}")

    _land_geom = polygons
    _land_tree = STRtree(polygons)
    _loaded = True
    elapsed = time.monotonic() - start
    logger.info(
        f"Land index loaded: {len(polygons)} polygons from {path.name} "
        f"in {elapsed:.2f}s"
    )


def start_land_index_loading(shapefile_path: str) -> None:
    """백그라운드에서 비동기로 land index 로딩을 시작한다.

    서버는 즉시 시작되고, 로딩 완료 전 is_land_between()은 False를 반환.
    """
    global _loading_task

    async def _bg_load():
        await asyncio.to_thread(_load_land_index_sync, shapefile_path)
        if _loaded:
            logger.info("Land obstruction filter: ACTIVE (background load complete)")
        else:
            logger.warning("Land obstruction filter: INACTIVE (load failed)")

    _loading_task = asyncio.create_task(_bg_load())


def load_land_index(shapefile_path: str) -> None:
    """동기적으로 shapefile을 로드 (하위 호환용)."""
    _load_land_index_sync(shapefile_path)


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

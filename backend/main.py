import os
import logging
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from . import database, config, websocket
from .services import ais_stream, data_fetcher, history_writer, aircraft_tracker, ais_fallback
from .routers import ships, satellites, events, data, sentinel, alerts, history, metrics, health, collision, weather, route, aircraft, chat, hazard
from .routers.hazard import warm_cache as warm_hazard_cache
from .services import collision_analyzer, land_filter

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Feed status state (broadcast 루프 전용, 단일 루프라 락 불필요)
_feed_status = "live"
_feed_low_streak = 0


async def _build_feed_text() -> str:
    """live/fallback/down 중 하나를 직렬화해 항상 반환한다 (None 금지).

    라이브 선박이 임계치 미만이면 DB 최근 30분 스냅샷으로 degrade.
    직렬화는 to_thread 로 이벤트 루프 밖에서 (글로벌 피드 ~30k척).
    """
    global _feed_status, _feed_low_streak
    live = await asyncio.to_thread(ais_stream.get_ais_vessels)

    snap: list = []
    snap_time_ms = None
    if len(live) < ais_fallback.FALLBACK_THRESHOLD:
        snap = await ais_fallback.get_fallback_snapshot()
        snap_time_ms = ais_fallback.get_snapshot_time_ms()

    status, _feed_low_streak = ais_fallback.select_feed_status(
        len(live), len(snap), _feed_status, _feed_low_streak
    )
    _feed_status = status

    if status == "fallback":
        ships, st = snap, snap_time_ms
    elif status == "live":
        ships, st = live, None
    else:  # down
        ships, st = [], None

    return await asyncio.to_thread(
        ais_fallback.build_feed_payload, ships, status, st
    )

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    logger.info("Starting up OSINT 4D Backend...")
    try:
        await database.init_db()
    except Exception as e:
        logger.warning(f"Database init failed — running in lightweight mode: {e}")

    # Initialize history writer for AIS trajectory persistence
    try:
        db_pool = database.get_db_pool()
        if db_pool:
            await history_writer.init_history_writer(db_pool)
        else:
            logger.warning("DB pool not available, history writer will not persist data")
    except Exception as e:
        logger.error(f"Failed to initialize history writer: {e}")
        # 실패해도 실시간 기능은 계속 동작

    # Load land shapefile in background (non-blocking)
    # 서버는 즉시 시작되고, 로딩 완료 전까지 육지 필터링은 비활성 (안전한 기본값)
    land_shapefile = os.path.join(
        os.path.dirname(__file__), "data", "land", "ne_10m_land.shp"
    )
    land_filter.start_land_index_loading(land_shapefile)

    # Pre-compute /hazard/korea response so the first request is instant.
    # Runs as a background task — it waits for the land filter to finish then
    # offloads the spatial compute to a thread.
    asyncio.create_task(warm_hazard_cache())

    # Pre-warm searoute graph (~2s first call)
    try:
        import searoute as _sr
        _sr.searoute([129.0, 35.1], [103.8, 1.3])  # Busan→Singapore
        logger.info("searoute graph pre-loaded")
    except Exception as e:
        logger.warning(f"searoute pre-warm failed: {e}")

    # Start AIS Stream Background Task
    ais_stream.start_ais_stream()
    
    # Optional: Start period data fetcher if needed for REST fallbacks
    data_fetcher.start_data_fetcher()

    # Aircraft Tracker (OpenSky Network) is NOT started here — it is lazily
    # started the first time the user enables the 항공 layer, via
    # POST /api/v1/aircraft/start. This avoids hitting OpenSky on every boot.

    # Background loop to broadcast ship updates.
    async def broadcast_ships():
        while True:
            try:
                text = await _build_feed_text()
                await websocket.manager.broadcast_text(text)
            except Exception as e:
                logger.error(f"Error in ship broadcast loop: {e}")
            await asyncio.sleep(3)  # 3s — frontend LED turns "connecting" only past 5s

    broadcast_task = asyncio.create_task(broadcast_ships())

    # Background loop to broadcast aircraft updates
    async def broadcast_aircraft():
        while True:
            try:
                ac_list = aircraft_tracker.get_aircraft()
                if ac_list:
                    await websocket.manager.broadcast({
                        "type": "aircraft_update",
                        "aircraft": ac_list,
                        "total_tracked": len(ac_list),
                        "server_time_ms": int(__import__('time').time() * 1000)
                    })
            except Exception as e:
                logger.error(f"Error in aircraft broadcast loop: {e}")
            await asyncio.sleep(10)  # Broadcast every 10s (matching OpenSky poll rate)

    aircraft_broadcast_task = asyncio.create_task(broadcast_aircraft())

    # Background task: scan for signal loss every 5 minutes
    async def signal_loss_scanner():
        while True:
            await asyncio.sleep(300)  # every 5 minutes
            try:
                await asyncio.to_thread(ais_stream.check_signal_loss)
            except Exception as e:
                logger.error(f"Signal loss scan error: {e}")

    # Background task: collision risk analysis every 10 seconds
    async def collision_scanner():
        while True:
            await asyncio.sleep(10)
            try:
                # Off-loop: global snapshot is ~30k vessels under a contended lock
                vessels = await asyncio.to_thread(ais_stream.get_ais_vessels)
                await collision_analyzer.update_collision_cache(vessels)
            except Exception as e:
                logger.error(f"Collision analysis error: {e}")

    collision_task = asyncio.create_task(collision_scanner())
    
    yield
    
    # Shutdown logic
    logger.info("Shutting down OSINT 4D Backend...")
    ais_stream.stop_ais_stream()
    broadcast_task.cancel()
    collision_task.cancel()
    aircraft_tracker.stop_aircraft_tracker()
    aircraft_broadcast_task.cancel()
    data_fetcher.stop_data_fetcher()

    # Stop history writer and flush remaining buffer
    try:
        await history_writer.stop_history_writer()
    except Exception as e:
        logger.error(f"Error stopping history writer: {e}")

    await database.close_db()

app = FastAPI(title="OSINT 4D Dashboard", lifespan=lifespan)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dev only (DEV_NO_CACHE=1): no-store on static assets so a plain browser refresh
# always serves the latest CSS/JS — removes the need to bump ?v= after every edit.
if config.DEV_NO_CACHE:
    @app.middleware("http")
    async def _no_cache_static(request, call_next):
        resp = await call_next(request)
        path = request.url.path
        if path == "/" or path.endswith((".css", ".js", ".html")):
            resp.headers["Cache-Control"] = "no-store"
        return resp
    logging.getLogger(__name__).info("DEV_NO_CACHE on — static assets served no-store")

# WebSocket Endpoint
@app.websocket("/api/v1/ws/ships")
async def websocket_ships(ws: WebSocket):
    await websocket.manager.connect(ws)
    # Immediate snapshot on connect — clients otherwise wait up to 1s for the
    # next broadcast_ships() tick, which is the dominant "서버 연결 중" delay.
    try:
        text = await _build_feed_text()
        await ws.send_text(text)
    except Exception as e:
        logger.error(f"Initial ship snapshot failed: {e}")
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        websocket.manager.disconnect(ws)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        websocket.manager.disconnect(ws)

# Aircraft tracker control — the OpenSky poller is started on demand the first
# time the user turns on the 항공 layer, rather than at server boot.
@app.post("/api/v1/aircraft/start")
async def aircraft_start():
    aircraft_tracker.start_aircraft_tracker()
    return {"status": "started"}

@app.post("/api/v1/aircraft/stop")
async def aircraft_stop():
    aircraft_tracker.stop_aircraft_tracker()
    return {"status": "stopped"}

# Include Routers
app.include_router(ships.router, prefix="/api/v1")
app.include_router(satellites.router, prefix="/api/v1")
app.include_router(events.router, prefix="/api/v1")
app.include_router(data.router, prefix="/api/v1")
app.include_router(sentinel.router, prefix="/api/v1")
app.include_router(alerts.router, prefix="/api/v1")
app.include_router(history.router, prefix="/api/v1")
app.include_router(metrics.router)
app.include_router(collision.router, prefix="/api/v1")
app.include_router(health.router)
app.include_router(weather.router, prefix="/api/v1")
app.include_router(route.router, prefix="/api/v1")
app.include_router(aircraft.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(hazard.router, prefix="/api/v1")

# Static Files — resolve path for both normal and PyInstaller frozen mode
import sys as _sys
if getattr(_sys, "frozen", False):
    _base_dir = getattr(_sys, "_MEIPASS", os.path.dirname(_sys.executable))
else:
    _base_dir = os.path.dirname(os.path.dirname(__file__))
_static_dir = os.path.join(_base_dir, "static")
app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=config.PORT, reload=True)

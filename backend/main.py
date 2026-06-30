import os
import json
import time
import logging
import asyncio
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from . import database, config, websocket
from .services import ais_stream, data_fetcher, history_writer, aircraft_tracker, ais_fallback, llm_agent
from .routers import ships, satellites, events, data, sentinel, alerts, history, metrics, health, collision, weather, route, aircraft, chat, hazard
from .routers.hazard import warm_cache as warm_hazard_cache
from .services import collision_analyzer, land_filter

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Feed status state (broadcast 루프 전용, 단일 루프라 락 불필요)
_feed_status = "live"
_feed_low_streak = 0

# Per-service readiness, populated during lifespan startup. Broadcast loops gate
# on these so they don't run before their dependencies have initialized.
_readiness = {"db": False, "ais": False, "redis": False, "llm": False}

# Inbound WebSocket guards. Clients on the broadcast socket have nothing
# meaningful to send us, so we cap frame size and message rate and otherwise
# ignore their input — this protects the event loop from abusive connections.
WS_MAX_MESSAGE_BYTES = 64 * 1024
WS_RATE_WINDOW_SEC = 10.0
WS_RATE_MAX_MSGS = 100
# Backpressure: drop a client that can't drain the snapshot within this budget.
WS_SEND_TIMEOUT_SEC = 5.0
# Graceful-shutdown budget for cancelling each background task / stopping writers.
SHUTDOWN_TIMEOUT_SEC = 5.0


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
        _readiness["db"] = True
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
    _readiness["ais"] = True

    # Optional: Start period data fetcher if needed for REST fallbacks
    data_fetcher.start_data_fetcher()

    # Best-effort readiness probes for optional services. These never block the
    # real-time pipeline — a failure just leaves the flag False (graceful degrade).
    async def _probe_redis():
        try:
            import redis.asyncio as _redis
            client = _redis.from_url(config.REDIS_URL)
            try:
                await asyncio.wait_for(client.ping(), timeout=2.0)
                _readiness["redis"] = True
            finally:
                await client.aclose()
        except Exception as e:
            logger.info(f"Redis not ready (optional): {e}")

    async def _probe_llm():
        try:
            from .config_llm import OLLAMA_BASE_URL
            client = llm_agent._get_client()
            resp = await asyncio.wait_for(
                client.get(f"{OLLAMA_BASE_URL}/api/tags"), timeout=2.0
            )
            _readiness["llm"] = resp.status_code == 200
        except Exception as e:
            logger.info(f"LLM (Ollama) not ready (optional): {e}")

    asyncio.create_task(_probe_redis())
    asyncio.create_task(_probe_llm())

    # Aircraft Tracker (OpenSky Network) is NOT started here — it is lazily
    # started the first time the user enables the 항공 layer, via
    # POST /api/v1/aircraft/start. This avoids hitting OpenSky on every boot.

    # Background loop to broadcast ship updates.
    async def broadcast_ships():
        while True:
            try:
                if _readiness["ais"]:
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
                if _readiness["ais"]:
                    ac_list = aircraft_tracker.get_aircraft()
                    if ac_list:
                        payload = {
                            "type": "aircraft_update",
                            "aircraft": ac_list,
                            "total_tracked": len(ac_list),
                            "server_time_ms": int(time.time() * 1000),
                        }
                        # Serialize once off-loop, then fan out the string — mirrors
                        # the ships broadcast_text path instead of send_json per client.
                        text = await asyncio.to_thread(json.dumps, payload)
                        await websocket.manager.broadcast_text(text)
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
    aircraft_tracker.stop_aircraft_tracker()
    data_fetcher.stop_data_fetcher()

    async def _cancel(task, name):
        """Cancel a background task and bound the wait so shutdown can't hang."""
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=SHUTDOWN_TIMEOUT_SEC)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as e:
            logger.error(f"Error awaiting {name} cancellation: {e}")

    await _cancel(broadcast_task, "ship broadcast")
    await _cancel(aircraft_broadcast_task, "aircraft broadcast")
    await _cancel(collision_task, "collision scanner")

    # Stop history writer and flush remaining buffer (bounded so we don't hang)
    try:
        await asyncio.wait_for(
            history_writer.stop_history_writer(), timeout=SHUTDOWN_TIMEOUT_SEC
        )
    except asyncio.TimeoutError:
        logger.error("history writer stop timed out")
    except Exception as e:
        logger.error(f"Error stopping history writer: {e}")

    # Release the shared LLM httpx connection pool.
    try:
        await asyncio.wait_for(llm_agent.close_client(), timeout=SHUTDOWN_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        logger.error("LLM client close timed out")
    except Exception as e:
        logger.error(f"Error closing LLM client: {e}")

    await database.close_db()

app = FastAPI(title="OSINT 4D Dashboard", lifespan=lifespan)

# CORS Middleware — origins are env-configurable (CORS_ALLOW_ORIGINS, comma-separated).
# Browsers reject "*" together with credentials, so if a wildcard is configured we
# disable credentials rather than emitting an invalid CORS policy.
_default_cors_origins = [
    "http://localhost:8001",
    "http://localhost:12081",
    "http://127.0.0.1:8001",
    "http://127.0.0.1:12081",
    "https://maritime-osint-sentry.onrender.com",
]
_cors_env = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
if _cors_env:
    _cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
else:
    _cors_origins = _default_cors_origins
_cors_allow_credentials = "*" not in _cors_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_allow_credentials,
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
    # Backpressure: bound the send so a stalled client can't wedge the handshake.
    try:
        text = await _build_feed_text()
        await asyncio.wait_for(ws.send_text(text), timeout=WS_SEND_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        logger.warning("Initial ship snapshot send timed out — dropping client")
        websocket.manager.disconnect(ws)
        return
    except Exception as e:
        logger.error(f"Initial ship snapshot failed: {e}")

    # Inbound guard: this socket is broadcast-only, so we just validate and drop
    # client frames. Oversized frames are ignored; flooding disconnects the client.
    recent_msgs: deque = deque()
    try:
        while True:
            msg = await ws.receive_text()
            if not isinstance(msg, str) or len(msg) > WS_MAX_MESSAGE_BYTES:
                logger.warning("WS frame rejected (invalid or too large)")
                continue
            now = time.monotonic()
            recent_msgs.append(now)
            while recent_msgs and now - recent_msgs[0] > WS_RATE_WINDOW_SEC:
                recent_msgs.popleft()
            if len(recent_msgs) > WS_RATE_MAX_MSGS:
                logger.warning("WS client exceeded inbound rate limit — disconnecting")
                break
            # No commands are processed on this socket; frame is intentionally ignored.
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
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

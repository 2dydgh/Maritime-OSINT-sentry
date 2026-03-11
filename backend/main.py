import logging
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from . import database, config, websocket
from .services import ais_stream, data_fetcher
from .routers import ships, satellites, events, data, sentinel, alerts

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    logger.info("Starting up OSINT 4D Backend...")
    await database.init_db()
    
    # Start AIS Stream Background Task
    ais_stream.start_ais_stream()
    
    # Optional: Start period data fetcher if needed for REST fallbacks
    data_fetcher.start_data_fetcher()
    
    # Background loop to broadcast ship updates
    async def broadcast_ships():
        while True:
            try:
                vessels = ais_stream.get_ais_vessels()
                if vessels:
                    await websocket.manager.broadcast({
                        "type": "ships_update",
                        "ships": vessels,
                        "total_tracked": len(vessels),
                        "timestamp": asyncio.get_event_loop().time()
                    })
            except Exception as e:
                logger.error(f"Error in ship broadcast loop: {e}")
            await asyncio.sleep(1) # Broadcast every 1s

    broadcast_task = asyncio.create_task(broadcast_ships())

    # Background task: scan for signal loss every 5 minutes
    async def signal_loss_scanner():
        while True:
            await asyncio.sleep(300)  # every 5 minutes
            try:
                ais_stream.check_signal_loss()
            except Exception as e:
                logger.error(f"Signal loss scan error: {e}")
    
    yield
    
    # Shutdown logic
    logger.info("Shutting down OSINT 4D Backend...")
    ais_stream.stop_ais_stream()
    broadcast_task.cancel()
    data_fetcher.stop_data_fetcher()
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

# WebSocket Endpoint
@app.websocket("/api/v1/ws/ships")
async def websocket_ships(ws: WebSocket):
    await websocket.manager.connect(ws)
    try:
        while True:
            # Just keep connection alive, we primarily broadcast
            await ws.receive_text()
    except WebSocketDisconnect:
        websocket.manager.disconnect(ws)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        websocket.manager.disconnect(ws)

# Include Routers
app.include_router(ships.router, prefix="/api/v1")
app.include_router(satellites.router, prefix="/api/v1")
app.include_router(events.router, prefix="/api/v1")
app.include_router(data.router, prefix="/api/v1")
app.include_router(sentinel.router, prefix="/api/v1")
app.include_router(alerts.router, prefix="/api/v1")

# Static Files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=config.PORT, reload=True)

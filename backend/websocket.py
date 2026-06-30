from typing import List, Dict, Any
import asyncio
from fastapi import WebSocket, WebSocketDisconnect
import logging

from backend.services.metrics import websocket_connections_active

logger = logging.getLogger(__name__)

# Per-client send timeout for the recurring fan-out. A single stalled client
# (full TCP send buffer) must not block the broadcast loop and starve every
# other client / the realtime tick — it gets evicted on timeout instead.
BROADCAST_SEND_TIMEOUT_SEC = 5.0

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        websocket_connections_active.inc()
        logger.info(f"WebSocket connected. Total connections: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            websocket_connections_active.dec()
            logger.info(f"WebSocket disconnected. Total connections: {len(self.active_connections)}")

    async def broadcast(self, message: Dict[str, Any]):
        disconnected = []
        for connection in self.active_connections:
            try:
                await asyncio.wait_for(
                    connection.send_json(message), timeout=BROADCAST_SEND_TIMEOUT_SEC
                )
            except (Exception, asyncio.TimeoutError) as e:
                logger.error(f"Error broadcasting to client: {e}")
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)

    async def broadcast_text(self, text: str):
        """Broadcast a pre-serialized JSON string — serialize once, not per client."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await asyncio.wait_for(
                    connection.send_text(text), timeout=BROADCAST_SEND_TIMEOUT_SEC
                )
            except (Exception, asyncio.TimeoutError) as e:
                logger.error(f"Error broadcasting to client: {e}")
                disconnected.append(connection)

        for conn in disconnected:
            self.disconnect(conn)

manager = ConnectionManager()

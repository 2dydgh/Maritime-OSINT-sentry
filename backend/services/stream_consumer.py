"""Consumes AIS messages from Redis Stream, updates vessel state, writes to DB."""

import json
import logging
import time
import threading

from backend.services.metrics import stream_consume_total, stream_lag_messages, ais_vessels_active

logger = logging.getLogger(__name__)

STALE_THRESHOLD_SEC = 15 * 60  # 15분 이상 업데이트 없으면 제거


class StreamConsumer:
    def __init__(self, redis_client, stream_key="ais:raw",
                 group="osint_consumers", consumer_name="worker-1"):
        self._redis = redis_client
        self._stream_key = stream_key
        self._group = group
        self._consumer_name = consumer_name
        self._vessels = {}
        self._lock = threading.Lock()
        self._running = False
        self._last_id = "0-0"

    def _update_vessel(self, data: dict):
        """Thread-safe vessel state update."""
        mmsi = data.get("mmsi")
        if not mmsi:
            return

        with self._lock:
            self._vessels[mmsi] = {
                "mmsi": mmsi,
                "lat": data.get("lat"),
                "lng": data.get("lng"),
                "speed": data.get("speed"),
                "heading": data.get("heading"),
                "ship_type": data.get("ship_type", "unknown"),
                "timestamp": data.get("timestamp"),
                "last_updated": time.time(),
            }
        stream_consume_total.inc()

    def get_vessels(self) -> dict:
        """Return snapshot of active vessels, pruning stale ones."""
        now = time.time()
        with self._lock:
            stale = [k for k, v in self._vessels.items()
                     if now - v.get("last_updated", 0) > STALE_THRESHOLD_SEC]
            for k in stale:
                del self._vessels[k]
            ais_vessels_active.set(len(self._vessels))
            return dict(self._vessels)

    async def consume_batch(self, count=100, block_ms=1000):
        """Read a batch of messages from the stream."""
        results = await self._redis.xread(
            {self._stream_key: self._last_id},
            count=count,
            block=block_ms,
        )
        if not results:
            return []

        messages = []
        for stream_name, entries in results:
            for msg_id, fields in entries:
                raw = fields.get(b"data") or fields.get("data")
                if raw:
                    if isinstance(raw, bytes):
                        raw = raw.decode()
                    data = json.loads(raw)
                    self._update_vessel(data)
                    messages.append(data)
                if isinstance(msg_id, bytes):
                    self._last_id = msg_id.decode()
                else:
                    self._last_id = msg_id

        stream_len = await self._redis.xlen(self._stream_key)
        stream_lag_messages.set(max(0, stream_len - len(messages)))

        return messages

    async def run(self, history_writer=None):
        """Main consume loop — call from asyncio task."""
        self._running = True
        logger.info("StreamConsumer started: group=%s, consumer=%s",
                     self._group, self._consumer_name)
        while self._running:
            try:
                messages = await self.consume_batch()
                if history_writer and messages:
                    for msg in messages:
                        history_writer.record_position(
                            object_id=msg["mmsi"],
                            lat=msg.get("lat"),
                            lng=msg.get("lng"),
                            velocity=msg.get("speed"),
                            heading=msg.get("heading"),
                            ship_type=msg.get("ship_type"),
                        )
            except Exception as e:
                logger.error("StreamConsumer error: %s", e)
                import asyncio
                await asyncio.sleep(1)

    def stop(self):
        self._running = False
        logger.info("StreamConsumer stopping")

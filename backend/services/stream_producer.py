"""Publishes AIS messages to a Redis Stream."""

import json
import logging

from backend.services.metrics import stream_publish_total

logger = logging.getLogger(__name__)

STREAM_MAX_LEN = 100_000  # 스트림 최대 길이 (자동 트림)


class StreamProducer:
    def __init__(self, redis_client, stream_key: str = "ais:raw"):
        self._redis = redis_client
        self._stream_key = stream_key

    async def publish(self, vessel_data: dict) -> bytes:
        """Publish a vessel update to the Redis Stream."""
        payload = json.dumps(vessel_data, default=str)
        msg_id = await self._redis.xadd(
            self._stream_key,
            {"data": payload},
            maxlen=STREAM_MAX_LEN,
        )
        stream_publish_total.inc()
        logger.debug("Published to %s: %s", self._stream_key, msg_id)
        return msg_id

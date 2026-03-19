import json
import pytest
from unittest.mock import AsyncMock, patch

from backend.services.stream_producer import StreamProducer


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xadd = AsyncMock(return_value=b"1234567890-0")
    r.xlen = AsyncMock(return_value=1)
    return r


@pytest.mark.asyncio
async def test_publish_position(mock_redis):
    producer = StreamProducer(redis_client=mock_redis, stream_key="ais:raw")
    vessel_data = {
        "mmsi": "440123456",
        "lat": 35.1,
        "lng": 129.0,
        "speed": 12.5,
        "heading": 180.0,
        "ship_type": "cargo",
        "timestamp": "2026-03-19T10:00:00Z",
    }
    msg_id = await producer.publish(vessel_data)

    mock_redis.xadd.assert_called_once()
    call_args = mock_redis.xadd.call_args
    assert call_args[0][0] == "ais:raw"
    payload = json.loads(call_args[0][1]["data"])
    assert payload["mmsi"] == "440123456"
    assert msg_id == b"1234567890-0"


@pytest.mark.asyncio
async def test_publish_increments_metric(mock_redis):
    from backend.services.metrics import stream_publish_total

    before = stream_publish_total._value.get()
    producer = StreamProducer(redis_client=mock_redis, stream_key="ais:raw")
    await producer.publish({"mmsi": "123", "lat": 0, "lng": 0})
    after = stream_publish_total._value.get()
    assert after == before + 1

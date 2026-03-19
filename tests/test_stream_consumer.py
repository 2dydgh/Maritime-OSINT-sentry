import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from backend.services.stream_consumer import StreamConsumer


def make_stream_entry(mmsi, lat, lng, speed=10.0):
    """Helper to create a Redis Stream entry in the format returned by XREAD."""
    data = json.dumps({
        "mmsi": mmsi, "lat": lat, "lng": lng,
        "speed": speed, "heading": 0, "ship_type": "cargo",
        "timestamp": "2026-03-19T10:00:00Z",
    })
    return (b"1234567890-0", {b"data": data.encode()})


@pytest.fixture
def mock_redis():
    r = AsyncMock()
    r.xread = AsyncMock(return_value=[])
    r.xlen = AsyncMock(return_value=0)
    return r


@pytest.fixture
def consumer(mock_redis):
    return StreamConsumer(
        redis_client=mock_redis,
        stream_key="ais:raw",
        group="osint_consumers",
        consumer_name="worker-1",
    )


@pytest.mark.asyncio
async def test_process_message_updates_vessels(consumer):
    entry = make_stream_entry("440123456", 35.1, 129.0, speed=12.5)
    data = json.loads(entry[1][b"data"])

    consumer._update_vessel(data)

    vessels = consumer.get_vessels()
    assert "440123456" in vessels
    assert vessels["440123456"]["lat"] == 35.1


@pytest.mark.asyncio
async def test_process_message_increments_metric(consumer):
    from backend.services.metrics import stream_consume_total

    before = stream_consume_total._value.get()
    entry = make_stream_entry("440123456", 35.1, 129.0)
    data = json.loads(entry[1][b"data"])
    consumer._update_vessel(data)
    after = stream_consume_total._value.get()
    assert after == before + 1

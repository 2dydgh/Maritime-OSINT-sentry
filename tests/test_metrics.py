from backend.services.metrics import (
    ais_messages_total,
    ais_vessels_active,
    ais_message_lag_seconds,
    db_write_duration_seconds,
    db_writes_total,
    websocket_connections_active,
    alerts_fired_total,
)


def test_ais_messages_counter_increments():
    before = ais_messages_total.labels(message_type="position")._value.get()
    ais_messages_total.labels(message_type="position").inc()
    after = ais_messages_total.labels(message_type="position")._value.get()
    assert after == before + 1


def test_vessels_gauge_set():
    ais_vessels_active.set(42)
    assert ais_vessels_active._value.get() == 42


def test_histogram_observe():
    db_write_duration_seconds.observe(0.05)
    # histogram observe doesn't raise

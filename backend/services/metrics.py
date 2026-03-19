"""Prometheus metrics for Maritime OSINT Sentry."""

from prometheus_client import Counter, Gauge, Histogram

# AIS 파이프라인
ais_messages_total = Counter(
    "ais_messages_total",
    "Total AIS messages processed",
    ["message_type"],  # position, static_data
)

ais_vessels_active = Gauge(
    "ais_vessels_active",
    "Number of currently tracked vessels",
)

ais_message_lag_seconds = Histogram(
    "ais_message_lag_seconds",
    "Lag between AIS message timestamp and processing time",
    buckets=[0.1, 0.5, 1, 2, 5, 10, 30, 60],
)

# DB
db_writes_total = Counter(
    "db_writes_total",
    "Total DB write operations",
    ["table"],  # trajectories
)

db_write_duration_seconds = Histogram(
    "db_write_duration_seconds",
    "Duration of DB batch writes",
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
)

# WebSocket
websocket_connections_active = Gauge(
    "websocket_connections_active",
    "Number of active WebSocket connections",
)

# Alerts
alerts_fired_total = Counter(
    "alerts_fired_total",
    "Total anomaly alerts fired",
    ["alert_type"],  # speeding, signal_lost, dest_change
)

# Redis Streams (Task 3에서 사용)
stream_publish_total = Counter(
    "stream_publish_total",
    "Total messages published to Redis Stream",
)

stream_consume_total = Counter(
    "stream_consume_total",
    "Total messages consumed from Redis Stream",
)

stream_lag_messages = Gauge(
    "stream_lag_messages",
    "Consumer lag in number of pending messages",
)

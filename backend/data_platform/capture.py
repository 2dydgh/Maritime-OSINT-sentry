"""Optional raw capture at the existing AIS ingestion boundary."""
import logging
import threading
from backend import config
from backend.services.metrics import Counter
from .journal import Journal

logger = logging.getLogger(__name__)
capture_total = Counter('data_platform_capture_total', 'Raw AIS capture outcomes', ['outcome'])
_lock = threading.Lock()
_journal = None


def get_journal():
    global _journal
    with _lock:
        if _journal is None:
            _journal = Journal(config.DATA_PLATFORM_DB)
        return _journal


def capture_message(raw_message):
    if not config.DATA_PLATFORM_ENABLED:
        return
    try:
        get_journal().append(raw_message)
        capture_total.labels(outcome='stored').inc()
    except Exception:
        # Dashboard availability is independent of this opt-in staging store.
        # Failed writes are counted, never reported as durable captures.
        capture_total.labels(outcome='failed').inc()
        logger.exception('Raw AIS capture failed; message is not durably archived')


def close_journal():
    global _journal
    with _lock:
        if _journal is not None:
            _journal.close()
            _journal = None

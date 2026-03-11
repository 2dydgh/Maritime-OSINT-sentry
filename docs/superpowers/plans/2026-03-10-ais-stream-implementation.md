# AIS Stream Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AIS 실시간 스트리밍 아키텍처를 구현하여 전 세계 선박을 Cesium 3D 지도에 표시

**Architecture:** Node.js WebSocket 프록시가 aisstream.io에서 데이터를 수신하고, Python이 stdout을 파싱하여 선박 분류/캐싱 후 FastAPI로 제공. 프론트엔드는 60초마다 API 폴링.

**Tech Stack:** Node.js (ws), Python (FastAPI, APScheduler, asyncpg), Cesium.js

**Spec:** `docs/superpowers/specs/2026-03-10-ais-stream-architecture-design.md`

---

## File Structure

```
4dwar/
├── backend/
│   ├── ais_proxy.js              # NEW: WebSocket 클라이언트
│   ├── main.py                   # MOVE: 기존 main.py 이동 + 수정
│   ├── cache/                    # NEW: 캐시 디렉토리
│   │   └── .gitkeep
│   └── services/
│       ├── __init__.py           # NEW
│       ├── ais_stream.py         # NEW: AIS 데이터 처리/캐싱
│       └── data_fetcher.py       # NEW: 데이터 스냅샷 관리
├── static/
│   └── index.html                # MODIFY: 프론트엔드 수정
├── requirements.txt              # MODIFY: 의존성 추가
└── package.json                  # MODIFY: 스크립트 추가
```

---

## Chunk 1: Backend Infrastructure

### Task 1: Create Directory Structure

**Files:**
- Create: `backend/` directory
- Create: `backend/services/` directory
- Create: `backend/cache/` directory
- Create: `backend/services/__init__.py`

- [ ] **Step 1: Create directories**

```bash
mkdir -p backend/services backend/cache
```

- [ ] **Step 2: Create __init__.py**

```python
# backend/services/__init__.py
```

- [ ] **Step 3: Create .gitkeep for cache**

```bash
touch backend/cache/.gitkeep
```

- [ ] **Step 4: Verify structure**

Run: `ls -la backend/ backend/services/`
Expected: directories exist

---

### Task 2: Move main.py to backend/

**Files:**
- Move: `main.py` → `backend/main.py`
- Modify: `backend/main.py` (static files path)

- [ ] **Step 1: Copy main.py to backend/**

```bash
cp main.py backend/main.py
```

- [ ] **Step 2: Update static files mount path in backend/main.py**

Change line 309-310:
```python
# Before
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

# After
import pathlib
STATIC_DIR = pathlib.Path(__file__).parent.parent / "static"
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
```

- [ ] **Step 3: Test server starts**

Run: `cd /home/yhlee/4dwar && python -m backend.main`
Expected: Server starts on port 8001

- [ ] **Step 4: Keep original main.py as backup (optional)**

```bash
mv main.py main.py.bak
```

---

### Task 3: Update requirements.txt

**Files:**
- Modify: `requirements.txt`

- [ ] **Step 1: Add APScheduler dependency**

```txt
fastapi>=0.111.0
uvicorn>=0.30.1
asyncpg>=0.29.0
openai>=1.35.3
pydantic>=2.7.4
python-dotenv>=1.0.1
apscheduler>=3.10.0
```

- [ ] **Step 2: Install dependencies**

Run: `pip install apscheduler>=3.10.0`
Expected: Successfully installed

---

### Task 4: Create ais_proxy.js

**Files:**
- Create: `backend/ais_proxy.js`

- [ ] **Step 1: Write ais_proxy.js**

```javascript
const WebSocket = require('ws');

const API_KEY = process.env.AIS_API_KEY;

if (!API_KEY) {
    console.error('ERROR: AIS_API_KEY environment variable not set');
    process.exit(1);
}

let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

function connect() {
    console.error(`INFO: Connecting to aisstream.io...`);
    ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    ws.on('open', function open() {
        console.error('INFO: Connected to aisstream.io');
        reconnectAttempts = 0;

        const subscriptionMessage = {
            APIKey: API_KEY,
            BoundingBoxes: [[[-90, -180], [90, 180]]],
            FilterMessageTypes: ["PositionReport"]
        };
        ws.send(JSON.stringify(subscriptionMessage));
        console.error('INFO: Subscription sent for global coverage');
    });

    ws.on('message', function incoming(data) {
        try {
            // Output to stdout for Python to parse
            console.log(data.toString());
        } catch (e) {
            console.error(`ERROR: Failed to process message: ${e.message}`);
        }
    });

    ws.on('error', function error(err) {
        console.error(`ERROR: WebSocket error: ${err.message}`);
    });

    ws.on('close', function close(code, reason) {
        console.error(`WARN: Connection closed (code: ${code}). Reconnecting...`);
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, MAX_RECONNECT_DELAY);
    console.error(`INFO: Reconnecting in ${delay / 1000} seconds...`);
    setTimeout(connect, delay);
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.error('INFO: Shutting down...');
    if (ws) ws.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.error('INFO: Shutting down...');
    if (ws) ws.close();
    process.exit(0);
});

connect();
```

- [ ] **Step 2: Test ais_proxy.js standalone**

Run: `cd /home/yhlee/4dwar && AIS_API_KEY=$(grep AIS_API_KEY .env | cut -d= -f2) node backend/ais_proxy.js 2>&1 | head -20`
Expected: Shows INFO messages and JSON data

---

### Task 5: Create ais_stream.py

**Files:**
- Create: `backend/services/ais_stream.py`

- [ ] **Step 1: Write ais_stream.py**

```python
"""
AIS Stream Service

Manages the Node.js AIS proxy process and parses incoming ship data.
Provides thread-safe access to vessel information with automatic cleanup.
"""

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Thread-safe vessel storage
_vessels: Dict[str, dict] = {}
_vessels_lock = threading.Lock()

# Process management
_node_process: Optional[subprocess.Popen] = None
_reader_thread: Optional[threading.Thread] = None
_cleanup_thread: Optional[threading.Thread] = None
_running = False

# Statistics
_msg_count = 0
_last_save_count = 0

# Paths
CACHE_DIR = Path(__file__).parent.parent / "cache"
CACHE_FILE = CACHE_DIR / "ais_vessels.json"
CACHE_MAX_AGE = 3600  # 1 hour

# Ship type classification
SHIP_TYPE_MAP = {
    range(70, 80): "cargo",
    range(80, 90): "tanker",
    range(60, 70): "passenger",
    (30,): "fishing",
    (35,): "military",
    (31, 32, 52): "tug",
}


def classify_ship_type(ship_type_code: Optional[int]) -> str:
    """Classify ship by AIS ship type code."""
    if ship_type_code is None:
        return "other"

    for codes, category in SHIP_TYPE_MAP.items():
        if isinstance(codes, range):
            if ship_type_code in codes:
                return category
        elif ship_type_code in codes:
            return category

    return "other"


def _parse_ais_message(line: str) -> None:
    """Parse a single AIS message and update vessels dict."""
    global _msg_count

    try:
        data = json.loads(line)

        if data.get("MessageType") != "PositionReport":
            return

        report = data.get("Message", {}).get("PositionReport", {})
        meta = data.get("MetaData", {})

        mmsi = str(meta.get("MMSI", ""))
        if not mmsi:
            return

        lat = report.get("Latitude")
        lng = report.get("Longitude")

        if lat is None or lng is None:
            return

        # Skip invalid coordinates
        if lat < -90 or lat > 90 or lng < -180 or lng > 180:
            return

        ship_type_code = meta.get("ShipType")

        vessel_data = {
            "mmsi": mmsi,
            "name": meta.get("ShipName", "").strip() or f"Ship {mmsi}",
            "lat": lat,
            "lng": lng,
            "speed": report.get("Sog", 0),
            "heading": report.get("TrueHeading", 0),
            "course": report.get("Cog", 0),
            "ship_type_code": ship_type_code,
            "ship_type": classify_ship_type(ship_type_code),
            "_updated": time.time()
        }

        with _vessels_lock:
            _vessels[mmsi] = vessel_data

        _msg_count += 1

        # Auto-save every 5000 messages
        if _msg_count - _last_save_count >= 5000:
            _save_cache()

    except json.JSONDecodeError:
        pass  # Skip invalid JSON
    except Exception as e:
        logger.debug(f"Error parsing AIS message: {e}")


def _reader_loop() -> None:
    """Read stdout from Node.js process and parse messages."""
    global _running

    while _running and _node_process and _node_process.poll() is None:
        try:
            line = _node_process.stdout.readline()
            if line:
                _parse_ais_message(line.strip())
        except Exception as e:
            logger.error(f"Error reading from AIS proxy: {e}")
            time.sleep(1)

    logger.warning("AIS reader loop ended")


def _cleanup_loop() -> None:
    """Periodically remove stale vessels (not updated in 15 minutes)."""
    global _running

    while _running:
        time.sleep(60)  # Check every minute

        stale_cutoff = time.time() - 900  # 15 minutes

        with _vessels_lock:
            stale_keys = [
                k for k, v in _vessels.items()
                if v.get("_updated", 0) < stale_cutoff
            ]
            for k in stale_keys:
                del _vessels[k]

        if stale_keys:
            logger.info(f"Cleaned up {len(stale_keys)} stale vessels")

        logger.info(f"Active vessels: {len(_vessels)}, Messages processed: {_msg_count}")


def _save_cache() -> None:
    """Save current vessels to disk cache."""
    global _last_save_count

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

        with _vessels_lock:
            cache_data = {
                "timestamp": time.time(),
                "vessels": dict(_vessels)
            }

        with open(CACHE_FILE, "w") as f:
            json.dump(cache_data, f)

        _last_save_count = _msg_count
        logger.info(f"Saved {len(cache_data['vessels'])} vessels to cache")

    except Exception as e:
        logger.error(f"Failed to save cache: {e}")


def _load_cache() -> None:
    """Load vessels from disk cache if recent enough."""
    global _vessels

    try:
        if not CACHE_FILE.exists():
            return

        with open(CACHE_FILE, "r") as f:
            cache_data = json.load(f)

        timestamp = cache_data.get("timestamp", 0)
        age = time.time() - timestamp

        if age > CACHE_MAX_AGE:
            logger.info(f"Cache too old ({age:.0f}s), skipping")
            return

        vessels = cache_data.get("vessels", {})

        with _vessels_lock:
            _vessels.update(vessels)

        logger.info(f"Loaded {len(vessels)} vessels from cache (age: {age:.0f}s)")

    except Exception as e:
        logger.warning(f"Failed to load cache: {e}")


def start_ais_stream() -> None:
    """Start the AIS stream processing."""
    global _node_process, _reader_thread, _cleanup_thread, _running

    if _running:
        logger.warning("AIS stream already running")
        return

    # Load cache first
    _load_cache()

    # Get API key
    api_key = os.getenv("AIS_API_KEY", "")
    if not api_key:
        logger.error("AIS_API_KEY not set, AIS stream disabled")
        return

    # Start Node.js process
    proxy_path = Path(__file__).parent.parent / "ais_proxy.js"

    if not proxy_path.exists():
        logger.error(f"AIS proxy not found: {proxy_path}")
        return

    logger.info("Starting AIS proxy process...")

    env = os.environ.copy()
    env["AIS_API_KEY"] = api_key

    _node_process = subprocess.Popen(
        ["node", str(proxy_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        bufsize=1
    )

    _running = True

    # Start reader thread
    _reader_thread = threading.Thread(target=_reader_loop, daemon=True)
    _reader_thread.start()

    # Start cleanup thread
    _cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
    _cleanup_thread.start()

    # Start stderr reader for logging
    def stderr_reader():
        while _running and _node_process and _node_process.poll() is None:
            line = _node_process.stderr.readline()
            if line:
                logger.info(f"[AIS Proxy] {line.strip()}")

    threading.Thread(target=stderr_reader, daemon=True).start()

    logger.info("AIS stream started")


def stop_ais_stream() -> None:
    """Stop the AIS stream processing."""
    global _running, _node_process

    _running = False

    if _node_process:
        logger.info("Stopping AIS proxy...")
        _node_process.terminate()
        try:
            _node_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _node_process.kill()
        _node_process = None

    # Save cache on shutdown
    _save_cache()

    logger.info("AIS stream stopped")


def get_ais_vessels() -> List[dict]:
    """Get a snapshot of all active vessels."""
    with _vessels_lock:
        return [
            {k: v for k, v in vessel.items() if not k.startswith("_")}
            for vessel in _vessels.values()
        ]


def get_ais_vessels_by_type() -> Dict[str, List[dict]]:
    """Get vessels grouped by ship type."""
    vessels = get_ais_vessels()

    by_type: Dict[str, List[dict]] = {
        "cargo": [],
        "tanker": [],
        "passenger": [],
        "fishing": [],
        "military": [],
        "tug": [],
        "other": []
    }

    for vessel in vessels:
        ship_type = vessel.get("ship_type", "other")
        if ship_type in by_type:
            by_type[ship_type].append(vessel)
        else:
            by_type["other"].append(vessel)

    return by_type


def get_ais_stats() -> dict:
    """Get AIS stream statistics."""
    with _vessels_lock:
        vessel_count = len(_vessels)

    return {
        "active_vessels": vessel_count,
        "messages_processed": _msg_count,
        "running": _running
    }
```

- [ ] **Step 2: Verify syntax**

Run: `python -m py_compile backend/services/ais_stream.py`
Expected: No output (success)

---

### Task 6: Create data_fetcher.py

**Files:**
- Create: `backend/services/data_fetcher.py`

- [ ] **Step 1: Write data_fetcher.py**

```python
"""
Data Fetcher Service

Manages periodic data snapshots for the API layer.
Runs on a 60-second interval to update latest_data.
"""

import logging
import time
from typing import Dict, List, Any

from apscheduler.schedulers.background import BackgroundScheduler

from .ais_stream import get_ais_vessels, get_ais_vessels_by_type, get_ais_stats

logger = logging.getLogger(__name__)

# Global data store
latest_data: Dict[str, Any] = {
    "ships": [],
    "ships_by_type": {},
    "ship_count": 0,
    "last_updated": None,
    "stats": {}
}

_scheduler: BackgroundScheduler = None


def fetch_ships() -> None:
    """Fetch current ship data and update latest_data."""
    try:
        ships = get_ais_vessels()
        ships_by_type = get_ais_vessels_by_type()
        stats = get_ais_stats()

        latest_data["ships"] = ships
        latest_data["ships_by_type"] = ships_by_type
        latest_data["ship_count"] = len(ships)
        latest_data["last_updated"] = time.time()
        latest_data["stats"] = stats

        # Count by type for logging
        type_counts = {k: len(v) for k, v in ships_by_type.items() if v}
        logger.info(f"Data fetcher: {len(ships)} ships - {type_counts}")

    except Exception as e:
        logger.error(f"Error fetching ship data: {e}")


def start_data_fetcher() -> None:
    """Start the periodic data fetcher."""
    global _scheduler

    if _scheduler is not None:
        logger.warning("Data fetcher already running")
        return

    # Initial fetch
    fetch_ships()

    # Start scheduler
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(fetch_ships, 'interval', seconds=60, id='fetch_ships')
    _scheduler.start()

    logger.info("Data fetcher started (60s interval)")


def stop_data_fetcher() -> None:
    """Stop the periodic data fetcher."""
    global _scheduler

    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Data fetcher stopped")


def get_latest_data() -> Dict[str, Any]:
    """Get the latest data snapshot."""
    return latest_data
```

- [ ] **Step 2: Verify syntax**

Run: `python -m py_compile backend/services/data_fetcher.py`
Expected: No output (success)

---

## Chunk 2: Backend Integration

### Task 7: Update backend/main.py with AIS integration

**Files:**
- Modify: `backend/main.py`

- [ ] **Step 1: Add imports at top of file**

After line 13 (`from dotenv import load_dotenv`), add:

```python
from backend.services.ais_stream import start_ais_stream, stop_ais_stream
from backend.services.data_fetcher import start_data_fetcher, stop_data_fetcher, get_latest_data
```

- [ ] **Step 2: Update lifespan function**

Replace the lifespan function (lines 32-53):

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    logger.info("Initializing application...")

    # 1. Database connection
    try:
        db_pool = await asyncpg.create_pool(
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            host=DB_HOST,
            port=DB_PORT
        )
        logger.info("Database connection pool established.")
    except Exception as e:
        logger.error(f"Failed to connect to the database: {e}")
        raise e

    # 2. Start AIS stream
    start_ais_stream()

    # 3. Start data fetcher
    start_data_fetcher()

    yield

    # Cleanup
    logger.info("Shutting down application...")
    stop_data_fetcher()
    stop_ais_stream()

    if db_pool:
        await db_pool.close()
        logger.info("Database connection pool closed.")
```

- [ ] **Step 3: Add /api/live-data endpoint**

Before the static files mount (around line 306), add:

```python
@app.get("/api/live-data")
async def get_live_data():
    """Get live AIS ship data."""
    data = get_latest_data()
    return {
        "ships": data["ships"],
        "ships_by_type": {k: len(v) for k, v in data["ships_by_type"].items()},
        "ship_count": data["ship_count"],
        "last_updated": data["last_updated"],
        "stats": data["stats"]
    }


@app.get("/api/ships")
async def get_ships():
    """Get all ships as GeoJSON for map rendering."""
    data = get_latest_data()

    features = []
    for ship in data["ships"]:
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [ship["lng"], ship["lat"]]
            },
            "properties": {
                "mmsi": ship["mmsi"],
                "name": ship["name"],
                "ship_type": ship["ship_type"],
                "speed": ship["speed"],
                "heading": ship["heading"],
                "course": ship["course"]
            }
        })

    return {
        "type": "FeatureCollection",
        "features": features
    }
```

- [ ] **Step 4: Update static files path**

Replace lines 309-310:

```python
import pathlib
STATIC_DIR = pathlib.Path(__file__).parent.parent / "static"
os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
```

- [ ] **Step 5: Update __main__ block**

Replace the last lines:

```python
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8001, reload=True)
```

- [ ] **Step 6: Test server starts**

Run: `cd /home/yhlee/4dwar && python -m backend.main`
Expected: Server starts, shows "AIS stream started", "Data fetcher started"

---

### Task 8: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add start script**

```json
{
  "scripts": {
    "ais-proxy": "node backend/ais_proxy.js"
  },
  "dependencies": {
    "ws": "^8.19.0"
  }
}
```

- [ ] **Step 2: Verify Node dependencies**

Run: `cd /home/yhlee/4dwar && npm install`
Expected: No errors

---

## Chunk 3: Frontend Updates

### Task 9: Update static/index.html

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: Add ship layer colors CSS**

After line 253 (before `</style>`), add:

```css
/* Ship Filter Panel */
#shipFilterPanel {
    position: absolute;
    top: 100px;
    right: 20px;
    width: 220px;
    padding: 15px;
    z-index: 10;
}

#shipFilterPanel h3 {
    margin: 0 0 12px 0;
    font-size: 0.95rem;
    color: var(--accent-cyan);
    display: flex;
    align-items: center;
    gap: 8px;
}

.filter-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
}

.filter-item label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.85rem;
}

.filter-item input[type="checkbox"] {
    accent-color: var(--accent-cyan);
}

.filter-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-dim);
}

.color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
}

.color-cargo { background-color: #10b981; }
.color-tanker { background-color: #f97316; }
.color-passenger { background-color: #3b82f6; }
.color-fishing { background-color: #eab308; }
.color-military { background-color: #ef4444; }
.color-tug { background-color: #a855f7; }
.color-other { background-color: #6b7280; }

#shipStats {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--panel-border);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-dim);
}
```

- [ ] **Step 2: Add Ship Filter Panel HTML**

After the feedPanel div (around line 299), add:

```html
<!-- Ship Filter Panel -->
<div id="shipFilterPanel" class="glass-panel">
    <h3><i class="fa-solid fa-ship"></i> SHIP FILTERS</h3>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-cargo" checked><span class="color-dot color-cargo"></span> Cargo</label>
        <span class="filter-count" id="count-cargo">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-tanker" checked><span class="color-dot color-tanker"></span> Tanker</label>
        <span class="filter-count" id="count-tanker">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-passenger" checked><span class="color-dot color-passenger"></span> Passenger</label>
        <span class="filter-count" id="count-passenger">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-fishing" checked><span class="color-dot color-fishing"></span> Fishing</label>
        <span class="filter-count" id="count-fishing">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-military" checked><span class="color-dot color-military"></span> Military</label>
        <span class="filter-count" id="count-military">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-tug" checked><span class="color-dot color-tug"></span> Tug</label>
        <span class="filter-count" id="count-tug">0</span>
    </div>
    <div class="filter-item">
        <label><input type="checkbox" id="filter-other"><span class="color-dot color-other"></span> Other</label>
        <span class="filter-count" id="count-other">0</span>
    </div>
    <div id="shipStats">
        <div>Total: <span id="total-ships">0</span> vessels</div>
        <div>Updated: <span id="last-update">--:--:--</span> UTC</div>
    </div>
</div>
```

- [ ] **Step 3: Replace JavaScript section**

Replace the entire `<script>` section (lines 305-533) with:

```javascript
<script>
    // Opt out of Cesium Ion
    Cesium.Ion.defaultAccessToken = '';

    // Initialize Cesium Viewer
    const viewer = new Cesium.Viewer('cesiumContainer', {
        animation: true,
        timeline: true,
        infoBox: true,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({
            url: 'https://a.tile.openstreetmap.org/'
        }))
    });

    // Set 24-hour clock replay
    const start = Cesium.JulianDate.fromDate(new Date("2023-10-24T00:00:00Z"));
    const stop = Cesium.JulianDate.fromDate(new Date("2023-10-25T00:00:00Z"));
    viewer.clock.startTime = start;
    viewer.clock.stopTime = stop;
    viewer.clock.currentTime = start;
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.multiplier = 3600;
    viewer.timeline.zoomTo(start, stop);

    // Default camera view
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(45.0, 30.0, 4000000.0)
    });

    // Update header clock
    function updateClock() {
        const now = new Date();
        document.getElementById('stat-time').textContent = now.toISOString().substring(11, 19) + " Z";
    }
    setInterval(updateClock, 1000);
    updateClock();

    // Ship type colors
    const SHIP_COLORS = {
        cargo: Cesium.Color.fromCssColorString('#10b981'),
        tanker: Cesium.Color.fromCssColorString('#f97316'),
        passenger: Cesium.Color.fromCssColorString('#3b82f6'),
        fishing: Cesium.Color.fromCssColorString('#eab308'),
        military: Cesium.Color.fromCssColorString('#ef4444'),
        tug: Cesium.Color.fromCssColorString('#a855f7'),
        other: Cesium.Color.fromCssColorString('#6b7280')
    };

    // Ship data sources (one per type)
    const shipDataSources = {};
    const SHIP_TYPES = ['cargo', 'tanker', 'passenger', 'fishing', 'military', 'tug', 'other'];

    // Initialize data sources
    SHIP_TYPES.forEach(async (type) => {
        const ds = new Cesium.CustomDataSource(`Ships - ${type}`);
        shipDataSources[type] = ds;
        await viewer.dataSources.add(ds);
    });

    // Filter visibility handlers
    SHIP_TYPES.forEach(type => {
        const checkbox = document.getElementById(`filter-${type}`);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                if (shipDataSources[type]) {
                    shipDataSources[type].show = checkbox.checked;
                }
            });
        }
    });

    // Update ships on map
    function updateShipsLayer(ships) {
        // Group ships by type
        const byType = {};
        SHIP_TYPES.forEach(t => byType[t] = []);

        ships.forEach(ship => {
            const type = ship.ship_type || 'other';
            if (byType[type]) {
                byType[type].push(ship);
            } else {
                byType['other'].push(ship);
            }
        });

        // Update each data source
        SHIP_TYPES.forEach(type => {
            const ds = shipDataSources[type];
            if (!ds) return;

            const typeShips = byType[type];
            const existingIds = new Set();

            typeShips.forEach(ship => {
                existingIds.add(ship.mmsi);
                let entity = ds.entities.getById(ship.mmsi);
                const position = Cesium.Cartesian3.fromDegrees(ship.lng, ship.lat);

                const desc = `
                    <table class="cesium-infoBox-defaultTable">
                        <tbody>
                            <tr><th>Name</th><td>${ship.name}</td></tr>
                            <tr><th>MMSI</th><td>${ship.mmsi}</td></tr>
                            <tr><th>Type</th><td>${ship.ship_type}</td></tr>
                            <tr><th>Speed</th><td>${ship.speed} knots</td></tr>
                            <tr><th>Heading</th><td>${ship.heading}°</td></tr>
                        </tbody>
                    </table>
                `;

                if (!entity) {
                    ds.entities.add({
                        id: ship.mmsi,
                        name: ship.name,
                        description: desc,
                        position: position,
                        point: {
                            pixelSize: 6,
                            color: SHIP_COLORS[type],
                            outlineColor: Cesium.Color.WHITE,
                            outlineWidth: 1
                        }
                    });
                } else {
                    entity.position = position;
                    entity.description = desc;
                }
            });

            // Remove ships no longer in data
            ds.entities.values.forEach(entity => {
                if (!existingIds.has(entity.id)) {
                    ds.entities.remove(entity);
                }
            });

            // Update count
            const countEl = document.getElementById(`count-${type}`);
            if (countEl) countEl.textContent = typeShips.length.toLocaleString();
        });
    }

    // Fetch live ship data
    async function fetchLiveData() {
        try {
            const res = await fetch('/api/live-data');
            const data = await res.json();

            updateShipsLayer(data.ships || []);

            // Update stats
            document.getElementById('total-ships').textContent = (data.ship_count || 0).toLocaleString();
            document.getElementById('stat-assets').textContent = data.ship_count || 0;

            if (data.last_updated) {
                const updated = new Date(data.last_updated * 1000);
                document.getElementById('last-update').textContent = updated.toISOString().substring(11, 19);
            }

        } catch (error) {
            console.error("Error fetching live data:", error);
        }
    }

    // Existing data fetch function (events, trajectories, etc.)
    async function fetchData() {
        document.getElementById('loading').style.display = 'flex';
        try {
            // Load Restricted Areas
            const restrictedAreas = await Cesium.GeoJsonDataSource.load('/api/v1/restricted-areas', {
                stroke: Cesium.Color.RED,
                fill: Cesium.Color.RED.withAlpha(0.3),
                strokeWidth: 3
            });
            await viewer.dataSources.add(restrictedAreas);

            // Load OSINT Events
            const eventsResponse = await fetch('/api/v1/events');
            const eventsJson = await eventsResponse.json();

            const feedContainer = document.getElementById('eventFeed');
            const features = eventsJson.features || [];
            document.getElementById('stat-events').textContent = features.length;

            if (features.length > 0) {
                feedContainer.innerHTML = '';
                features.sort((a, b) => new Date(b.properties.event_time) - new Date(a.properties.event_time));

                features.forEach(feature => {
                    const props = feature.properties;
                    const coords = feature.geometry.coordinates;
                    const timeStr = new Date(props.event_time).toISOString().substring(11, 19) + "Z";
                    let icon = props.event_type === "explosion" ? "fa-burst" : "fa-triangle-exclamation";

                    const card = document.createElement('div');
                    card.className = `feed-card ${props.event_type}`;
                    card.innerHTML = `
                        <div class="feed-meta">
                            <span><i class="fa-solid fa-clock"></i> ${timeStr}</span>
                            <span>CONF: ${props.confidence}%</span>
                        </div>
                        <h3 class="feed-title">
                            <i class="fa-solid ${icon}"></i> ${props.event_type.toUpperCase()}
                        </h3>
                        <div style="color: var(--text-dim); font-size: 0.75rem; margin-top: 5px; font-family: monospace;">
                            LAT: ${coords[1].toFixed(4)} | LON: ${coords[0].toFixed(4)}
                        </div>
                    `;
                    card.addEventListener('click', () => {
                        viewer.camera.flyTo({
                            destination: Cesium.Cartesian3.fromDegrees(coords[0], coords[1], 150000.0),
                            duration: 1.5
                        });
                    });
                    feedContainer.appendChild(card);
                });
            }

            const eventsSrc = await Cesium.GeoJsonDataSource.load(eventsJson, {
                markerSymbol: 'cross',
                markerColor: Cesium.Color.fromCssColorString('#38bdf8'),
                markerSize: 40
            });
            await viewer.dataSources.add(eventsSrc);

            // Load Trajectories
            const trajectories = await Cesium.CzmlDataSource.load('/api/v1/trajectories');
            await viewer.dataSources.add(trajectories);

            if (eventsSrc.entities.values.length > 0) {
                viewer.flyTo(eventsSrc);
            }

            // Start live data polling
            fetchLiveData();
            setInterval(fetchLiveData, 60000);

        } catch (error) {
            console.error("Error fetching map data:", error);
            document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> SYSTEM ERROR';
        } finally {
            if (document.getElementById('loading').innerHTML.includes('INITIALIZING')) {
                document.getElementById('loading').style.display = 'none';
            }
        }
    }

    fetchData();
</script>
```

- [ ] **Step 4: Test frontend**

Run: `cd /home/yhlee/4dwar && python -m backend.main`
Open: `http://localhost:8001`
Expected: Ship filter panel visible, ships appear on map after ~60s

---

## Chunk 4: Testing & Verification

### Task 10: End-to-End Verification

- [ ] **Step 1: Verify directory structure**

Run: `find /home/yhlee/4dwar -type f -name "*.py" -o -name "*.js" | grep -E "(backend|static)" | head -20`

Expected:
```
/home/yhlee/4dwar/backend/ais_proxy.js
/home/yhlee/4dwar/backend/main.py
/home/yhlee/4dwar/backend/services/__init__.py
/home/yhlee/4dwar/backend/services/ais_stream.py
/home/yhlee/4dwar/backend/services/data_fetcher.py
/home/yhlee/4dwar/static/index.html
```

- [ ] **Step 2: Test AIS proxy standalone**

Run: `cd /home/yhlee/4dwar && timeout 10 bash -c 'AIS_API_KEY=$(grep AIS_API_KEY .env | cut -d= -f2) node backend/ais_proxy.js' 2>&1 | head -5`

Expected: Shows connection message and JSON data

- [ ] **Step 3: Test server startup**

Run: `cd /home/yhlee/4dwar && timeout 15 python -m backend.main 2>&1 | head -30`

Expected:
- "Database connection pool established"
- "AIS stream started"
- "Data fetcher started"

- [ ] **Step 4: Test API endpoints**

Run: `curl -s http://localhost:8001/api/live-data | head -100`

Expected: JSON with ships array

- [ ] **Step 5: Test GeoJSON endpoint**

Run: `curl -s http://localhost:8001/api/ships | head -50`

Expected: GeoJSON FeatureCollection

---

### Task 11: Cleanup

- [ ] **Step 1: Remove backup file**

```bash
rm -f /home/yhlee/4dwar/main.py.bak
```

- [ ] **Step 2: Remove test files (optional)**

```bash
rm -f /home/yhlee/4dwar/test_ws.js /home/yhlee/4dwar/test_ws2.js
```

---

## Summary

After completing all tasks:

1. **Backend**: `backend/` directory with AIS streaming, caching, and API
2. **Frontend**: Updated `static/index.html` with ship filters and 60s polling
3. **Data Flow**: aisstream.io → Node.js → Python → FastAPI → Cesium

Start server: `python -m backend.main`
Access: `http://localhost:8001`

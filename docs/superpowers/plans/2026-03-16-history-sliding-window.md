# History 슬라이딩 윈도우 리팩토링 구현 계획

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** History 모드를 1시간 슬라이딩 윈도우 방식으로 리팩토링하여 부드러운 재생 + 타임라인 드래그를 모두 지원하고, ship_type "unknown" 문제를 수정한다.

**Architecture:** 백엔드 쿼리를 활동량 기반 정렬로 변경하고, history_writer에 ship_type 일괄 업데이트 기능을 추가한다. 프론트엔드는 전체 범위 대신 ±30분 윈도우 단위로 데이터를 요청하며, 재생 중 윈도우 경계 도달 시 자동 프리페치한다.

**Tech Stack:** Python/FastAPI, PostgreSQL/PostGIS, asyncpg, vanilla JS + CesiumJS

**Spec:** `docs/superpowers/specs/2026-03-16-history-sliding-window-design.md`

---

## File Structure

```
backend/
├── routers/
│   └── history.py              # MODIFY: 쿼리 정렬/제한 변경, 기본값 조정
├── services/
│   ├── ais_stream.py           # MODIFY: ShipStaticData 시 DB update 호출 추가
│   └── history_writer.py       # MODIFY: update_ship_type() 함수 추가
static/
└── index.html                  # MODIFY: 슬라이딩 윈도우, 로딩 UX, 프리페치
```

---

## Chunk 1: 백엔드 — 쿼리 개선 + ship_type 수정

### Task 1: history.py 쿼리 정렬 및 제한 변경

**Files:**
- Modify: `backend/routers/history.py:180-231`

- [ ] **Step 1: `get_bulk_trajectories` 파라미터 기본값 변경**

`limit_per_ship` 기본값을 20 → 60으로, `max_ships` 파라미터를 추가한다.

```python
# backend/routers/history.py:180-184 변경
@router.get("/trajectories")
async def get_bulk_trajectories(
    start: datetime = Query(..., description="Start time (ISO 8601)"),
    end: datetime = Query(..., description="End time (ISO 8601)"),
    limit_per_ship: int = Query(default=60, description="Max points per ship"),
    max_ships: int = Query(default=500, ge=1, le=2000, description="Max number of ships to return")
):
```

- [ ] **Step 2: SQL 쿼리를 활동량 기반 정렬로 변경**

`ship_ids` CTE에서 `ORDER BY object_id LIMIT 200`을 `ORDER BY point_count DESC LIMIT $4`로 변경한다.

```python
    # backend/routers/history.py:202-231 전체 교체
    query = """
        WITH ship_activity AS (
            SELECT object_id, COUNT(*) as point_count
            FROM trajectories
            WHERE object_type = 'ship'
              AND record_time BETWEEN $1 AND $2
            GROUP BY object_id
            HAVING COUNT(*) >= 2
            ORDER BY point_count DESC
            LIMIT $4
        ),
        ranked AS (
            SELECT
                t.object_id as mmsi,
                ST_Y(t.geom::geometry) as lat,
                ST_X(t.geom::geometry) as lng,
                t.velocity as sog,
                t.heading,
                t.record_time,
                t.ship_type,
                ROW_NUMBER() OVER (PARTITION BY t.object_id ORDER BY t.record_time ASC) as rn,
                COUNT(*) OVER (PARTITION BY t.object_id) as total_points
            FROM trajectories t
            INNER JOIN ship_activity s ON t.object_id = s.object_id
            WHERE t.object_type = 'ship'
              AND t.record_time BETWEEN $1 AND $2
        )
        SELECT mmsi, lat, lng, sog, heading, record_time, ship_type
        FROM ranked
        WHERE rn <= $3 OR rn % GREATEST(1, total_points / $3) = 0
        ORDER BY mmsi, record_time ASC
    """
```

- [ ] **Step 3: fetch 호출에 `max_ships` 파라미터 추가**

```python
            rows = await conn.fetch(query, start, end, limit_per_ship, max_ships)
```

- [ ] **Step 4: 서버 기동 후 API 테스트**

Run: `curl -s "http://localhost:8001/api/v1/history/trajectories?start=2026-03-16T01:00:00Z&end=2026-03-16T02:00:00Z&limit_per_ship=60&max_ships=500" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Ships: {len(d[\"ships\"])}')" `

Expected: Ships: 200~500 (1시간 윈도우에 활동 중인 선박 수에 따라)

- [ ] **Step 5: Commit**

```bash
git add backend/routers/history.py
git commit -m "fix: improve history trajectories query — activity-based ranking, configurable limits"
```

---

### Task 2: history_writer.py에 ship_type 일괄 업데이트 함수 추가

**Files:**
- Modify: `backend/services/history_writer.py`

- [ ] **Step 1: `update_ship_type` 함수 추가**

파일 끝(`record_position` 함수 뒤)에 추가한다.

```python
# backend/services/history_writer.py 파일 끝에 추가

def update_ship_type(mmsi: int, ship_type: str) -> None:
    """
    ShipStaticData 도착 시 해당 MMSI의 'unknown' 레코드를 일괄 업데이트.
    메인 이벤트 루프에서 비동기 DB 업데이트를 스케줄링한다.
    """
    if not _db_pool or not _main_loop or not _running:
        return
    if not ship_type or ship_type == "unknown":
        return

    mmsi_str = str(mmsi)

    async def _do_update():
        try:
            async with _db_pool.acquire() as conn:
                result = await conn.execute(
                    """
                    UPDATE trajectories
                    SET ship_type = $1
                    WHERE object_id = $2
                      AND object_type = 'ship'
                      AND (ship_type IS NULL OR ship_type = 'unknown')
                      AND record_time > NOW() - INTERVAL '1 hour'
                    """,
                    ship_type, mmsi_str
                )
                if result and result != "UPDATE 0":
                    logger.debug(f"Updated ship_type for MMSI {mmsi_str}: {result}")
        except Exception as e:
            logger.warning(f"Failed to update ship_type for MMSI {mmsi_str}: {e}")

    try:
        _main_loop.call_soon_threadsafe(
            lambda: asyncio.create_task(_do_update())
        )
    except RuntimeError:
        pass
```

- [ ] **Step 2: Syntax 검증**

Run: `python3 -m py_compile backend/services/history_writer.py`
Expected: 출력 없음 (성공)

- [ ] **Step 3: Commit**

```bash
git add backend/services/history_writer.py
git commit -m "feat: add update_ship_type to backfill unknown ship types"
```

---

### Task 3: ais_stream.py에서 ShipStaticData 시 update_ship_type 호출

**Files:**
- Modify: `backend/services/ais_stream.py:445-448`

- [ ] **Step 1: ShipStaticData 처리 블록에 update_ship_type 호출 추가**

`ais_stream.py`의 ShipStaticData 처리 블록에서, `vessel["type"]` 설정 직후에 호출을 추가한다.

```python
                    # backend/services/ais_stream.py:445 다음 줄에 추가
                    # 기존 코드:
                    #     vessel["type"] = classify_vessel(ais_type, mmsi)
                    #     vessel["_updated"] = time.time()
                    #     cur_lat = vessel.get("lat")
                    #     cur_lng = vessel.get("lng")

                    # 아래 줄을 vessel["_updated"] = time.time() 다음에 추가:
                    # Backfill DB records that were saved as "unknown" before this static data arrived
                    classified_type = classify_vessel(ais_type, mmsi)
                    if classified_type and classified_type not in ("unknown", "other"):
                        history_writer.update_ship_type(mmsi, classified_type)
```

구체적으로, `ais_stream.py:445`의 기존 코드:

```python
                        vessel["type"] = classify_vessel(ais_type, mmsi)
                        vessel["_updated"] = time.time()
                        cur_lat = vessel.get("lat")
                        cur_lng = vessel.get("lng")
```

를 아래로 교체:

```python
                        vessel["type"] = classify_vessel(ais_type, mmsi)
                        vessel["_updated"] = time.time()
                        cur_lat = vessel.get("lat")
                        cur_lng = vessel.get("lng")

                    # Backfill unknown ship_type in DB for this MMSI
                    classified_type = vessel.get("type", "unknown")
                    if classified_type and classified_type not in ("unknown", "other"):
                        history_writer.update_ship_type(mmsi, classified_type)
```

- [ ] **Step 2: Syntax 검증**

Run: `python3 -m py_compile backend/services/ais_stream.py`
Expected: 출력 없음 (성공)

- [ ] **Step 3: 서버 기동 후 로그 확인**

서버 시작 후 1분 대기. 로그에서 `Updated ship_type for MMSI` 메시지가 간헐적으로 보이면 정상.

- [ ] **Step 4: Commit**

```bash
git add backend/services/ais_stream.py
git commit -m "fix: backfill unknown ship_type when ShipStaticData arrives"
```

---

## Chunk 2: 프론트엔드 — 슬라이딩 윈도우 + 로딩 UX

### Task 4: 슬라이딩 윈도우 상태 변수 및 loadHistoryWindow 함수

**Files:**
- Modify: `static/index.html:696-827`

- [ ] **Step 1: 상태 변수 추가 및 기존 변수 정리**

`static/index.html`의 Time Travel Mode 섹션 시작 부분(line 696-701)을 아래로 교체:

```javascript
        // ── Time Travel Mode ───────────────────────────────────────────────────
        let timeMode = 'live'; // 'live' | 'history'
        let liveClockIntervalId = null;
        let historyRange = { min: null, max: null };
        let lastHistoryFetchTime = 0;
        let cachedHistoryShips = []; // Cache for re-rendering on camera move

        // Sliding window state
        const WINDOW_HALF_MS = 30 * 60 * 1000; // ±30 minutes = 1 hour window
        let currentWindowCenter = null; // Date object: center of current window
        let currentWindowStart = null;  // Date object
        let currentWindowEnd = null;    // Date object
        let isLoadingWindow = false;    // Prevents concurrent loads
        let historyInterpolationLoaded = false;
```

- [ ] **Step 2: `loadHistoryWithInterpolation` 함수를 `loadHistoryWindow`로 교체**

기존 `loadHistoryWithInterpolation` 함수(line 739-827)를 아래로 완전히 교체:

```javascript
        async function loadHistoryWindow(centerDate) {
            if (isLoadingWindow) return;
            isLoadingWindow = true;

            // Show loading indicator
            document.getElementById('loading').style.display = 'flex';
            document.getElementById('loading').innerHTML = '<i class="fa-solid fa-clock-rotate-left fa-spin"></i> LOADING HISTORY...';

            const windowStart = new Date(centerDate.getTime() - WINDOW_HALF_MS);
            const windowEnd = new Date(centerDate.getTime() + WINDOW_HALF_MS);
            const startIso = windowStart.toISOString();
            const endIso = windowEnd.toISOString();

            console.log('[HISTORY] Loading window:', startIso, 'to', endIso);

            try {
                const res = await fetchWithTimeout(
                    `/api/v1/history/trajectories?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit_per_ship=60&max_ships=500`,
                    15000
                );
                if (!res.ok) {
                    console.error('[HISTORY] Trajectory API error:', res.status);
                    document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> LOAD ERROR';
                    setTimeout(() => {
                        document.getElementById('loading').style.display = 'none';
                    }, 2000);
                    isLoadingWindow = false;
                    return;
                }

                const data = await res.json();
                const ships = data.ships || {};
                const shipCount = Object.keys(ships).length;
                console.log('[HISTORY] Loaded trajectories for', shipCount, 'ships');

                // Clear existing ship entities
                SHIP_TYPES.forEach(type => {
                    if (shipDataSources[type]) {
                        shipDataSources[type].entities.removeAll();
                    }
                });

                // Create entities with SampledPositionProperty for each ship
                for (const [mmsi, shipData] of Object.entries(ships)) {
                    if (shipData.points.length < 2) continue;

                    const type = shipData.type || 'other';
                    const ds = shipDataSources[type] || shipDataSources['other'];
                    if (!ds) continue;

                    const positionProperty = new Cesium.SampledPositionProperty();
                    positionProperty.setInterpolationOptions({
                        interpolationDegree: 1,
                        interpolationAlgorithm: Cesium.LinearApproximation
                    });

                    const headingProperty = new Cesium.SampledProperty(Number);

                    shipData.points.forEach(pt => {
                        const time = Cesium.JulianDate.fromIso8601(pt.time);
                        const position = Cesium.Cartesian3.fromDegrees(pt.lng, pt.lat);
                        positionProperty.addSample(time, position);
                        headingProperty.addSample(time, pt.heading || 0);
                    });

                    ds.entities.add({
                        id: mmsi,
                        name: shipData.name || 'UNKNOWN',
                        description: `
                            <table class="cesium-infoBox-defaultTable">
                                <tbody>
                                    <tr><th>Name</th><td>${shipData.name}</td></tr>
                                    <tr><th>MMSI</th><td>${mmsi}</td></tr>
                                    <tr><th>Type</th><td>${shipData.type}</td></tr>
                                    <tr><th>Country</th><td>${shipData.country}</td></tr>
                                </tbody>
                            </table>
                        `,
                        position: positionProperty,
                        billboard: {
                            image: getShipIcon(SHIP_COLORS[type] || SHIP_COLORS['other']),
                            width: 14,
                            height: 16,
                            rotation: new Cesium.CallbackProperty(() => {
                                const heading = headingProperty.getValue(viewer.clock.currentTime);
                                return Cesium.Math.toRadians(-(heading || 0));
                            }, false)
                        }
                    });
                }

                // Update window state
                currentWindowCenter = centerDate;
                currentWindowStart = windowStart;
                currentWindowEnd = windowEnd;
                historyInterpolationLoaded = true;

                // Update UI stats
                document.getElementById('total-ships').textContent = shipCount.toLocaleString();
                document.getElementById('stat-assets').textContent = shipCount;

                console.log('[HISTORY] Window loaded:', shipCount, 'ships');

            } catch (err) {
                console.error('[HISTORY] Error loading window:', err);
                document.getElementById('loading').innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> LOAD ERROR';
                setTimeout(() => {
                    document.getElementById('loading').style.display = 'none';
                    setTimeMode('live');
                }, 2000);
            } finally {
                // Hide loading indicator
                document.getElementById('loading').style.display = 'none';
                isLoadingWindow = false;
            }
        }
```

- [ ] **Step 3: Verify no syntax errors**

브라우저 DevTools Console에서 에러 없는지 확인.

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "feat: replace full-range history load with sliding window (loadHistoryWindow)"
```

---

### Task 5: setTimeMode 함수를 슬라이딩 윈도우 방식으로 변경

**Files:**
- Modify: `static/index.html:977-1073`

- [ ] **Step 1: `setTimeMode('history')` 분기 교체**

기존 `setTimeMode` 함수의 `else if (mode === 'history')` 블록(line 1017-1073)을 아래로 교체:

```javascript
            } else if (mode === 'history') {
                timeMode = 'history';

                // Update UI
                btnLive.classList.remove('active');
                btnHistory.classList.add('active');
                indicator.classList.add('visible');

                // Stop live clock sync
                if (liveClockIntervalId) {
                    clearInterval(liveClockIntervalId);
                    liveClockIntervalId = null;
                }

                // Clear existing ship entities (from LIVE mode)
                SHIP_TYPES.forEach(type => {
                    if (shipDataSources[type]) {
                        shipDataSources[type].entities.removeAll();
                    }
                });

                // Load history range and setup timeline
                const rangeLoaded = await loadHistoryRange();

                if (rangeLoaded) {
                    // Set initial time to most recent data point
                    const initialCenter = new Date(historyRange.max);

                    // Load 1-hour window around initial time
                    await loadHistoryWindow(initialCenter);

                    // Enable animation for smooth playback
                    viewer.clock.shouldAnimate = true;
                    viewer.clock.multiplier = 60; // 60x speed (1 min/sec)
                } else {
                    // No history data available — return to LIVE after brief message
                    document.getElementById('historyTimeDisplay').textContent = 'No history data — returning to LIVE';
                    setTimeout(() => setTimeMode('live'), 2000);
                }

                console.log('Switched to HISTORY mode with sliding window');
            }
```

- [ ] **Step 2: Commit**

```bash
git add static/index.html
git commit -m "feat: history mode uses sliding window on entry"
```

---

### Task 6: onTick 리스너에 윈도우 경계 감지 + 프리페치 추가

**Files:**
- Modify: `static/index.html:1076-1105`

- [ ] **Step 1: onTick 리스너를 윈도우 경계 감지 로직으로 교체**

기존 onTick 리스너 + historyChecker 코드(line 1076-1105)를 아래로 교체:

```javascript
        // Setup clock tick listener for history mode — window boundary detection + prefetch
        viewer.clock.onTick.addEventListener((clock) => {
            if (timeMode !== 'history') return;

            // Update time display
            const jsDate = Cesium.JulianDate.toDate(clock.currentTime);
            const displayTime = jsDate.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
            document.getElementById('historyTimeDisplay').textContent = displayTime;
            document.getElementById('last-update').textContent = displayTime.substring(11, 19);

            // Window boundary detection: reload when current time exceeds 70% of window
            if (!currentWindowStart || !currentWindowEnd || isLoadingWindow) return;

            const windowDuration = currentWindowEnd.getTime() - currentWindowStart.getTime();
            const elapsed = jsDate.getTime() - currentWindowStart.getTime();
            const progress = elapsed / windowDuration;

            // If past 70% of window (forward) or before 10% (backward via scrub), load new window
            if (progress > 0.7 || progress < -0.1) {
                console.log('[HISTORY] Window boundary reached, progress:', (progress * 100).toFixed(0) + '%');
                loadHistoryWindow(jsDate);
            }
        });

        // Timeline scrub: detect large time jumps via debounced check
        let lastCheckedTime = 0;
        const debouncedWindowJump = debounce((julianDate) => {
            if (timeMode !== 'history' || isLoadingWindow) return;

            const jsDate = Cesium.JulianDate.toDate(julianDate);

            // Check if jumped outside current window
            if (!currentWindowStart || !currentWindowEnd) {
                loadHistoryWindow(jsDate);
                return;
            }

            if (jsDate < currentWindowStart || jsDate > currentWindowEnd) {
                console.log('[HISTORY] Timeline jump detected, loading new window');
                loadHistoryWindow(jsDate);
            }
        }, 500);

        // Cesium timeline click/drag handler
        viewer.timeline.addEventListener('settime', () => {
            if (timeMode === 'history') {
                debouncedWindowJump(viewer.clock.currentTime);
            }
        });
```

- [ ] **Step 2: 기존 historyChecker 관련 코드 제거**

기존 `startHistoryChecker`, `stopHistoryChecker` 함수와 `historyCheckInterval` 변수, `debouncedLoadHistory` 변수를 삭제한다.

삭제할 코드:
```javascript
        // 삭제: const debouncedLoadHistory = debounce(loadHistoryData, 300);  (line ~941)

        // 삭제: let historyCheckInterval = null; ~ stopHistoryChecker() 함수 전체 (line ~1088-1105)
```

또한 `setTimeMode('live')` 블록에서 `stopHistoryChecker()` 호출(line ~992)도 삭제한다.

- [ ] **Step 3: `loadHistoryData` 함수 제거**

`loadHistoryData` 함수(line ~829-872)는 더 이상 사용되지 않으므로 삭제한다.

- [ ] **Step 4: 브라우저에서 동작 확인**

1. HISTORY 모드 진입 → 로딩 인디케이터 표시 → 선박 표시
2. 재생 시 윈도우 70% 지점에서 자동 리로드
3. 타임라인 클릭으로 다른 시간대 점프 → 로딩 후 새 데이터 표시
4. LIVE 모드 복귀 → 정상 동작

- [ ] **Step 5: Commit**

```bash
git add static/index.html
git commit -m "feat: sliding window auto-reload on playback + timeline jump detection"
```

---

## Chunk 3: 정리 및 검증

### Task 7: 불필요한 코드 정리

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: 사용하지 않는 변수/함수 제거 확인**

아래 항목이 모두 삭제되었는지 확인:
- `loadHistoryWithInterpolation` 함수 (loadHistoryWindow로 교체됨)
- `loadHistoryData` 함수 (더 이상 불필요)
- `debouncedLoadHistory` 변수
- `startHistoryChecker` / `stopHistoryChecker` 함수
- `historyCheckInterval` 변수

`setTimeMode('live')` 블록에서 `stopHistoryChecker()` 호출이 있으면 삭제한다.

- [ ] **Step 2: `setTimeMode('live')` 블록에서 윈도우 상태 초기화 추가**

`setTimeMode('live')` 블록의 기존 cleanup 코드(line ~1007-1013) 끝에 추가:

```javascript
                // Reset sliding window state
                currentWindowCenter = null;
                currentWindowStart = null;
                currentWindowEnd = null;
                historyInterpolationLoaded = false;
```

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "chore: clean up unused history functions, reset window state on LIVE switch"
```

---

### Task 8: 통합 검증

- [ ] **Step 1: 서버 기동 확인**

Run: `cd /home/yhlee/4dwar && python -m backend.main`
Expected: 에러 없이 시작, "History writer initialized" 로그

- [ ] **Step 2: API 엔드포인트 확인**

1시간 윈도우 쿼리 테스트:
```bash
curl -s "http://localhost:8001/api/v1/history/trajectories?start=2026-03-16T01:00:00Z&end=2026-03-16T02:00:00Z" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ships = d.get('ships', {})
print(f'Ships: {len(ships)}')
if ships:
    first = list(ships.values())[0]
    print(f'First ship points: {len(first[\"points\"])}')
    print(f'First ship type: {first[\"type\"]}')
"
```
Expected: Ships 200~500, points ~60, type이 "unknown"이 아닌 경우가 다수

- [ ] **Step 3: 프론트엔드 동작 확인**

브라우저에서 `http://localhost:8001` 접속 후:
1. LIVE 모드 정상 동작 확인
2. HISTORY 클릭 → 로딩 인디케이터 → 선박 표시
3. 재생 버튼으로 애니메이션 확인 (선박이 부드럽게 이동)
4. 타임라인 드래그로 다른 시간대 점프 → 로딩 → 새 데이터
5. LIVE 복귀 → 기존 실시간 데이터 표시
6. Network 탭: 불필요한 반복 요청 없는지 확인

- [ ] **Step 4: ship_type 확인**

1분 이상 서버 가동 후 DB 확인:
```bash
python3 -c "
import asyncio, asyncpg
async def check():
    pool = await asyncpg.create_pool(user='db_user', password='db_password', database='osint_4d', host='127.0.0.1', port=5432)
    async with pool.acquire() as conn:
        rows = await conn.fetch('SELECT ship_type, COUNT(*) as cnt FROM trajectories WHERE object_type=\$1 AND record_time > NOW() - INTERVAL \'1 hour\' GROUP BY ship_type ORDER BY cnt DESC', 'ship')
        for r in rows:
            print(f'{r[\"ship_type\"]}: {r[\"cnt\"]}')
    await pool.close()
asyncio.run(check())
"
```
Expected: "unknown" 비율이 이전보다 감소

# AIS Stream Architecture Design

**Date:** 2026-03-10
**Status:** Approved

## Overview

AIS(선박자동식별시스템) 데이터를 실시간으로 수집하여 Cesium 3D 지도에 표시하는 아키텍처 설계.

## Requirements

| 항목 | 결정 |
|------|------|
| 지도 | Cesium 유지 (3D) |
| 선박 분류 | AIS Ship Type 기반 |
| 데이터 갱신 | 실시간 스트리밍 + 60초 API 폴링 |
| 해역 | 전 세계 |
| Stale 정리 | 15분 미갱신 시 삭제 |
| 캐시 | 5000 메시지당 디스크 저장 |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND                                         │
│  ┌──────────────┐    stdout    ┌─────────────────┐                          │
│  │ais_proxy.js │──────────────▶│ais_stream.py   │                          │
│  │(WebSocket)   │              │(분류/캐싱)      │                          │
│  └──────────────┘              └────────┬────────┘                          │
│         ▲                               │                                    │
│         │ wss://                        ▼                                    │
│  aisstream.io              ┌─────────────────────┐                          │
│                            │ data_fetcher.py     │                          │
│                            │ (60초마다 스냅샷)   │                          │
│                            └────────┬────────────┘                          │
│                                     ▼                                        │
│                            ┌─────────────────────┐      ┌─────────────────┐ │
│                            │ main.py (FastAPI)   │◀────▶│ PostgreSQL      │ │
│                            │ /api/live-data      │      │ (PostGIS)       │ │
│                            └────────┬────────────┘      └─────────────────┘ │
└─────────────────────────────────────┼───────────────────────────────────────┘
                                      │ HTTP (60초 polling)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│  ┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────┐   │
│  │ static/index.html│───▶│ Cesium Viewer       │◀───│ FilterPanel      │   │
│  │ (진입점)          │    │ (3D 지도 렌더링)    │    │ (레이어 필터)    │   │
│  └──────────────────┘    └─────────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
4dwar/
├── backend/
│   ├── ais_proxy.js           # WebSocket 클라이언트
│   ├── main.py                # FastAPI 서버 (기존 main.py 이동)
│   └── services/
│       ├── ais_stream.py      # AIS 데이터 처리/캐싱
│       └── data_fetcher.py    # 데이터 스냅샷 관리
├── static/
│   └── index.html             # Cesium 프론트엔드 (수정)
├── .env
└── requirements.txt
```

## Backend Components

### 1. `backend/ais_proxy.js`

WebSocket 클라이언트로 aisstream.io에 연결하여 AIS 메시지를 stdout으로 출력.

- 연결 끊김 시 5초 후 자동 재연결
- 전 세계 BoundingBox: `[[-90, -180], [90, 180]]`
- FilterMessageTypes: `["PositionReport"]`

### 2. `backend/services/ais_stream.py`

Node.js 프로세스의 stdout을 파싱하여 선박 데이터 관리.

```python
_vessels = {}        # {mmsi: {lat, lng, ship_type, name, speed, heading, _updated}}
_vessels_lock = threading.Lock()
```

**주요 함수:**
- `start_ais_stream()`: Node.js 프로세스 시작, stdout 파싱 스레드 시작
- `_parse_ais_message()`: JSON 파싱 → _vessels 업데이트
- `_classify_ship_type()`: AIS ShipType 코드 → 카테고리 매핑
- `_cleanup_stale()`: 15분 미갱신 선박 삭제 (60초마다 실행)
- `get_ais_vessels()`: 현재 _vessels 스냅샷 반환
- `_save_cache()`: 5000 메시지마다 디스크 저장
- `_load_cache()`: 시작 시 1시간 이내 캐시 복원

### 3. Ship Type Classification

| 카테고리 | ShipType 코드 | 색상 |
|----------|---------------|------|
| `cargo` | 70-79 | Green |
| `tanker` | 80-89 | Orange |
| `passenger` | 60-69 | Blue |
| `fishing` | 30 | Yellow |
| `military` | 35 | Red |
| `tug` | 31-32, 52 | Purple |
| `other` | 나머지 | Gray |

### 4. `backend/services/data_fetcher.py`

60초마다 `get_ais_vessels()` 호출하여 스냅샷 저장.

```python
latest_data = {
    'ships': [],           # get_ais_vessels() 결과
    'ships_by_type': {},   # 카테고리별 그룹화
    'last_updated': None
}
```

### 5. `backend/main.py` API

```python
@app.get("/api/live-data")
async def get_live_data():
    return {
        "ships": latest_data['ships'],
        "ships_by_type": latest_data['ships_by_type'],
        "ship_count": len(latest_data['ships']),
        "last_updated": latest_data['last_updated']
    }
```

## Frontend Changes

### 1. Data Fetching

기존 브라우저 직접 WebSocket 연결 제거, 60초 폴링으로 변경.

```javascript
setInterval(fetchLiveData, 60000);

async function fetchLiveData() {
    const res = await fetch('/api/live-data');
    const data = await res.json();
    updateShipsLayer(data.ships);
    updateStats(data.ship_count);
}
```

### 2. Ship Layers

Cesium CustomDataSource로 카테고리별 관리.

```javascript
const shipLayers = {
    cargo: new Cesium.CustomDataSource('Ships - Cargo'),
    tanker: new Cesium.CustomDataSource('Ships - Tanker'),
    passenger: new Cesium.CustomDataSource('Ships - Passenger'),
    fishing: new Cesium.CustomDataSource('Ships - Fishing'),
    military: new Cesium.CustomDataSource('Ships - Military'),
    tug: new Cesium.CustomDataSource('Ships - Tug'),
    other: new Cesium.CustomDataSource('Ships - Other')
};
```

### 3. Filter Panel UI

체크박스로 레이어 표시/숨김 토글, 카테고리별 선박 수 표시.

## Error Handling

| 상황 | 처리 방식 |
|------|----------|
| WebSocket 연결 끊김 | 5초 후 자동 재연결, 로그 기록 |
| Node.js 프로세스 종료 | Python에서 감지 후 재시작 |
| 잘못된 AIS 메시지 | 무시하고 계속 처리 (로그만) |
| API 호출 실패 | 프론트엔드에서 이전 데이터 유지, 재시도 |

## Cache

```
backend/
└── cache/
    └── ais_vessels.json    # 5000 메시지마다 저장
```

- 서버 재시작 시 1시간 이내 데이터 복원
- 1시간 초과 캐시는 무시

## Startup Sequence

```python
async def lifespan(app):
    # 1. DB 연결
    await init_db_pool()

    # 2. AIS 캐시 로드
    load_ais_cache()

    # 3. AIS 스트림 시작 (백그라운드)
    start_ais_stream()

    # 4. 데이터 페처 스케줄러 시작
    start_data_fetcher()

    yield

    # 정리
    stop_ais_stream()
    save_ais_cache()
    await close_db_pool()
```

## Dependencies

```txt
# requirements.txt (추가)
apscheduler>=3.10.0   # 60초 스케줄러
```

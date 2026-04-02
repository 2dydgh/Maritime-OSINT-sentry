# MSA Intelligent Platform

AIS 선박 추적, 위성 궤도 전파, 이상 징후 탐지, ML 기반 충돌 예측을 3D 전술 글로브 위에서 통합 운용하는 실시간 해양 상황인식(MSA) 플랫폼입니다.

![Main Interface](static/demo.gif)

## 시스템 개요

- **풀스택 지리공간 엔지니어링** — CesiumJS/Leaflet 프론트엔드, FastAPI 백엔드, PostGIS 공간 쿼리, WebSocket 실시간 파이프라인
- **ML 기반 충돌 위험 예측** — XGBoost 충돌 위험 모델 (14개 피처, 4단계 분류) 학습, 컨테이너화, REST API 서빙
- **다중 소스 데이터 퓨전** — AIS 라이브 스트림, SGP4 위성 궤도, Sentinel-2 위성 영상, GSHHG 해안선 데이터를 단일 작전 화면에 통합

## 로드맵

| 단계 | 상태 | 설명 |
|------|------|------|
| **감시 대시보드** | 완료 | 실시간 AIS 추적, 이상 징후 피드, 듀얼 맵 모드, 비전 모드 |
| **충돌 AI 모델** | 완료 | XGBoost 위험 예측 + 3단계 공간 전처리 필터 + 육지 차폐 |
| **디지털 트윈** | 계획 | 시뮬레이션 레이어 — 항로 예측, What-if 시나리오, 멀티센서 퓨전 (항공, 추가 해양 데이터) |

## 주요 기능

### 실시간 선박 추적 (AIS)
- **AisStream.io** 라이브 스트림 연동
- CesiumJS 전술 글로브와 고정밀 동기화
- 선박 상세 정보: MMSI, 선명, 선종, SOG, COG, 목적지
- **BillboardCollection** 기반 고성능 선박 렌더링

### 듀얼 맵 모드
- **3D Globe** (CesiumJS) — 지형 기반 전술 뷰, 지역 이동(fly-to)
- **2D Map** (Leaflet) — 경량 평면 지도, 리전 탭 내비게이션
- 선박/위성 상태 공유하며 모드 간 원활한 전환

### 위성 궤도 전파 (SGP4)
- 정보 관련 위성(군사, SAR, SIGINT) 실시간 궤도 계산
- 자동 페일오버 기반 TLE 수집 로직
- SGP4 고정밀 전파를 통한 위치, 속도, 방위 계산

### 실시간 이상 탐지 (라이브 피드)
- **과속 경보**: 운용 한계 초과 선박 자동 탐지 (화물/유조선 25kt+)
- **신호 소실 감시**: "다크" 선박 및 AIS 신호 두절 실시간 식별
- **목적지 변경**: 항해 중 목적지 변경 즉시 알림
- **인터랙티브 피드**: 클릭 시 해당 선박으로 자동 이동 및 상세 정보 표시

### 충돌 위험 분석 (이중 엔진)
- **거리 기반 분석**: 공간 그리드 필터링(5nm 반경)을 통한 TCPA/DCPA 계산. 위험(DCPA < 0.5nm) 및 경고(DCPA < 1.0nm) 분류.
- **ML 모델 분석**: da10-service를 통한 XGBoost 기반 충돌 위험도 예측 (0~3 등급). COG 차이, 접근 신호, 베어링 분석 등 14개 입력 파라미터 활용.
- **3단계 전처리 필터 파이프라인**:
    1. **Range rate 검증**: 거리가 줄어들고 있는 쌍만 통과 (발산 선박 즉시 제거)
    2. **COG 투영선 수렴 검사**: COG 방향 벡터를 직선으로 투영하여, 교차점이 양쪽 전방에 있는 경우(crossing/head-on) 또는 평행한 경우(overtaking)만 통과
    3. **베어링 검증**: head-on/crossing은 양쪽 모두 상대를 향해야 하고(90° 이내), overtaking은 한 척만 향하면 통과
- **육지 차폐 필터**: GSHHG 해안선 데이터를 활용하여 육지로 분리된 선박 쌍 자동 제외
- **인터랙티브 시각화**:
  - COG 예상 경로선 (점선) — 10분간 예상 항로 표시
  - CPA (최근접점) 마커 — 실시간 DCPA/TCPA 라벨
  - CPA 위험 영역 원 (펄스 애니메이션) — DCPA 비례 반경
  - 위험도 색상 코딩: 위험(빨강), 경고(주황), 주의(노랑), 안전(초록)

### 선박 근접 패널
- 선택 선박 기준 주변 선박 실시간 추적 및 거리 측정
- 근접 선박 간 연결선 렌더링
- ML 위험도 보강 및 거리 심각도 표시

### Sentinel-2 위성 영상
- 우클릭 컨텍스트 메뉴를 통한 Microsoft Planetary Computer 고해상도 위성 영상 검색
- 즉시 썸네일 미리보기 및 메타데이터 조회

### 비전 모드
- **Normal**, **Night Vision (NV)**, **FLIR Thermal**, **CRT** 디스플레이 모드
- 모드별 전체 UI 테마 적용

### HUD 및 모니터링 오버레이
- 선박/위성 수, 충돌 위험 배지가 포함된 HUD
- 데이터 지연 시간 표시 및 연결 상태 모니터링

### 제한 구역 및 군사 이벤트
- 제한 해역 GeoJSON API (PostGIS 기반)
- 군사/보안 이벤트 추적 (신뢰도, 시간 데이터 포함)

## 기술 스택

- **프론트엔드**: CesiumJS, Leaflet, Vanilla CSS, JavaScript (ES6+)
- **백엔드**: FastAPI (Python 3.12), Uvicorn
- **데이터베이스**: PostgreSQL + PostGIS
- **충돌 모델**: XGBoost (da10-service), GSHHG 해안선 shapefile (`shapely`, `pyshp`)
- **모니터링**: Prometheus, Grafana, Redis
- **핵심 라이브러리**: `sgp4`, `asyncpg`, `apscheduler`, `websockets`, `httpx`

## 시작하기

### 사전 요구사항
- Python 3.12+
- PostgreSQL + PostGIS
- AISStream.io API Key

### 환경 설정
루트 디렉토리에 `.env` 파일 생성:
```env
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=osint_4d
DB_HOST=127.0.0.1
DB_PORT=5432
AIS_API_KEY=your_aisstream_key
```

### 설치
```bash
pip install -r requirements.txt
```

### 실행
```bash
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

## 모니터링

모니터링 포함 전체 스택 실행:

```bash
cp .env.example .env  # 환경변수 설정 후 값 수정
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

| 서비스 | URL | 용도 |
|--------|-----|------|
| App | http://localhost:8001 | 해양 OSINT 대시보드 |
| Prometheus | http://localhost:9090 | 메트릭 수집 |
| Grafana | http://localhost:3001 | 모니터링 대시보드 (admin/admin) |
| Redis | localhost:6379 | 스트림 파이프라인 |

## 보안
API 키 및 데이터베이스 자격 증명은 `.gitignore`를 통해 보호됩니다. `.env` 파일은 절대 커밋하지 마세요.

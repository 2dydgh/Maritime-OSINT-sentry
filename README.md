# 🌊 Maritime OSINT Sentry

실시간 AIS 선박 추적, 위성 궤도 계산, 이상 징후 탐지, 충돌 위험 분석을 하나의 3D 글로브 위에서 운용하는 해양 감시 대시보드입니다.

![Main Interface](static/osint.gif)

## 🚀 주요 기능

### 📡 실시간 선박 추적 (AIS)
- **AisStream.io** 라이브 스트림 연동
- CesiumJS 전술 글로브와 고정밀 동기화
- 선박 상세 정보: MMSI, 선명, 선종, SOG, COG, 목적지

### 🛰️ 위성 궤도 전파 (SGP4)
- 정보 관련 위성(군사, SAR, SIGINT) 실시간 궤도 계산
- 자동 페일오버 기반의 TLE 수집 로직
- SGP4 고정밀 전파를 통한 위치, 속도, 방위 계산

### 🚨 자동 이상 탐지 (실시간 피드)
- **과속 경보**: 운용 한계 초과 선박 자동 탐지 (화물/유조선 25kt+)
- **신호 소실 감시**: "다크" 선박 및 신호 두절 실시간 식별
- **목적지 변경**: 항해 중 목적지 변경 즉시 알림
- **인터랙티브 피드**: 클릭 시 해당 선박으로 자동 이동 및 상세 정보 표시

### ⚠️ 충돌 위험 분석 (이중 엔진)
- **거리 기반 분석**: 공간 그리드 필터링(5nm 반경)을 통한 TCPA/DCPA 계산. 위험(DCPA < 0.5nm) 및 경고(DCPA < 1.0nm) 분류.
- **ML 모델 분석**: da10-service를 통한 XGBoost 기반 충돌 위험도 예측 (0~3 등급). COG 차이, 접근 신호, 베어링 분석 등 14개 입력 파라미터 활용.
- **충돌 후보 전처리 필터**: Range rate + 베어링 검증 — 분석 전에 이산(발산)하는 선박 쌍 제거. 최소 한 척이 상대방을 향해야 함 (90° 이내).
- **육지 차폐 필터**: GSHHG 해안선 데이터를 활용하여 육지로 분리된 선박 쌍 자동 제외.
- **인터랙티브 시각화**:
  - COG 예상 경로선 (점선) — 10분간 예상 항로 표시
  - CPA (최근접점) 마커 — 실시간 DCPA/TCPA 라벨
  - CPA 지점 위험 영역 원 (펄스 애니메이션) — DCPA 비례 반경
  - 위험도 색상 코딩: 위험(빨강), 경고(주황), 주의(노랑), 안전(초록)

### 🖼️ Sentinel-2 위성 영상 검색
- 우클릭 컨텍스트 메뉴를 통한 Microsoft Planetary Computer 고해상도 위성 영상 검색
- 즉시 썸네일 미리보기 및 메타데이터 조회

## 🛠️ 기술 스택

- **프론트엔드**: CesiumJS, Vanilla CSS (Glassmorphism), JavaScript (ES6+)
- **백엔드**: FastAPI (Python 3.12), Uvicorn
- **데이터베이스**: PostgreSQL + PostGIS (공간 정보)
- **충돌 모델**: XGBoost (da10-service), GSHHG 해안선 shapefile (`shapely`, `pyshp`)
- **핵심 라이브러리**: `sgp4` (궤도 계산), `asyncpg`, `apscheduler`, `websockets`, `httpx`

## 📦 시작하기

### 1. 사전 요구사항
- Python 3.12+
- PostgreSQL + PostGIS
- AISStream.io API Key

### 2. 환경 설정
루트 디렉토리에 `.env` 파일 생성:
```env
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=osint_4d
DB_HOST=127.0.0.1
DB_PORT=5432
AIS_API_KEY=your_aisstream_key
```

### 3. 설치
```bash
pip install -r requirements.txt
```

### 4. 대시보드 실행
```bash
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

## 📊 모니터링

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

## 🔒 보안 안내
본 저장소는 `.gitignore`를 통해 API 키 및 데이터베이스 자격 증명 유출을 방지합니다. `.env` 파일은 절대 커밋하지 마세요.

---
*해양 OSINT 고급 역량 프로젝트의 일환으로 개발되었습니다.*

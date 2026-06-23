










# CLAUDE.md

Maritime OSINT Sentry — 실시간 해양 상황인식(MSA) 플랫폼. AIS 선박 추적, SGP4 위성 궤도,
OpenSky 항공기, Sentinel-2 위성 영상, ML 기반 충돌 예측을 단일 3D 전술 글로브 위에서 통합 운용한다.

## 실행 / 개발

```bash
uv sync                                                      # 의존성 설치
uv run uvicorn backend.main:app --host 0.0.0.0 --port 8001   # 정식 실행 (README 기준)
```

- **활성 앱은 `backend.main:app`** 이다. 루트의 `main.py`는 구버전 모놀리식이며 새 작업은 여기서 하지 말 것.
- 개발 서버는 보통 **포트 12081**로 띄워 확인한다. 서버를 멈출 때는 `kill -9`.
- 모니터링 포함 전체 스택: `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d`
  - App `:8001` · Prometheus `:9090` · Grafana `:3001` (admin/admin) · Redis `:6379`

## 테스트

```bash
uv run pytest                          # 파이썬 테스트 (tests/)
node --test tests/js/*.test.mjs        # JS 테스트
```

- pytest는 `pytest-asyncio` 사용. 충돌/육지필터/항로/hazard grid 등 도메인 로직 위주.

## 구조

```
backend/
  main.py            ← FastAPI 진입점 (lifespan에서 AIS 스트림·history writer·hazard cache 기동)
  config.py          환경변수 (DB_*, AIS_API_KEY, OPENSKY_*, PORT, REDIS_URL)
  routers/           ships · collision · hazard · route · satellites · aircraft · weather · chat · events · alerts · history · metrics · health · data · sentinel
  services/          ais_stream · collision_analyzer · land_filter · korea_hex_grid · hazard(static_hazards) · llm_agent/llm_tools · satellite_tracker · aircraft_tracker · history_writer · port_search · stream_producer/consumer
  cache/, data/      디스크 캐시 · 정적 데이터
collision_model_new/da10-service/   별도 XGBoost 충돌 예측 서비스 (REST). git submodule 형태.
static/
  index.html         단일 페이지, 여러 화면(글로브/항로/Roll 뷰어 등) 전환
  js/                map-cesium(3D) · map-leaflet(2D) · websocket · collision · route-viewer · roll-viewer · roll-prediction · chat · 등
  css/, models/, demos/
electron/            데스크톱 패키징
```

## 데이터 흐름 핵심

- **WebSocket**가 실시간 파이프라인의 중심. 백엔드 `backend/websocket.py` ↔ 프론트 `static/js/websocket.js`.
- **글로벌 AIS 피드는 ~30k 척, 멀티-MB 페이로드**다. 모든 vessel-dict 직렬화/가공은 반드시
  `asyncio.to_thread()`로 이벤트 루프 밖에서 처리할 것 (`backend/main.py`의 `_build_ships_payload` 참고).
  이걸 루프에서 돌리면 hazard API·WS 핸드셰이크가 전부 굶는다.
- **hazard 셀**은 디스크 캐시(`backend/services/hazard_cells_cache.json`)로 warm.

## 컨벤션

- **정적 자산 캐시:** dev 서버를 `DEV_NO_CACHE=1`로 띄우면 정적 파일에 `Cache-Control: no-store`가 붙어 **새로고침만으로 최신 CSS/JS가 반영**된다(`?v=` 수동 갱신 불필요). 플래그 없이 띄웠다면 종전대로 **JS/CSS 수정 후 `index.html`의 `?v=`를 올려야** 새로고침에 반영된다. 운영에선 캐시 유지를 위해 이 플래그를 끈다.
- 백엔드는 DB/외부 의존이 실패해도 실시간 기능은 계속 동작하도록 graceful degrade (lifespan의 try/except 패턴 유지).
- 항로(route) 모델은 ship-size class A–E를 `&size_class=`로 받도록 이미 배선됨.
- `.env`는 절대 커밋하지 말 것. API 키·DB 자격증명은 `.gitignore`로 보호.

## 스택

Python 3.12 / FastAPI · asyncpg(PostGIS) · CesiumJS · Leaflet · Three.js · XGBoost · WebSocket · Prometheus/Grafana · Redis · Ollama(LLM tool-calling). 패키지 매니저는 **uv**.

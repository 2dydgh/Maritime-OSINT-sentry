# Bottom Bar 리디자인 — 차트 개선 및 신규 카드 추가

## 목표

하단 상태 바의 차트 유형을 데이터 특성에 맞게 개선하고, 국적 분포 및 선박 밀도 카드를 추가한다. LATENCY는 상단 헤더로 이동하여 공간을 확보한다.

## 변경 전 레이아웃 (5칸)

```
[VESSELS 도넛] [RISK 세로바] [WIND MAX] [WAVE MAX] [LATENCY]
```

## 변경 후 레이아웃 (5칸)

```
[VESSELS treemap] [RISK sparkline] [WIND·WAVE 합침] [FLAG 국적 Top5] [DENSITY 히트맵]
```

## 상세 설계

### 1. VESSELS — 도넛 → Treemap

- ECharts 도넛 제거, 순수 HTML/CSS treemap으로 교체
- 선종별(cargo, tanker, passenger, fishing, military, tug, other) 면적 비례 블록
- 각 블록에 수량 텍스트 표시 (공간 충분한 블록만)
- 기존 색상 코드 유지 (SHIP_COLORS 참조)
- `BottomBar.updateVesselTypes(counts)` 함수 내부만 변경, 인터페이스 동일

### 2. RISK — 세로 바 → Area Sparkline

- 최근 60회 갱신(약 10분, 10초 주기)의 총 위험 건수를 순환 버퍼에 저장
- SVG area sparkline으로 추이 렌더링 (기존 sparkline 패턴 재사용)
- 현재 값은 왼쪽 숫자로 표시, 추이는 오른쪽 sparkline으로
- 위험 증가 추세면 빨간색 그라디언트, 감소 추세면 초록색으로 동적 변경
- `BottomBar.updateRiskLevels()` 인터페이스에 총합 히스토리 추가

### 3. WIND · WAVE 합침

- 기존 2개의 `stat-card`를 1개로 합침
- 상단: WIND 라벨 + 값 (우측 정렬)
- 하단: WAVE 라벨 + 값 (우측 정렬)
- 구분선: 1px rgba 가로선
- CSS `flex: 0.7` (기존 각 0.6 → 합쳐서 더 좁게)
- `stat-card-loc` (위치 텍스트)는 공간상 제거

### 4. FLAG — 국적 Top 5 가로 바 (신규)

- 현재 추적 선박의 국적을 집계하여 상위 5개국 표시
- 2글자 국가 코드 (PA, LR, MH 등) + 가로 바 + 수량
- 색상: 파란 계열 그라디언트 (1위 진한 파랑 → 5위 연한 파랑)
- 데이터 소스: `get_ais_vessels()` 응답의 `country` 필드를 프론트에서 집계
- 신규 함수: `BottomBar.updateFlagDistribution(vessels)`
- 갱신 주기: 선박 데이터 갱신 시 함께 (기존 `fetchShips` 콜백)

### 5. DENSITY — 밀도 히트맵 (신규)

- 현재 뷰포트를 5x5 격자로 나누어 각 셀의 선박 수 계산
- 셀 배경 opacity로 밀도 표현 (0척: 투명, 최대: 진한 파랑/빨강)
- 높은 밀도 셀은 빨간색, 중간은 주황, 낮은 것은 파란색 계열
- 라벨: "DENSITY", 서브라벨: "5x5"
- 데이터 소스: 현재 Cesium 카메라 뷰포트 bounds + 선박 위치
- 신규 함수: `BottomBar.updateDensityGrid(vessels, viewBounds)`
- 갱신 주기: 선박 데이터 갱신 시 + 카메라 이동 시

### 6. LATENCY → 헤더 이동

- 하단 바에서 `statLatency` 카드 제거
- 상단 `<header>` 내 `header-stats` 영역에 LED + 지연시간 추가
- 시계 옆에 배치: `14:32:07 UTC  ● 42ms`
- 기존 WebSocket LED (`bottomWsLed`) + 지연시간 값 유지
- ID 변경: `bottomLatency` → `headerLatency`, `bottomWsLed` → `headerWsLed`

## 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `static/index.html` | 하단 바 HTML 재구성, 헤더에 latency 추가 |
| `static/css/main.css` | treemap/sparkline/합침 카드/국적 바/히트맵 스타일 |
| `static/js/sparkline.js` | treemap 렌더러, risk sparkline 버퍼, 국적 집계, 밀도 격자 함수 추가 |
| `static/js/ui-controls.js` | fetchShips 콜백에서 국적/밀도 업데이트 호출 |
| `static/js/websocket.js` | latency 업데이트 대상 ID 변경 (bottom → header) |

## 변경하지 않는 부분

- 백엔드 API — 프론트엔드 전용 변경
- ECharts 라이브러리 — treemap은 순수 HTML/CSS로 구현 (ECharts 의존성 제거)
- 기존 선박/충돌 로직

# Class A/B 기반 충돌 분석 차등 임계값

## 배경

AIS 트랜스폰더는 Class A(대형 상선, 군함, 여객선)와 Class B(소형, 레저, 어선)로 나뉜다.
현재 충돌 분석(`collision_analyzer.py`)은 모든 선박에 동일한 DCPA/TCPA 임계값을 적용하고 있어,
선박 크기와 기동성 차이를 반영하지 못한다.

## 목표

AIS 메시지 타입(`PositionReport` = Class A, `StandardClassBPositionReport` = Class B)을 활용하여
선박 쌍의 Class 조합별로 충돌 분석 임계값을 차등 적용한다.

## 설계

### 1. `ais_stream.py` — Class 정보 저장

`_ais_stream_loop()`에서 메시지 타입에 따라 vessel dict에 `ais_class` 필드 추가:

- `PositionReport` → `ais_class: "A"`
- `StandardClassBPositionReport` → `ais_class: "B"`

`get_ais_vessels()` 응답에 `ais_class` 필드 포함 (기본값 `"A"` — ShipStaticData만 수신된 경우 대형 가정).

### 2. `collision_analyzer.py` — 쌍 기준 임계값 테이블

기존 고정 상수를 Class 조합별 dict로 교체:

| 조합 | DCPA_DANGER | DCPA_WARNING | TCPA_MAX |
|------|-------------|--------------|----------|
| A-A  | 0.5nm       | 1.0nm        | 20분     |
| A-B  | 0.3nm       | 0.7nm        | 15분     |
| B-B  | 0.2nm       | 0.5nm        | 10분     |

Head-on 조우는 위 값의 60% 적용 (기존 비율 유지):

| 조합 | HEAD_ON_DANGER | HEAD_ON_WARNING |
|------|----------------|-----------------|
| A-A  | 0.3nm          | 0.5nm (현행 유지) |
| A-B  | 0.18nm         | 0.42nm          |
| B-B  | 0.12nm         | 0.3nm           |

### 3. `_build_proximity_pairs()` — TCPA 필터 차등화

현재 `TCPA_MAX_MIN = 20` 일률 적용을 Class 조합에 따라 차등 적용.
근접 필터 반경(5nm)과 정지 선박 기준(1kt)은 변경 없음.

### 4. `analyze_distance_risks()` — 임계값 조회 로직

`_get_pair_class()` 헬퍼 함수로 두 선박의 ais_class 조합 키를 산출하고,
해당 키로 임계값 테이블을 조회하여 적용.

## 변경 범위

| 파일 | 변경 내용 |
|------|----------|
| `backend/services/ais_stream.py` | vessel에 `ais_class` 필드 추가, `get_ais_vessels()` 응답에 포함 |
| `backend/services/collision_analyzer.py` | 임계값 테이블 도입, `_build_proximity_pairs()` 및 `analyze_distance_risks()` 수정 |

## 변경하지 않는 부분

- ML 모델(`da10-service`) — 기존 피처 그대로 유지
- 근접 필터 반경 (5nm)
- 정지 선박 기준 (SOG < 1kt)
- 프론트엔드 — severity 필드 구조 동일, 변경 없음

# History 모드 슬라이딩 윈도우 리팩토링 설계

## 문제 요약

현재 History 모드는 전체 시간 범위(6일)를 한 번에 요청하면서 `LIMIT 200` + `limit_per_ship=30`으로 제한하여:
- 43,613척 중 0.46%(200척)만 표시
- `ORDER BY object_id`로 항상 동일한 선박만 선택 (편향)
- 6일 / 30포인트 = 4.8시간 간격 → 보간이 의미 없음
- `ship_type` 대부분 "unknown" → 필터 무의미

## 설계

### 1. 데이터 로딩: 슬라이딩 윈도우

**현재**: 전체 범위(6일) 한 번에 요청, 200척 × 30포인트
**변경**: 현재 시간 기준 **±30분 (1시간 윈도우)** 단위로 요청

- History 모드 진입 시 → 최신 시간 기준 1시간 윈도우 로드
- 재생 중 시간이 윈도우 끝에서 **70% 지점**을 넘으면 → 다음 윈도우 프리페치
- 타임라인 드래그로 점프 시 → 로딩 인디케이터 표시 → 새 윈도우 로드 → 렌더링
- 윈도우 교체 시 이전 엔티티 클리어 후 새로 생성

### 2. 백엔드 쿼리 개선

`/api/v1/history/trajectories` 수정:

| 항목 | 현재 | 변경 |
|------|------|------|
| 선박 수 제한 | `LIMIT 200` (object_id순) | `LIMIT 500` (**포인트 수 많은 순**) |
| 포인트 수 | `limit_per_ship=30` | `limit_per_ship=60` |
| 정렬 기준 | `ORDER BY object_id` | `ORDER BY point_count DESC` |

1시간 윈도우에서 활동 중인 선박은 보통 수백~수천 척이므로, 500척이면 주요 선박 대부분 커버. 선박당 60포인트 / 1시간 = **1분 간격** → 부드러운 보간 가능.

### 3. ship_type "unknown" 문제 수정

원인: `PositionReport`가 `ShipStaticData`보다 먼저 도착 → type 없는 상태로 DB 저장 → 이후 ShipStaticData가 와도 기존 DB 레코드는 "unknown" 유지.

수정 (두 갈래):
- **저장 시점**: `ShipStaticData` 도착 시 → 해당 MMSI의 최근 "unknown" 레코드를 DB에서 일괄 `UPDATE`
- **조회 시점**: history 쿼리 결과에서 `ship_type`이 `"unknown"`이면 → 현재 AIS 캐시의 메타데이터로 보완 (이미 부분적으로 구현됨, `history.py:95-96`)

### 4. 프론트엔드 흐름

```
[HISTORY 클릭]
  → loadHistoryRange() — 타임라인 범위 설정
  → 로딩 인디케이터 표시
  → loadHistoryWindow(currentTime) — ±30분 윈도우 로드
  → 엔티티 생성 + 보간 설정
  → 로딩 인디케이터 해제
  → 재생 시작 (multiplier=60)

[재생 중 70% 지점 도달]
  → 백그라운드로 다음 윈도우 프리페치
  → 윈도우 교체 (기존 엔티티 클리어 → 새 엔티티)

[타임라인 드래그/점프]
  → 로딩 인디케이터 표시
  → debounce 300ms 후 새 윈도우 로드
  → 엔티티 교체 → 로딩 해제
```

### 5. 수정 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `backend/routers/history.py` | 쿼리 정렬 기준 변경, 기본값 조정 |
| `backend/services/ais_stream.py` | ShipStaticData 도착 시 DB update 로직 추가 |
| `backend/services/history_writer.py` | `update_ship_type(mmsi, ship_type)` 함수 추가 |
| `static/index.html` | 슬라이딩 윈도우 로직, 로딩 UX, 프리페치 |

### 6. UX 결정사항

- 타임라인 드래그/점프 시 → **로딩 인디케이터 표시 후 데이터 도착 시 렌더링** (A안)
- 재생 + 타임라인 드래그 **둘 다 지원** (C안)
- ship_type 수정 **이번 작업에 포함**

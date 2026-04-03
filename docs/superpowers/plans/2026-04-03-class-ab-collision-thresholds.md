# Class A/B 기반 충돌 분석 차등 임계값 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AIS Class A/B 메시지 타입을 기반으로 선박 쌍의 충돌 분석 임계값을 차등 적용한다.

**Architecture:** `ais_stream.py`에서 메시지 타입별로 `ais_class` 필드를 vessel에 저장하고, `collision_analyzer.py`에서 쌍의 Class 조합(A-A, A-B, B-B)에 따라 DCPA/TCPA 임계값 테이블을 조회하여 적용한다.

**Tech Stack:** Python, pytest

---

### Task 1: `ais_stream.py`에 `ais_class` 필드 추가

**Files:**
- Modify: `backend/services/ais_stream.py:377-398` (PositionReport 처리 블록)
- Modify: `backend/services/ais_stream.py:286-311` (`get_ais_vessels()` 응답)
- Test: `tests/test_ais_class.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_ais_class.py`:

```python
"""ais_stream의 ais_class 필드 저장 테스트."""
from backend.services import ais_stream


def test_class_a_default():
    """ais_class 기본값은 'A'."""
    vessel = {"_updated": 1.0}
    assert vessel.get("ais_class", "A") == "A"


def test_get_ais_vessels_includes_ais_class():
    """get_ais_vessels 응답에 ais_class 필드가 포함된다."""
    import time
    mmsi = 999000001
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": 33.5, "lng": 125.0, "sog": 10.0, "cog": 90.0,
            "heading": 90, "name": "TEST-A", "type": "cargo",
            "callsign": "TSTA", "destination": "BUSAN", "imo": 0,
            "length": 200, "beam": 30, "draught": 10.0, "eta": "",
            "ais_class": "A", "_updated": time.time(),
        }
    try:
        vessels = ais_stream.get_ais_vessels()
        test_vessel = [v for v in vessels if v["mmsi"] == mmsi]
        assert len(test_vessel) == 1
        assert test_vessel[0]["ais_class"] == "A"
    finally:
        with ais_stream._vessels_lock:
            ais_stream._vessels.pop(mmsi, None)


def test_class_b_vessel():
    """ais_class 'B'로 저장된 선박이 올바르게 반환된다."""
    import time
    mmsi = 999000002
    with ais_stream._vessels_lock:
        ais_stream._vessels[mmsi] = {
            "lat": 34.0, "lng": 126.0, "sog": 5.0, "cog": 180.0,
            "heading": 180, "name": "TEST-B", "type": "fishing",
            "callsign": "TSTB", "destination": "", "imo": 0,
            "length": 15, "beam": 5, "draught": 2.0, "eta": "",
            "ais_class": "B", "_updated": time.time(),
        }
    try:
        vessels = ais_stream.get_ais_vessels()
        test_vessel = [v for v in vessels if v["mmsi"] == mmsi]
        assert len(test_vessel) == 1
        assert test_vessel[0]["ais_class"] == "B"
    finally:
        with ais_stream._vessels_lock:
            ais_stream._vessels.pop(mmsi, None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_ais_class.py -v`
Expected: `test_get_ais_vessels_includes_ais_class` FAIL — `ais_class` 키가 응답에 없음

- [ ] **Step 3: Implement — `_ais_stream_loop()`에 ais_class 저장**

`backend/services/ais_stream.py:388` 부근, `PositionReport` 처리 블록 내 `with _vessels_lock:` 안에 추가:

```python
                    with _vessels_lock:
                        vessel["lat"] = lat
                        vessel["lng"] = lng
                        vessel["sog"] = report.get("Sog", 0)
                        vessel["cog"] = report.get("Cog", 0)
                        heading = report.get("TrueHeading", 511)
                        vessel["heading"] = heading if heading != 511 else report.get("Cog", 0)
                        vessel["_updated"] = time.time()
                        vessel["ais_class"] = "B" if msg_type == "StandardClassBPositionReport" else "A"
                        # Use metadata name if we don't have one yet
                        if not vessel.get("name") or vessel["name"] == "UNKNOWN":
                            vessel["name"] = metadata.get("ShipName", "UNKNOWN").strip() or "UNKNOWN"
```

핵심 변경: `vessel["ais_class"] = "B" if msg_type == "StandardClassBPositionReport" else "A"` 한 줄 추가.

- [ ] **Step 4: Implement — `get_ais_vessels()` 응답에 ais_class 포함**

`backend/services/ais_stream.py:292-309`, `result.append({...})` 블록에 `ais_class` 필드 추가:

```python
            result.append({
                "mmsi": mmsi,
                "name": v.get("name", "UNKNOWN"),
                "type": v_type,
                "lat": round(v.get("lat", 0), 5),
                "lng": round(v.get("lng", 0), 5),
                "heading": v.get("heading", 0),
                "sog": round(v.get("sog", 0), 1),
                "cog": round(v.get("cog", 0), 1),
                "callsign": v.get("callsign", ""),
                "destination": v.get("destination", "") or "UNKNOWN",
                "imo": v.get("imo", 0),
                "country": get_country_from_mmsi(mmsi),
                "length": v.get("length", 0),
                "beam": v.get("beam", 0),
                "draught": v.get("draught", 0),
                "eta": v.get("eta", ""),
                "ais_class": v.get("ais_class", "A"),
            })
```

핵심 변경: `"ais_class": v.get("ais_class", "A"),` 한 줄 추가. 기본값 `"A"` — ShipStaticData만 수신된 선박은 대형으로 가정.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_ais_class.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add backend/services/ais_stream.py tests/test_ais_class.py
git commit -m "feat(ais): store ais_class (A/B) from message type"
```

---

### Task 2: `collision_analyzer.py`에 Class 조합별 임계값 테이블 도입

**Files:**
- Modify: `backend/services/collision_analyzer.py:24-37` (상수 영역)
- Test: `tests/test_collision_class_thresholds.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_collision_class_thresholds.py`:

```python
"""collision_analyzer의 Class A/B 차등 임계값 테스트."""
from backend.services import collision_analyzer


def test_get_pair_class_aa():
    """Class A + A → 'AA' 키."""
    ship_a = {"ais_class": "A"}
    ship_b = {"ais_class": "A"}
    assert collision_analyzer._get_pair_class(ship_a, ship_b) == "AA"


def test_get_pair_class_ab():
    """Class A + B → 'AB' 키 (순서 무관)."""
    assert collision_analyzer._get_pair_class({"ais_class": "A"}, {"ais_class": "B"}) == "AB"
    assert collision_analyzer._get_pair_class({"ais_class": "B"}, {"ais_class": "A"}) == "AB"


def test_get_pair_class_bb():
    """Class B + B → 'BB' 키."""
    assert collision_analyzer._get_pair_class({"ais_class": "B"}, {"ais_class": "B"}) == "BB"


def test_get_pair_class_default():
    """ais_class 없으면 'A' 기본값 → 'AA'."""
    assert collision_analyzer._get_pair_class({}, {}) == "AA"


def test_thresholds_aa_stricter_than_bb():
    """A-A 임계값이 B-B보다 크다 (더 넓은 범위에서 경고)."""
    aa = collision_analyzer.CLASS_THRESHOLDS["AA"]
    bb = collision_analyzer.CLASS_THRESHOLDS["BB"]
    assert aa["dcpa_danger"] > bb["dcpa_danger"]
    assert aa["dcpa_warning"] > bb["dcpa_warning"]
    assert aa["tcpa_max"] > bb["tcpa_max"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py -v`
Expected: FAIL — `_get_pair_class` 및 `CLASS_THRESHOLDS` 없음

- [ ] **Step 3: Implement — 임계값 테이블과 헬퍼 함수**

`backend/services/collision_analyzer.py`, 기존 상수 영역(line 24~37) 아래에 추가:

```python
# --- Class A/B 조합별 임계값 ---
CLASS_THRESHOLDS = {
    "AA": {
        "dcpa_danger": 0.5,       # nm
        "dcpa_warning": 1.0,      # nm
        "dcpa_danger_head_on": 0.3,
        "dcpa_warning_head_on": 0.5,
        "tcpa_max": 20,           # 분
    },
    "AB": {
        "dcpa_danger": 0.3,
        "dcpa_warning": 0.7,
        "dcpa_danger_head_on": 0.18,
        "dcpa_warning_head_on": 0.42,
        "tcpa_max": 15,
    },
    "BB": {
        "dcpa_danger": 0.2,
        "dcpa_warning": 0.5,
        "dcpa_danger_head_on": 0.12,
        "dcpa_warning_head_on": 0.3,
        "tcpa_max": 10,
    },
}


def _get_pair_class(ship_a: dict, ship_b: dict) -> str:
    """두 선박의 ais_class 조합 키를 반환. 항상 알파벳 순 정렬."""
    ca = ship_a.get("ais_class", "A")
    cb = ship_b.get("ais_class", "A")
    return "".join(sorted([ca, cb]))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/services/collision_analyzer.py tests/test_collision_class_thresholds.py
git commit -m "feat(collision): add Class A/B threshold table and _get_pair_class helper"
```

---

### Task 3: `_build_proximity_pairs()`에 Class 기반 TCPA 필터 적용

**Files:**
- Modify: `backend/services/collision_analyzer.py:231-297` (`_build_proximity_pairs`)
- Test: `tests/test_collision_class_thresholds.py` (추가)

- [ ] **Step 1: Write the failing test**

`tests/test_collision_class_thresholds.py`에 추가:

```python
from unittest.mock import patch
from backend.services import land_filter


def _make_vessel(mmsi, lat, lng, sog=10.0, cog=90.0, ais_class="A"):
    return {
        "mmsi": mmsi, "lat": lat, "lng": lng,
        "sog": sog, "cog": cog, "ais_class": ais_class,
        "name": f"SHIP-{mmsi}", "type": "cargo", "country": "KR",
    }


def test_bb_pair_filtered_by_shorter_tcpa_max():
    """B-B 쌍은 TCPA 10분 초과 시 필터링된다.

    두 Class B 선박이 멀리서 접근 중이라 TCPA가 12분인 경우,
    B-B tcpa_max=10분에 의해 필터링되어야 한다.
    같은 상황에서 A-A라면 tcpa_max=20분이므로 통과해야 한다.
    """
    # 동서로 ~2nm 떨어진 두 선박, 서로를 향해 접근 (head-on)
    # SOG 5kts씩이면 접근 속도 ~10kts, 2nm / (10kts/60) = 12분
    with patch.object(land_filter, "is_land_between", return_value=False):
        vessels_bb = [
            _make_vessel(2001, 33.5, 125.0, sog=5.0, cog=90, ais_class="B"),
            _make_vessel(2002, 33.5, 125.033, sog=5.0, cog=270, ais_class="B"),
        ]
        pairs_bb = collision_analyzer._build_proximity_pairs(vessels_bb)

        vessels_aa = [
            _make_vessel(3001, 33.5, 125.0, sog=5.0, cog=90, ais_class="A"),
            _make_vessel(3002, 33.5, 125.033, sog=5.0, cog=270, ais_class="A"),
        ]
        pairs_aa = collision_analyzer._build_proximity_pairs(vessels_aa)

    # B-B: TCPA ~12분 > tcpa_max 10분 → 필터링
    assert len(pairs_bb) == 0
    # A-A: TCPA ~12분 < tcpa_max 20분 → 유지
    assert len(pairs_aa) >= 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py::test_bb_pair_filtered_by_shorter_tcpa_max -v`
Expected: FAIL — B-B 쌍도 TCPA 20분 기준으로 통과해버림

- [ ] **Step 3: Implement — `_build_proximity_pairs()`에서 Class 기반 TCPA 필터**

`backend/services/collision_analyzer.py`의 `_build_proximity_pairs()` 함수, line 282~284 부근 변경:

기존:
```python
                # TCPA가 음수(이미 지나감), 해소 직전(< 1분), 너무 먼 미래면 스킵
                if tcpa < TCPA_MIN_MIN or tcpa > TCPA_MAX_MIN:
                    continue
```

변경:
```python
                # Class 조합별 TCPA 상한 적용
                pair_class = _get_pair_class(v, other)
                tcpa_max = CLASS_THRESHOLDS[pair_class]["tcpa_max"]

                # TCPA가 음수(이미 지나감), 해소 직전(< 1분), 너무 먼 미래면 스킵
                if tcpa < TCPA_MIN_MIN or tcpa > tcpa_max:
                    continue
```

그리고 `pairs.append({...})` 블록에 `pair_class` 추가:

기존:
```python
                pairs.append({
                    "ship_a": v,
                    "ship_b": other,
                    "tcpa_min": round(tcpa, 1),
                    "dcpa_nm": round(dcpa, 3),
                    "current_dist_nm": round(dist, 2),
                    "encounter": encounter,
                })
```

변경:
```python
                pairs.append({
                    "ship_a": v,
                    "ship_b": other,
                    "tcpa_min": round(tcpa, 1),
                    "dcpa_nm": round(dcpa, 3),
                    "current_dist_nm": round(dist, 2),
                    "encounter": encounter,
                    "pair_class": pair_class,
                })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/services/collision_analyzer.py tests/test_collision_class_thresholds.py
git commit -m "feat(collision): apply Class-based TCPA filter in proximity pairs"
```

---

### Task 4: `analyze_distance_risks()`에 Class 기반 DCPA 임계값 적용

**Files:**
- Modify: `backend/services/collision_analyzer.py:314-348` (`analyze_distance_risks`)
- Test: `tests/test_collision_class_thresholds.py` (추가)

- [ ] **Step 1: Write the failing test**

`tests/test_collision_class_thresholds.py`에 추가:

```python
def test_analyze_distance_risks_class_ab_thresholds():
    """A-B 쌍은 A-B 임계값(dcpa_warning=0.7nm)을 적용한다.

    DCPA 0.8nm인 경우:
    - A-A (dcpa_warning=1.0nm): 경고 발생
    - A-B (dcpa_warning=0.7nm): 경고 없음
    """
    pair_aa = {
        "ship_a": _make_vessel(4001, 33.5, 125.0, ais_class="A"),
        "ship_b": _make_vessel(4002, 33.5, 125.01, ais_class="A"),
        "tcpa_min": 5.0,
        "dcpa_nm": 0.8,
        "current_dist_nm": 1.5,
        "encounter": "crossing",
        "pair_class": "AA",
    }
    pair_ab = {
        "ship_a": _make_vessel(5001, 33.5, 125.0, ais_class="A"),
        "ship_b": _make_vessel(5002, 33.5, 125.01, ais_class="B"),
        "tcpa_min": 5.0,
        "dcpa_nm": 0.8,
        "current_dist_nm": 1.5,
        "encounter": "crossing",
        "pair_class": "AB",
    }

    risks_aa = collision_analyzer.analyze_distance_risks([pair_aa])
    risks_ab = collision_analyzer.analyze_distance_risks([pair_ab])

    # A-A: 0.8 < 1.0 (warning thresh) → 경고 1건
    assert len(risks_aa) == 1
    assert risks_aa[0]["severity"] == "warning"
    # A-B: 0.8 > 0.7 (warning thresh) → 경고 없음
    assert len(risks_ab) == 0


def test_analyze_distance_risks_head_on_class_bb():
    """B-B head-on은 dcpa_warning_head_on=0.3nm 적용.

    DCPA 0.4nm head-on인 경우:
    - A-A (head_on warning=0.5nm): 경고 발생
    - B-B (head_on warning=0.3nm): 경고 없음
    """
    pair_aa = {
        "ship_a": _make_vessel(6001, 33.5, 125.0, cog=90, ais_class="A"),
        "ship_b": _make_vessel(6002, 33.5, 125.01, cog=270, ais_class="A"),
        "tcpa_min": 3.0,
        "dcpa_nm": 0.4,
        "current_dist_nm": 1.0,
        "encounter": "head-on",
        "pair_class": "AA",
    }
    pair_bb = {
        "ship_a": _make_vessel(7001, 33.5, 125.0, cog=90, ais_class="B"),
        "ship_b": _make_vessel(7002, 33.5, 125.01, cog=270, ais_class="B"),
        "tcpa_min": 3.0,
        "dcpa_nm": 0.4,
        "current_dist_nm": 1.0,
        "encounter": "head-on",
        "pair_class": "BB",
    }

    risks_aa = collision_analyzer.analyze_distance_risks([pair_aa])
    risks_bb = collision_analyzer.analyze_distance_risks([pair_bb])

    assert len(risks_aa) == 1
    assert risks_aa[0]["severity"] == "warning"
    assert len(risks_bb) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py::test_analyze_distance_risks_class_ab_thresholds tests/test_collision_class_thresholds.py::test_analyze_distance_risks_head_on_class_bb -v`
Expected: FAIL — 모든 쌍에 동일한 고정 임계값 적용 중

- [ ] **Step 3: Implement — `analyze_distance_risks()`에 Class 기반 임계값 조회**

`backend/services/collision_analyzer.py`의 `analyze_distance_risks()` 함수 변경:

기존 (line 314-348):
```python
def analyze_distance_risks(proximity_pairs: list[dict]) -> list[dict]:
    """거리 기반 DCPA/TCPA 임계값 판정. 조우 유형별 차등 임계값 적용."""
    risks = []
    now_ts = datetime.now(timezone.utc).isoformat()

    for pair in proximity_pairs:
        dcpa = pair["dcpa_nm"]
        encounter = pair.get("encounter", "crossing")

        # head-on은 정상 교행이 많으므로 임계값을 엄격하게 적용
        if encounter == "head-on":
            danger_thresh = DCPA_DANGER_HEAD_ON_NM
            warning_thresh = DCPA_WARNING_HEAD_ON_NM
        else:
            danger_thresh = DCPA_DANGER_NM
            warning_thresh = DCPA_WARNING_NM

        if dcpa > warning_thresh:
            continue

        severity = "danger" if dcpa < danger_thresh else "warning"

        risks.append({
            "ship_a": _make_ship_info(pair["ship_a"]),
            "ship_b": _make_ship_info(pair["ship_b"]),
            "tcpa_min": pair["tcpa_min"],
            "dcpa_nm": pair["dcpa_nm"],
            "current_dist_nm": pair["current_dist_nm"],
            "severity": severity,
            "encounter": encounter,
            "ts": now_ts,
        })

    risks.sort(key=lambda r: (0 if r["severity"] == "danger" else 1, r["tcpa_min"]))
    return risks
```

변경:
```python
def analyze_distance_risks(proximity_pairs: list[dict]) -> list[dict]:
    """거리 기반 DCPA/TCPA 임계값 판정. Class 조합 + 조우 유형별 차등 적용."""
    risks = []
    now_ts = datetime.now(timezone.utc).isoformat()

    for pair in proximity_pairs:
        dcpa = pair["dcpa_nm"]
        encounter = pair.get("encounter", "crossing")
        pair_class = pair.get("pair_class", "AA")
        thresholds = CLASS_THRESHOLDS[pair_class]

        # head-on은 정상 교행이 많으므로 임계값을 엄격하게 적용
        if encounter == "head-on":
            danger_thresh = thresholds["dcpa_danger_head_on"]
            warning_thresh = thresholds["dcpa_warning_head_on"]
        else:
            danger_thresh = thresholds["dcpa_danger"]
            warning_thresh = thresholds["dcpa_warning"]

        if dcpa > warning_thresh:
            continue

        severity = "danger" if dcpa < danger_thresh else "warning"

        risks.append({
            "ship_a": _make_ship_info(pair["ship_a"]),
            "ship_b": _make_ship_info(pair["ship_b"]),
            "tcpa_min": pair["tcpa_min"],
            "dcpa_nm": pair["dcpa_nm"],
            "current_dist_nm": pair["current_dist_nm"],
            "severity": severity,
            "encounter": encounter,
            "pair_class": pair_class,
            "ts": now_ts,
        })

    risks.sort(key=lambda r: (0 if r["severity"] == "danger" else 1, r["tcpa_min"]))
    return risks
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_class_thresholds.py -v`
Expected: 8 passed

- [ ] **Step 5: Run existing collision tests to verify no regression**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/test_collision_land_filter.py -v`
Expected: 2 passed — 기존 테스트는 `ais_class` 없는 vessel을 사용하므로 기본값 `"A"` → `"AA"` 임계값 적용 → 기존 동작과 동일

- [ ] **Step 6: Commit**

```bash
git add backend/services/collision_analyzer.py tests/test_collision_class_thresholds.py
git commit -m "feat(collision): apply Class A/B thresholds in distance risk analysis"
```

---

### Task 5: 기존 고정 상수 정리 및 전체 테스트

**Files:**
- Modify: `backend/services/collision_analyzer.py:28-37` (사용하지 않는 상수 제거)

- [ ] **Step 1: Remove unused constants**

`backend/services/collision_analyzer.py`에서 `CLASS_THRESHOLDS`로 대체된 기존 상수 제거:

```python
# 삭제할 상수들:
DCPA_DANGER_NM = 0.5
DCPA_WARNING_NM = 1.0
TCPA_MAX_MIN = 20
DCPA_DANGER_HEAD_ON_NM = 0.3
DCPA_WARNING_HEAD_ON_NM = 0.5
```

단, `TCPA_MAX_MIN`은 `_compute_os_risk()` (line 353)에서도 사용되므로 유지하거나, `CLASS_THRESHOLDS["AA"]["tcpa_max"]`로 교체:

기존 (line 351-355):
```python
def _compute_os_risk(dcpa: float, rng: float, tcpa_min: float) -> float:
    """dOsRisk 근사 계산: (1 - DCPA/RNG) * (1 - TCPA/TCPA_MAX) * 93"""
    if rng <= 0 or dcpa >= rng or tcpa_min >= TCPA_MAX_MIN:
        return 0.0
    return (1 - dcpa / rng) * (1 - tcpa_min / TCPA_MAX_MIN) * 93.0
```

변경: `TCPA_MAX_MIN`은 ML 모델 입력 계산에 쓰이므로 그대로 유지. ML 모델은 Class 차등화 대상이 아니므로 이 상수는 삭제하지 않는다.

최종 삭제 대상:
```python
DCPA_DANGER_NM = 0.5
DCPA_WARNING_NM = 1.0
DCPA_DANGER_HEAD_ON_NM = 0.3
DCPA_WARNING_HEAD_ON_NM = 0.5
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/yhlee/4dwar && python -m pytest tests/ -v`
Expected: All passed

- [ ] **Step 3: Commit**

```bash
git add backend/services/collision_analyzer.py
git commit -m "refactor(collision): remove old fixed DCPA constants replaced by CLASS_THRESHOLDS"
```

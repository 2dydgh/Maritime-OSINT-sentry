# History Time Travel Hotfix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all known issues in the History (Time Travel) replay feature, from DB schema through API to frontend playback.

**Architecture:** Backend-first approach — fix data persistence (schema + logging) first, then API error handling, then frontend stability. Each task is independently deployable.

**Tech Stack:** Python/FastAPI, PostgreSQL/PostGIS, asyncpg, vanilla JS + CesiumJS

**Source analysis:** `docs/superpowers/plans/history_hot_fix_plan.md`

**Status:** 🟢 All code changes complete (2026-03-13). Pending: DB migration, server verification, commits.

---

## Chunk 1: Backend Critical & High Fixes

### Task 1: DB 스키마 — ship_type 컬럼 추가 (Critical)

**Files:**
- Modify: `schema.sql:21-31`

- [x] **Step 1: schema.sql에 ship_type 컬럼 추가** ✅ Done

`trajectories` 테이블 정의에 `ship_type VARCHAR(50)` 컬럼을 추가:

```sql
-- trajectories 테이블의 heading 컬럼 다음에 추가
ship_type VARCHAR(50),
```

- [ ] **Step 2: 운영 DB에 ALTER TABLE 실행** ⏳ Manual step

```bash
psql -U <user> -d <db> -c "ALTER TABLE trajectories ADD COLUMN IF NOT EXISTS ship_type VARCHAR(50);"
```

Expected: `ALTER TABLE` 성공 메시지

- [ ] **Step 3: 서버 재기동 후 flush 로그 확인** ⏳ Manual step

```bash
# 서버 시작 후 AIS 데이터 수신 대기 (30초+)
# 로그에서 "History writer: flushed N records to DB" 확인
# "History writer DB error" 가 없어야 함
```

- [ ] **Step 4: Commit**

```bash
git add schema.sql
git commit -m "fix: add ship_type column to trajectories schema"
```

---

### Task 2: 에러 로깅 추가 (Critical)

**Files:**
- Modify: `backend/services/ais_stream.py:408-410`

- [x] **Step 1: bare except pass를 logging으로 교체** ✅ Done

```python
# Before (line 408-410):
                    except Exception as e:
                        # DB 기록 실패해도 실시간 기능은 계속 동작
                        pass

# After:
                    except Exception as e:
                        logger.warning(f"History record failed for MMSI {mmsi}: {e}")
```

- [ ] **Step 2: 서버 재기동 후 로그 확인** ⏳ Manual step

DB 스키마가 아직 수정 안 된 상태라면 warning 로그가 찍히는지 확인.
스키마 수정 후라면 warning이 안 찍히는지 확인.

- [ ] **Step 3: Commit**

```bash
git add backend/services/ais_stream.py
git commit -m "fix: log history_writer errors instead of silently swallowing"
```

---

### Task 3: API 에러 응답 — DB pool 없을 때 503 반환 (High)

**Files:**
- Modify: `backend/routers/history.py:60-63, 131-134, 191-193, 265-268`

- [x] **Step 1: get_ships_at_time — 503 반환** ✅ Done
- [x] **Step 2: get_ship_trajectory — 동일 수정** ✅ Done
- [x] **Step 3: get_bulk_trajectories — 동일 수정** ✅ Done
- [x] **Step 4: get_data_time_range — 동일 수정** ✅ Done
- [ ] **Step 5: Commit**

---

### Task 4: NULL → 0 변환 불일치 수정 (Medium)

**Files:**
- Modify: `backend/routers/history.py:245-246`

- [x] **Step 1: get_bulk_trajectories에서 None 유지** ✅ Done
- [ ] **Step 2: Commit**

---

### Task 5: 독스트링 오류 수정 (Low)

**Files:**
- Modify: `backend/routers/history.py:56`

- [x] **Step 1: docstring 수정** ✅ Done
- [ ] **Step 2: Commit**

---

### Task 6: 샘플링 레이스 컨디션 수정 (Medium)

**Files:**
- Modify: `backend/services/history_writer.py:140-148`

- [x] **Step 1: _last_record_time 접근을 lock 안으로 이동** ✅ Done
- [ ] **Step 2: Commit**

---

## Chunk 2: Frontend Fixes

### Task 7: historyChecker 비활성화 — 보간 모드와 충돌 제거 (High)

**Files:**
- Modify: `static/index.html:1056-1057`

- [x] **Step 1: 보간 모드에서 startHistoryChecker() 제거** ✅ Done
- [x] **Step 2: LIVE 모드 복귀 시 stopHistoryChecker() 확인** ✅ Already present
- [ ] **Step 3: 브라우저 DevTools Network 탭에서 확인** ⏳ Manual step
- [ ] **Step 4: Commit**

---

### Task 8: fetch 타임아웃 추가 (High)

**Files:**
- Modify: `static/index.html` — fetch 호출 4곳

- [x] **Step 1: fetchWithTimeout 헬퍼 함수 추가** ✅ Done
- [x] **Step 2: 4개 fetch 호출을 fetchWithTimeout으로 교체** ✅ Done
- [ ] **Step 3: Commit**

---

### Task 9: 히스토리 로드 실패 시 LIVE 모드 자동 복귀 (High)

**Files:**
- Modify: `static/index.html:1058-1061`

- [x] **Step 1: 실패 시 자동 LIVE 복귀 + 사용자 알림** ✅ Done
- [x] **Step 2: loadHistoryWithInterpolation 실패 시에도 복구** ✅ Done
- [ ] **Step 3: Commit**

---

## Chunk 3: Remaining Medium/Low Fixes

### Task 10: bulk trajectories 선박 수 제한 (Medium)

**Files:**
- Modify: `backend/routers/history.py:202-221`

- [x] **Step 1: CTE에 선박 수 제한 추가** ✅ Done
- [ ] **Step 2: Commit**

---

### Task 11: MMSI 유효성 검증 (Low)

**Files:**
- Modify: `backend/routers/history.py:119-123`

- [x] **Step 1: MMSI 파라미터 검증 추가** ✅ Done
- [ ] **Step 2: Commit**

---

## Verification Checklist

모든 Task 완료 후 다음을 순서대로 검증:

1. **DB 적재 확인:** 서버 기동 → AIS 수신 30초 → `SELECT COUNT(*) FROM trajectories;` 로 레코드 증가 확인
2. **에러 로깅 확인:** 의도적으로 DB 연결 끊고 → `logger.warning` 로그 출력 확인
3. **API 503 확인:** DB pool 없이 `/api/v1/history/range` 호출 → HTTP 503 확인
4. **프론트엔드 확인:** HISTORY 모드 진입 → Network 탭에서 `/history/ships` 반복 요청 없음 확인
5. **타임아웃 확인:** 서버 지연 시뮬레이션 → fetch가 10초 후 abort 되는지 확인
6. **LIVE 복귀 확인:** 히스토리 데이터 없는 상태에서 HISTORY 진입 → 2초 후 LIVE 자동 복귀
7. **LIVE ↔ HISTORY 반복:** 5회 전환 → 메모리 누수/중복 엔티티 없는지 DevTools 확인

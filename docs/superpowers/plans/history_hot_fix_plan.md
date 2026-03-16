히스토리 재생 기능 - 이슈 분석 및 수정 계획

 Context

 히스토리(Time Travel) 재생 기능이 전반적으로 불안정함. 백엔드 데이터 저장부터 프론트엔드 재생까지 전 구간에 걸쳐 이슈가 존재. 이 문서는 객관적으로 파악한
 이슈 목록과 수정 우선순위를 정리함.

 ---
 CRITICAL (배포 차단급)

 1. DB 스키마 불일치 — 데이터 저장 자체가 실패함

 - 파일: backend/services/history_writer.py:93 vs schema.sql:21-31
 - 문제: history_writer가 ship_type 컬럼에 INSERT 하지만, trajectories 테이블 스키마에 ship_type 컬럼이 없음
 - 영향: 모든 flush가 실패 → 궤적 데이터가 DB에 전혀 저장되지 않음 → 히스토리 모드에서 보여줄 데이터 자체가 없음
 - 수정: schema.sql에 ship_type VARCHAR(50) 컬럼 추가 + 기존 DB에 ALTER TABLE 실행

 2. 예외 무시 — 저장 실패를 아예 모름

 - 파일: backend/services/ais_stream.py:399-410
 - 문제: history_writer.record_position() 호출이 bare except: pass로 감싸져 있어 에러 로그조차 없음
 - 영향: Issue #1의 에러가 발생해도 운영자가 전혀 인지 불가
 - 수정: 최소한 logger.error() 추가

 ---
 HIGH (핵심 기능 장애)

 3. historyChecker가 보간 모드와 충돌하여 불필요한 API 폭탄

 - 파일: static/index.html:1080-1089 + :1050-1057
 - 문제: HISTORY 모드 진입 시 loadHistoryWithInterpolation()으로 궤적을 한번에 로드하고 Cesium SampledPositionProperty로 보간 재생. 그런데
 startHistoryChecker()도 동시에 시작되어 500ms마다 loadHistoryData()를 호출 시도 → 서버에 0.5초마다 /api/v1/history/ships 요청
 - 영향: 보간이 이미 처리하는 데이터를 또 요청함. 서버 부하 + 보간 엔티티와 스냅샷 엔티티가 중복 렌더링될 수 있음
 - 수정: 보간 모드에서는 historyChecker 비활성화 (시간 표시는 onTick 리스너가 이미 처리 중)

 4. DB 연결 실패 시 빈 배열 반환 (에러와 구별 불가)

 - 파일: backend/routers/history.py:60-63, 131-134, 191-193
 - 문제: DB pool이 없으면 return [] 또는 return {"ships": {}} — HTTP 200으로 빈 결과 반환
 - 영향: 프론트엔드가 "데이터 없음"과 "서버 에러"를 구별 못함
 - 수정: HTTP 503 반환

 5. fetch 타임아웃 없음 — 무한 대기 가능

 - 파일: static/index.html:739, 833, 855, 937
 - 문제: 모든 fetch() 호출에 timeout이 없음. 서버가 느리면 UI가 영구 정지
 - 영향: 히스토리 로딩 중 사용자가 무한 대기
 - 수정: AbortController + timeout 적용

 6. 히스토리 로드 실패 시 복구 불가

 - 파일: static/index.html:1032-1061
 - 문제: loadHistoryRange() 실패 시 에러 메시지만 표시하고 historyChecker 미시작. 사용자가 HISTORY 모드에 갇힘 (LIVE로 돌아가는 건 가능하지만 재시도 불가)
 - 수정: 에러 상태 표시 + 재시도 버튼 또는 자동 LIVE 복귀

 ---
 MEDIUM (데이터 정확성 / 안정성)

 7. 샘플링 레이스 컨디션

 - 파일: backend/services/history_writer.py:140-148
 - 문제: _last_record_time 읽기/쓰기가 _buffer_lock 바깥에서 발생. 동일 MMSI에 대한 동시 호출 시 30초 샘플링 제약이 우회될 수 있음
 - 수정: _last_record_time 접근도 lock 내부로 이동

 8. bulk trajectories 무제한 쿼리

 - 파일: backend/routers/history.py:180-254
 - 문제: limit_per_ship만 있고 전체 선박 수 제한 없음. 장기간 데이터에서 수천 척 × 20포인트 = 메모리 폭발 가능
 - 수정: 총 선박 수 제한 또는 전체 row 수 hard limit 추가

 9. NULL → 0 변환 불일치

 - 파일: backend/routers/history.py:245-246 vs :105-106
 - 문제: get_ships_at_time은 sog=None, heading=None 반환하지만, get_bulk_trajectories는 sog=0, heading=0 반환. heading 0은 "북쪽"이므로 의미가 다름
 - 수정: 모든 엔드포인트에서 None/null 통일

 10. 타임존 불일치 가능성

 - 파일: backend/services/history_writer.py:153
 - 문제: timestamp 파라미터가 naive datetime으로 들어올 수 있으나, 기본값은 UTC. naive datetime이 저장되면 조회 시 시간 불일치
 - 수정: timestamp에 tzinfo 없으면 UTC 가정하는 방어 로직

 ---
 LOW (품질 개선)

 11. 독스트링 오류 (±30초 vs 실제 ±60초)

 - 파일: backend/routers/history.py:56 vs :76
 - docstring은 "±30 seconds" 실제 쿼리는 INTERVAL '60 seconds'

 12. MMSI 유효성 검증 없음

 - 파일: backend/routers/history.py:121
 - 비숫자 MMSI 입력 시 조용히 빈 결과 반환

 13. shutdown 순서 문제

 - 파일: backend/main.py:69-81
 - AIS 스트림 먼저 중지 후 history_writer 중지 → 마지막 레코드 유실 가능성

 ---
 수정 계획 (우선순위순)

 Step 1: DB 스키마 수정 (Critical #1)

 - schema.sql에 ship_type VARCHAR(50) 추가
 - 운영 DB에 ALTER TABLE trajectories ADD COLUMN IF NOT EXISTS ship_type VARCHAR(50); 실행

 Step 2: 에러 로깅 추가 (Critical #2)

 - ais_stream.py의 except: pass → except Exception as e: logger.warning(f"history record failed: {e}")

 Step 3: historyChecker 충돌 해결 (High #3)

 - 보간 모드 사용 시 startHistoryChecker() 호출 제거
 - onTick 리스너가 시간 표시를 이미 담당하므로 중복 제거

 Step 4: API 에러 응답 개선 (High #4)

 - DB pool 없을 때 HTTPException(503) 반환

 Step 5: fetch 타임아웃 추가 (High #5)

 - 프론트엔드 fetch에 AbortController 10초 타임아웃

 Step 6: 에러 복구 UX (High #6)

 - 히스토리 로드 실패 시 자동 LIVE 모드 복귀 또는 재시도

 Step 7: 나머지 Medium/Low 이슈들

 - 샘플링 lock 수정, NULL 통일, 쿼리 제한, 타임존 방어

 ---
 검증 방법

 1. DB 스키마 수정 후 서버 기동 → history_writer flush 로그에 에러 없는지 확인
 2. AIS 데이터 수신 30초 후 SELECT COUNT(*) FROM trajectories; 로 레코드 적재 확인
 3. /api/v1/history/range 호출하여 min/max time 반환 확인
 4. 프론트엔드 HISTORY 모드 진입 → 선박 궤적 보간 재생 확인
 5. LIVE ↔ HISTORY 반복 전환 시 메모리 누수/중복 요청 없는지 브라우저 DevTools 확인
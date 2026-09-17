# 온톨로지 기반 판단 근거 조회

제안 탭의 각 카드에서 **왜 추적 대상으로 판단했나? / 판단 근거 / 판단 이후 변화**를 누르면 저장된 기록을 RDF 지식그래프로 연결해 조회합니다. 화면은 선박 쌍, 질문별 요약, 확인할 점, 연결된 기록, 관련 근거 목록 순서입니다. 관계는 실제 조회된 연결만 표시하며 처음 6개 이후는 더 보기로 펼칩니다.

근거의 **내용 확인**을 누르면 원본 지문을 확인한 뒤 기록의 의미와 한글 속성·수치·시각을 보여줍니다. JSON은 **원본 데이터 보기 · 기술 정보** 안에 접어 둡니다. RDF와 온톨로지·검증 규칙 TTL 파일은 화면 하단의 **개발·연동용 기술 정보**에서 다운로드합니다. 원문 API는 기존대로 제공하며 일반 운용 화면에서 파일을 먼저 열도록 안내하지 않습니다.

현재는 자유 입력 AI 채팅이 아니라 고정된 세 질문입니다. 서버가 로컬 SPARQL 파일을 실행하고 조회된 사실을 문장 템플릿으로 설명합니다. 실제로 기록되지 않은 판단 이유·실행 여부를 LLM으로 채우지 않습니다. 이 기반 위에 자연어 질문 분류를 추가할 수 있지만 아직 구현하지 않았습니다.

## 구조

```text
기존 SQLite 원본 (제안·검토·판단·비교·관측)
  → 선택 제안에 대한 읽기 전용 매핑
  → RDF 인스턴스 그래프
  → SHACL 형식·연결 검증
  → 고정 SPARQL 조회
  → 답변·원본·관계 UI
```

- `backend/ontology/maritime.ttl`: OWL 클래스·속성·관계 의미, 버전 1.1.0
- `backend/ontology/shapes.ttl`: SHACL 데이터·연결·시간 순서 제약
- `backend/ontology/queries/*.rq`: 세 질문의 SPARQL
- `backend/ontology/evidence.py`: 원본 매핑, 검증, 답변 생성
- `backend/routers/knowledge.py`: 읽기 전용 API
- `static/js/knowledge-evidence.js`: 질문과 원본 확인 UI

기존 DB가 원본이며 조회할 때 제안 단위 그래프를 메모리에 구성합니다. DB를 마이그레이션하거나 별도 그래프 DB를 설치하지 않습니다. 온톨로지 정의와 인스턴스 데이터는 별도 파일/API로 제공됩니다. OWL로 의미를 정의하지만 현재 조회 과정에서 OWL DL/RL 추론을 수행하지는 않습니다. 검증은 로컬 SHACL을 실행하며 외부 ontology import와 SHACL-JS는 사용하지 않습니다.

## 원본 해석 원칙

- MMSI로 선박 대상을 연결합니다. MMSI가 동일하다는 사실만으로 장기간 물리적 선박 동일성을 보장하지 않습니다.
- AIS 수신 관측과 수신 시각 없는 과거 분석 입력을 구별합니다. 분석 시각을 관측 시각으로 대신 넣지 않습니다.
- 시나리오의 공통 시작 시점으로 투영한 상태는 `ProjectedState`, 그 결과는 `Prediction`입니다. 원본 AIS 관측과 별도의 클래스로 표현합니다.
- 승인 근거는 `approval_evidence`, 당시 검토는 `decision.scenario_review_ids`만 사용합니다. 이후 추가된 검토는 제안의 전체 그래프에 남지만 과거 판단의 근거로 조회하지 않습니다.
- 과거 판단에 검토 ID 목록이 없으면 현재 목록으로 복원하지 않고 누락 안내를 표시합니다.
- 참조 비교가 없거나 다른 제안·선박 쌍에 속하면 연결하지 않습니다. SHACL 위반으로 결론을 보류합니다.
- 실행 요청과 브라우저 영수증을 구분합니다. 새 영수증 이벤트에는 `kind=execution_receipt`를 기록합니다. 과거 이벤트는 명확한 실행 확인/종료 사유만 영수증으로 매핑합니다. 검토가 추적 중 상태에서 작성됐다는 사실을 실행 확인으로 취급하지 않습니다.
- `after` 조회는 저장된 판단 시각 이후의 관측만 요약합니다. 수신 후 60초 초과 또는 관측 기간 종료 시 과거 값으로 표현하며 현재 위험 감소를 주장하지 않습니다. 거리 변화와 추적 조치의 인과관계도 주장하지 않습니다.
- 브라우저 `client_id`는 미인증 세션 식별값입니다. 인증된 운용자 신원으로 표현하지 않습니다.

## 범위와 검증

제안 1건, 최대 50개 검토, 관련 비교, 최신 60개 후속 평가를 포함합니다. 전체 후속 평가 중 제외된 수를 안내하며 기존 후속 확인 화면에서 더 넓은 이력을 볼 수 있습니다. 대규모 전역 관계 조회나 장기 선박 식별 통합은 이번 범위에 포함되지 않습니다.

SHACL 통과는 정의한 데이터 형식·연결 제약의 통과를 의미하며 AIS 정확도, 분석 모델 정확도, 운항 안전을 보증하지 않습니다. 검증 실패 시 답변 결론을 보류하고 위반 위치와 원본을 제공합니다. 합법적인 과거 기록 누락은 별도 안내와 함께 조회할 수 있습니다.

원본 확인은 외부 URL을 따라가지 않고 해당 제안에서 매핑한 노드만 허용합니다. 내용 지문을 함께 확인해 조회 후 변경된 원본을 조용히 대체하지 않습니다. 일반 JSON 위치는 JSON Pointer로, 후속 관측은 내용 해시 기반 선택자로 표시합니다. 파일/URL 입력이나 임의 SPARQL 입력은 제공하지 않습니다.

## API

- `GET /api/v1/knowledge/proposals/{pid}?question=why|basis|after`
- `GET /api/v1/knowledge/proposals/{pid}/source?node=...&fingerprint=...`
- `GET /api/v1/knowledge/proposals/{pid}/graph.ttl`
- `GET /api/v1/knowledge/schema.ttl`
- `GET /api/v1/knowledge/shapes.ttl`
- `GET /api/v1/proposals/{pid}/record`

RDF 다운로드는 Turtle의 부분집합인 N-Triples 표기를 사용합니다. 실수 값이 축약 과정에서 반올림되지 않도록 명시적 자료형을 유지합니다. 모든 엔드포인트는 기존 로컬 접근 모델을 따릅니다.

## 검증 실행

```bash
.venv/bin/python -m pytest tests/test_ontology_evidence.py tests/test_watch_officer.py tests/test_proposals_api.py -q
node --test tests/js/watch-officer.test.mjs
```

정상 원본, 누락/교차 제안 참조, 판단 이후 검토 혼입, 관측·예측 혼동, 시각 없는 과거 입력, 수신 지연, 원본 지문, 읽기 전용 동작, RDF 내보내기 정밀도를 검사합니다.

표준·라이브러리: [OWL 2](https://www.w3.org/TR/owl2-overview/), [SHACL](https://www.w3.org/TR/shacl/), [SPARQL 1.1](https://www.w3.org/TR/sparql11-query/), [pySHACL](https://github.com/RDFLib/pySHACL).

## AI 조사와 연결

사건별 조사와 제안 검증은 [AI 조사](ai-investigation.md)를 참고하세요. AI 조사 화면에서 승인한 경우, 승인 당시 조사 결과와 근거 스냅샷을 `Decision → usesInvestigation → AgentInvestigation` 관계로 조회할 수 있습니다.

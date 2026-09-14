# 당직사관 — 충돌 위험 조치 제안

충돌 분석(10초 주기)에서 **ML 등급 3** 또는 **DCPA < 0.3 nm & TCPA < 10분**인 쌍이 나오면 조치 제안 카드를 만든다.
운용자가 **승인**하면 조우 지점으로 카메라를 옮기고 두 선박 추적을 시작한다. **기각**은 사유(오탐·이미 조치·관망)와 함께 기록된다.

## 화면

충돌 패널 → **제안** 탭. 카드: 선박 쌍·등급 → 브리핑 → 근거 줄(클릭 시 근거 체인 드로어) → 승인/기각. 결정된 카드는 **기록**에 최근 20건.

## 규칙과 LLM

규칙(`backend/services/watch_officer.py`의 `RULES`)이 탐지와 조치를 결정한다. Ollama는 브리핑 문장을 2문장으로 다듬을 뿐이며,
수치·선박명·등급이 하나라도 빠지면 템플릿 문장을 유지한다. `WATCH_BRIEF_LLM=false`로 끌 수 있다.

## 근거 그래프

PROV-O + SOSA + `mos:` 어휘(`backend/data/mos.ttl`). 제안마다 `Observation ×2 → RiskAssessment → Encounter → Proposal (→ Decision)` 계보를
rdflib 인메모리 그래프에 넣고 `GET /api/v1/proposals/{id}/graph?format=turtle|json-ld`로 내보낸다. 추론기·트리플스토어 없음.

## 설정

| 변수 | 기본 | 의미 |
|---|---|---|
| `WATCH_DCPA_NM` | 0.3 | 거리 규칙 DCPA 임계 |
| `WATCH_TCPA_MIN` | 10 | 거리 규칙 TCPA 임계(분) |
| `WATCH_COOLDOWN_MIN` | 30 | 같은 쌍 재제안 억제(분) |
| `WATCH_BRIEF_LLM` | true | Ollama 브리핑 다듬기 |

## 저장

`backend/cache/proposals.jsonl` append. 재시작 시 복원하며 열려 있던 제안은 만료 처리.

## API

- `GET /api/v1/proposals?status=open&limit=50`
- `POST /api/v1/proposals/{id}/decision` `{"outcome":"approved"|"dismissed","reason":...}` — open이 아니면 409
- `GET /api/v1/proposals/{id}/graph?format=turtle|json-ld`

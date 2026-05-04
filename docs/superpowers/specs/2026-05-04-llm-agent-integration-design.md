# LLM Agent Integration Design

**Date:** 2026-05-04
**Scope:** Phase 1 - 채팅 UI + Tool-Calling Agent, Phase 2 - 요약 패널 + RAG
**Approach:** Tool-Calling + RAG 하이브리드 (C안)

---

## 1. 목표

Maritime OSINT Sentry에 경량 LLM을 도입하여:
- 자연어로 선박/해역 정보 질의
- 안전한 범위 내 지도 조작 (flyTo, filter)
- 충돌 위험 및 해역 상황 자동 요약 (Phase 2)
- 향후 에이전트 자율 모니터링으로 확장 (Phase 4)

## 2. 제약 조건

- 유료 API 없이 자체 호스팅 모델 사용
- 한국어 기본, 영어 지원
- 지도 조작은 flyTo, filter만 허용 (데이터 삭제/설정 변경 불가)
- 기존 EventBus 아키텍처와 통합
- 외부 프레임워크(LangChain 등) 없이 경량 구현

## 3. 전체 아키텍처

```
Frontend (Browser)
├── Chat UI (우측 사이드바 하단, 접이식)
├── Summary Panel (Phase 2, 좌측 상단 카드)
└── EventBus
    ├── chat:send, chat:response
    ├── summary:update
    └── command:flyTo, command:filter

        │ WebSocket / REST
        ▼

Backend (FastAPI)
├── POST /api/v1/chat → LLM Agent (Tool-Calling)
├── GET /api/v1/summary → LLM Agent (RAG, Phase 2)
└── LLM Agent
    ├── Tools: get_ships, get_collision_risks, get_area_status,
    │          fly_to, filter_ships, get_ship_detail
    └── DataService 접근 (ships, collision, aircraft, history)

        │ HTTP (Ollama API)
        ▼

LLM Server
├── 개발: Ollama (Qwen 2.5 7B, CPU)
└── 배포: vLLM (Qwen 2.5 72B, L40S x3)
```

## 4. LLM Agent 설계

### 4.1 모델 서빙

| 환경 | 도구 | 모델 | 하드웨어 |
|------|------|------|---------|
| 개발 | Ollama | Qwen 2.5 7B | WSL2, CPU |
| 배포 | vLLM | Qwen 2.5 72B | NVIDIA L40S x3 (46GB each) |

### 4.2 Agent 클래스

```python
# backend/services/llm_agent.py

class MaritimeAgent:
    """Tool-calling agent for maritime queries."""

    tools = [
        get_ships,           # 선박 조회 (area, type, mmsi)
        get_collision_risks, # 충돌 위험 목록 (area 선택)
        get_area_status,     # 해역 요약 (척수, 이상행동)
        fly_to,              # 지도 카메라 이동 (lat, lon)
        filter_ships,        # 선박 타입 필터 적용/해제
        get_ship_detail,     # 특정 선박 상세 정보 (mmsi)
    ]

    async def chat(self, user_message: str) -> AgentResponse:
        """Process user message, call tools, return response."""
        # 1. 시스템 프롬프트 + 도구 정의 + 사용자 메시지 → LLM
        # 2. LLM이 tool_call 반환 시 해당 도구 실행
        # 3. 도구 결과를 LLM에 피드백
        # 4. 최종 자연어 응답 + actions 반환
        pass
```

### 4.3 응답 구조

```json
{
    "text": "부산항 근처에 탱커 3척이 있고, 충돌 위험 1건 감지됨.",
    "actions": [
        {"type": "flyTo", "lat": 35.1, "lon": 129.0, "zoom": 12},
        {"type": "filter", "shipType": "tanker", "enabled": true}
    ]
}
```

### 4.4 안전 제약

- 허용 액션: `flyTo`, `filter` (읽기 + 안전한 뷰 조작만)
- 금지: 데이터 삭제, 설정 변경, 외부 API 호출
- 모든 tool 호출 로깅 (audit trail)
- 응답 길이 제한 (토큰 수 cap)

## 5. 프론트엔드

### 5.1 Chat UI

- 위치: 우측 사이드바 하단, 접이식 패널
- 구성: 메시지 목록 + 텍스트 입력 + 전송 버튼
- 메시지 렌더링: 마크다운 지원, 액션 실행 표시
- EventBus 연결:
  - `chat:send` → POST /api/v1/chat
  - 응답의 `actions[]` → `command:flyTo`, `command:filter` 등 발행
  - `chat:response` → UI 업데이트

### 5.2 Summary Panel (Phase 2)

- 위치: 좌측 상단 또는 하단바 옆 카드
- 갱신 주기: 30초~1분
- 내용:
  - 충돌 위험 건수 + 가장 긴급한 상황 한 줄 요약
  - 해역 전반 상태 (선박 수, 입출항, 이상행동)
- 통신: `GET /api/v1/summary` 또는 WebSocket 채널

## 6. 통신 흐름

### 6.1 채팅 (Phase 1)

```
User input → POST /api/v1/chat {message: "..."}
                    │
                    ▼
            MaritimeAgent.chat()
                    │
                    ├── LLM: tool_call(get_ships, {area: "busan", type: "tanker"})
                    │         → 실행 → 결과 반환
                    ├── LLM: tool_call(fly_to, {lat: 35.1, lon: 129.0})
                    │         → actions에 추가
                    ▼
            Response {text: "...", actions: [...]}
                    │
                    ▼
Frontend: actions.forEach → EventBus.emit('command:flyTo', ...)
          text → Chat UI 말풍선 추가
```

### 6.2 요약 (Phase 2)

```
Timer (30s) → GET /api/v1/summary
                    │
                    ▼
            MaritimeAgent.summarize()
                    │
                    ├── DataService에서 현재 상태 수집
                    ├── 충돌 위험 데이터 주입 (RAG)
                    ▼
            Response {summary: "...", urgency: "warning"}
                    │
                    ▼
Frontend: EventBus.emit('summary:update', data)
          → Summary Panel 갱신
```

## 7. 기술 스택

| 구성요소 | 개발 | 배포 |
|---------|------|------|
| LLM 서빙 | Ollama (Qwen 2.5 7B) | vLLM (Qwen 2.5 72B) |
| Agent | 자체 구현 (경량 래퍼) | 동일 |
| 백엔드 | FastAPI (기존) | 동일 |
| 프론트 | vanilla JS (기존) | 동일 |
| 통신 | REST + WebSocket | 동일 |

## 8. Phase 로드맵

| Phase | 내용 | 데이터 범위 |
|-------|------|------------|
| 1 | 채팅 UI + Tool-Calling Agent | 실시간 데이터만 |
| 2 | 요약 패널 + RAG | 실시간 데이터 |
| 3 | 과거 이력 + 외부 지식 접근 | 실시간 + 히스토리 + 항만 DB |
| 4 | 에이전트 자율 모니터링 | 전체 (이상탐지 → 자동 분석 → 알림) |

## 9. Phase 1 태스크 (구현 범위)

1. Ollama 설치 + Qwen 2.5 7B 모델 로드
2. `backend/services/llm_agent.py` — Agent 클래스 + Tool 정의
3. `backend/routers/chat.py` — POST /api/v1/chat 엔드포인트
4. 프론트엔드 Chat UI 컴포넌트 (`static/js/chat.js`, CSS)
5. EventBus 연결 (actions → command:flyTo, command:filter)
6. 한국어 시스템 프롬프트 작성 및 튜닝

## 10. 시스템 프롬프트 (초안)

```
당신은 해양 상황 인식 시스템의 AI 어시스턴트입니다.
사용자의 질문에 한국어로 답변하며, 필요시 영어도 지원합니다.

역할:
- 선박 위치, 종류, 상태 정보 제공
- 충돌 위험 상황 설명
- 해역 전반 상황 요약
- 지도 카메라 이동 및 필터 적용 (요청 시)

제약:
- 확인되지 않은 정보는 추측하지 않습니다
- 데이터가 없으면 "현재 데이터가 없습니다"라고 답합니다
- 지도 조작은 이동과 필터만 가능합니다
```

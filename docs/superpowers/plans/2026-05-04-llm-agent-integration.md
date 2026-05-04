# LLM Agent Integration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자연어 채팅으로 선박/해역 정보를 질의하고 안전한 지도 조작을 수행하는 LLM Agent 도입

**Architecture:** Ollama(Qwen 2.5 7B) → FastAPI Agent 서비스 → Tool-Calling → REST/WebSocket 응답. 프론트엔드는 접이식 Chat UI에서 EventBus를 통해 지도 조작 액션을 발행.

**Tech Stack:** Ollama, Qwen 2.5 7B, FastAPI, httpx (Ollama API 통신), vanilla JS

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `backend/services/llm_agent.py` | Agent 클래스, tool 정의, Ollama API 호출 |
| Create | `backend/services/llm_tools.py` | Tool 함수들 (get_ships, get_collision_risks, etc.) |
| Create | `backend/routers/chat.py` | POST /api/v1/chat 엔드포인트 |
| Modify | `backend/main.py:164-177` | chat router 등록 |
| Create | `backend/config_llm.py` | LLM 관련 설정값 (모델명, URL, 프롬프트) |
| Create | `static/js/chat.js` | Chat UI 컴포넌트 + EventBus 연결 |
| Modify | `static/css/main.css` | Chat UI 스타일 |
| Modify | `static/index.html` | Chat UI HTML 컨테이너 + script 태그 |

---

### Task 1: Ollama 설정 및 Config

**Files:**
- Create: `backend/config_llm.py`

- [ ] **Step 1: Ollama 설치 확인**

Run: `ollama --version`
If not installed: `curl -fsSL https://ollama.com/install.sh | sh`

- [ ] **Step 2: Qwen 2.5 7B 모델 다운로드**

Run: `ollama pull qwen2.5:7b`
Expected: model download completes

- [ ] **Step 3: Ollama 서버 시작 확인**

Run: `ollama serve &` (이미 실행 중이면 skip)
Run: `curl http://localhost:11434/api/tags`
Expected: JSON with qwen2.5:7b in models list

- [ ] **Step 4: LLM config 파일 작성**

```python
# backend/config_llm.py
"""LLM Agent configuration."""

OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_MODEL = "qwen2.5:7b"
OLLAMA_TIMEOUT = 60  # seconds

SYSTEM_PROMPT = """당신은 해양 상황 인식 시스템의 AI 어시스턴트입니다.
사용자의 질문에 한국어로 답변하며, 필요시 영어도 지원합니다.

역할:
- 선박 위치, 종류, 상태 정보 제공
- 충돌 위험 상황 설명
- 해역 전반 상황 요약
- 지도 카메라 이동 및 필터 적용 (요청 시)

제약:
- 확인되지 않은 정보는 추측하지 않습니다
- 데이터가 없으면 "현재 데이터가 없습니다"라고 답합니다
- 지도 조작은 이동(flyTo)과 필터(filter)만 가능합니다

도구 사용 규칙:
- 사용자가 특정 선박이나 해역을 언급하면 관련 도구를 호출하세요
- 지도 이동이 필요한 경우 fly_to 도구를 사용하세요
- 여러 도구를 조합해 종합적인 답변을 제공하세요"""

MAX_RESPONSE_TOKENS = 1024
MAX_TOOL_CALLS = 5  # 한 요청당 최대 tool 호출 횟수
```

- [ ] **Step 5: Commit**

```bash
git add -f backend/config_llm.py
git commit -m "feat(llm): add Ollama config and system prompt"
```

---

### Task 2: Tool 함수 정의

**Files:**
- Create: `backend/services/llm_tools.py`

- [ ] **Step 1: Tool 함수 구현**

```python
# backend/services/llm_tools.py
"""Tool functions for the Maritime LLM Agent."""

from backend.services.ais_stream import get_ais_vessels
from backend.services.collision_analyzer import get_distance_risks, get_ml_risks

# 한국 주요 항만 좌표
KNOWN_AREAS = {
    "busan": {"lat": 35.1, "lon": 129.05, "name": "부산항"},
    "incheon": {"lat": 37.45, "lon": 126.6, "name": "인천항"},
    "ulsan": {"lat": 35.5, "lon": 129.38, "name": "울산항"},
    "gwangyang": {"lat": 34.9, "lon": 127.7, "name": "광양항"},
    "pyeongtaek": {"lat": 36.97, "lon": 126.83, "name": "평택항"},
    "mokpo": {"lat": 34.78, "lon": 126.38, "name": "목포항"},
    "jeju": {"lat": 33.52, "lon": 126.53, "name": "제주항"},
}

# Tool definitions for Ollama tool-calling format
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_ships",
            "description": "현재 추적 중인 선박 목록을 조회합니다. 타입이나 영역으로 필터 가능.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ship_type": {
                        "type": "string",
                        "description": "선박 타입 필터 (cargo, tanker, passenger, fishing, military, tug, other)",
                        "enum": ["cargo", "tanker", "passenger", "fishing", "military", "tug", "other"]
                    },
                    "area": {
                        "type": "string",
                        "description": "해역/항만 이름 (busan, incheon, ulsan, gwangyang, pyeongtaek, mokpo, jeju)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "반환할 최대 선박 수 (기본 10)",
                        "default": 10
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_collision_risks",
            "description": "현재 충돌 위험이 감지된 선박 쌍 목록을 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_area_status",
            "description": "특정 해역의 전반적인 상황을 요약합니다 (선박 수, 타입 분포).",
            "parameters": {
                "type": "object",
                "properties": {
                    "area": {
                        "type": "string",
                        "description": "해역/항만 이름 (busan, incheon, ulsan, gwangyang, pyeongtaek, mokpo, jeju)"
                    }
                },
                "required": ["area"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "fly_to",
            "description": "지도 카메라를 특정 좌표로 이동합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "lat": {"type": "number", "description": "위도"},
                    "lon": {"type": "number", "description": "경도"},
                    "area": {
                        "type": "string",
                        "description": "항만 이름 (좌표 대신 사용 가능)"
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "filter_ships",
            "description": "지도에서 특정 타입의 선박만 표시하거나 필터를 해제합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ship_type": {
                        "type": "string",
                        "description": "필터할 선박 타입",
                        "enum": ["cargo", "tanker", "passenger", "fishing", "military", "tug", "other", "all"]
                    }
                },
                "required": ["ship_type"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_ship_detail",
            "description": "특정 선박의 상세 정보를 조회합니다 (MMSI로 검색).",
            "parameters": {
                "type": "object",
                "properties": {
                    "mmsi": {"type": "integer", "description": "선박 MMSI 번호"},
                    "name": {"type": "string", "description": "선박명 (부분 일치 검색)"}
                },
                "required": []
            }
        }
    }
]


def _haversine_distance(lat1, lon1, lat2, lon2):
    """두 좌표 간 거리 (nm)."""
    import math
    R = 3440.065  # Earth radius in nautical miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def execute_tool(name: str, arguments: dict) -> dict:
    """Execute a tool by name and return the result."""
    if name == "get_ships":
        return _tool_get_ships(arguments)
    elif name == "get_collision_risks":
        return _tool_get_collision_risks(arguments)
    elif name == "get_area_status":
        return _tool_get_area_status(arguments)
    elif name == "fly_to":
        return _tool_fly_to(arguments)
    elif name == "filter_ships":
        return _tool_filter_ships(arguments)
    elif name == "get_ship_detail":
        return _tool_get_ship_detail(arguments)
    else:
        return {"error": f"Unknown tool: {name}"}


def _tool_get_ships(args: dict) -> dict:
    ships = get_ais_vessels()
    ship_type = args.get("ship_type")
    area = args.get("area")
    limit = args.get("limit", 10)

    if ship_type:
        ships = [s for s in ships if s.get("type") == ship_type]

    if area and area in KNOWN_AREAS:
        center = KNOWN_AREAS[area]
        ships = [
            s for s in ships
            if _haversine_distance(center["lat"], center["lon"], s["lat"], s["lon"]) < 20
        ]

    ships = ships[:limit]
    return {
        "count": len(ships),
        "ships": [
            {
                "name": s.get("name", "Unknown"),
                "mmsi": s.get("mmsi"),
                "type": s.get("type"),
                "lat": s.get("lat"),
                "lon": s.get("lon"),
                "speed": s.get("speed"),
                "status": s.get("status", ""),
            }
            for s in ships
        ]
    }


def _tool_get_collision_risks(args: dict) -> dict:
    distance_risks = get_distance_risks()
    ml_risks = get_ml_risks()
    return {
        "distance_risks": len(distance_risks),
        "ml_risks": len(ml_risks),
        "top_risks": distance_risks[:5]
    }


def _tool_get_area_status(args: dict) -> dict:
    area = args.get("area", "")
    if area not in KNOWN_AREAS:
        return {"error": f"알 수 없는 해역: {area}. 사용 가능: {list(KNOWN_AREAS.keys())}"}

    center = KNOWN_AREAS[area]
    ships = get_ais_vessels()
    nearby = [
        s for s in ships
        if _haversine_distance(center["lat"], center["lon"], s["lat"], s["lon"]) < 20
    ]

    type_counts = {}
    for s in nearby:
        t = s.get("type", "other")
        type_counts[t] = type_counts.get(t, 0) + 1

    return {
        "area": center["name"],
        "total_ships": len(nearby),
        "type_distribution": type_counts,
        "center": {"lat": center["lat"], "lon": center["lon"]}
    }


def _tool_fly_to(args: dict) -> dict:
    area = args.get("area")
    if area and area in KNOWN_AREAS:
        center = KNOWN_AREAS[area]
        return {"action": "flyTo", "lat": center["lat"], "lon": center["lon"], "name": center["name"]}
    lat = args.get("lat")
    lon = args.get("lon")
    if lat is not None and lon is not None:
        return {"action": "flyTo", "lat": lat, "lon": lon}
    return {"error": "좌표 또는 항만 이름이 필요합니다."}


def _tool_filter_ships(args: dict) -> dict:
    ship_type = args.get("ship_type", "all")
    return {"action": "filter", "ship_type": ship_type}


def _tool_get_ship_detail(args: dict) -> dict:
    ships = get_ais_vessels()
    mmsi = args.get("mmsi")
    name = args.get("name", "").lower()

    if mmsi:
        found = [s for s in ships if s.get("mmsi") == mmsi]
    elif name:
        found = [s for s in ships if name in s.get("name", "").lower()]
    else:
        return {"error": "MMSI 또는 선박명이 필요합니다."}

    if not found:
        return {"error": "해당 선박을 찾을 수 없습니다."}

    s = found[0]
    return {
        "name": s.get("name", "Unknown"),
        "mmsi": s.get("mmsi"),
        "type": s.get("type"),
        "lat": s.get("lat"),
        "lon": s.get("lon"),
        "speed": s.get("speed"),
        "course": s.get("course"),
        "heading": s.get("heading"),
        "status": s.get("status", ""),
        "destination": s.get("destination", ""),
        "length": s.get("length"),
        "beam": s.get("beam"),
    }
```

- [ ] **Step 2: Commit**

```bash
git add -f backend/services/llm_tools.py
git commit -m "feat(llm): add tool definitions and executor functions"
```

---

### Task 3: LLM Agent 서비스

**Files:**
- Create: `backend/services/llm_agent.py`

- [ ] **Step 1: Agent 구현**

```python
# backend/services/llm_agent.py
"""Maritime LLM Agent — Tool-calling agent using Ollama."""

import json
import logging
import httpx

from backend.config_llm import (
    OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT,
    SYSTEM_PROMPT, MAX_RESPONSE_TOKENS, MAX_TOOL_CALLS
)
from backend.services.llm_tools import TOOL_DEFINITIONS, execute_tool

logger = logging.getLogger(__name__)


async def chat(user_message: str, history: list = None) -> dict:
    """Process a user message through the LLM agent.

    Returns:
        {
            "text": "자연어 응답",
            "actions": [{"type": "flyTo", ...}, ...]
        }
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if history:
        messages.extend(history[-10:])  # 최근 10개 대화만 유지

    messages.append({"role": "user", "content": user_message})

    actions = []
    tool_call_count = 0

    async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
        while tool_call_count < MAX_TOOL_CALLS:
            response = await _call_ollama(client, messages)

            if response is None:
                return {"text": "죄송합니다, 응답을 생성할 수 없습니다.", "actions": []}

            message = response.get("message", {})

            # Check if LLM wants to call tools
            tool_calls = message.get("tool_calls")
            if not tool_calls:
                # No more tool calls — final text response
                text = message.get("content", "")
                return {"text": text, "actions": actions}

            # Execute tool calls
            messages.append(message)  # Add assistant message with tool_calls

            for tc in tool_calls:
                fn = tc.get("function", {})
                tool_name = fn.get("name", "")
                tool_args = fn.get("arguments", {})

                logger.info(f"Tool call: {tool_name}({tool_args})")
                result = execute_tool(tool_name, tool_args)

                # Collect actions (flyTo, filter)
                if isinstance(result, dict) and "action" in result:
                    actions.append(result)

                # Feed result back to LLM
                messages.append({
                    "role": "tool",
                    "content": json.dumps(result, ensure_ascii=False)
                })

                tool_call_count += 1

    # If max tool calls reached, get final response without tools
    response = await _call_ollama(
        httpx.AsyncClient(timeout=OLLAMA_TIMEOUT), messages, tools=False
    )
    text = response.get("message", {}).get("content", "") if response else ""
    return {"text": text, "actions": actions}


async def _call_ollama(client: httpx.AsyncClient, messages: list, tools: bool = True) -> dict | None:
    """Call Ollama chat API."""
    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {
            "num_predict": MAX_RESPONSE_TOKENS
        }
    }

    if tools:
        payload["tools"] = TOOL_DEFINITIONS

    try:
        resp = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        logger.error("Ollama request timed out")
        return None
    except httpx.HTTPStatusError as e:
        logger.error(f"Ollama HTTP error: {e.response.status_code}")
        return None
    except Exception as e:
        logger.error(f"Ollama request failed: {e}")
        return None
```

- [ ] **Step 2: Commit**

```bash
git add -f backend/services/llm_agent.py
git commit -m "feat(llm): implement MaritimeAgent with Ollama tool-calling"
```

---

### Task 4: Chat API 엔드포인트

**Files:**
- Create: `backend/routers/chat.py`
- Modify: `backend/main.py:12` (import)
- Modify: `backend/main.py:177` (router 등록)

- [ ] **Step 1: Chat router 작성**

```python
# backend/routers/chat.py
"""Chat API endpoint for LLM agent interaction."""

from fastapi import APIRouter
from pydantic import BaseModel
import logging

from backend.services import llm_agent

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    history: list = []


class ChatResponse(BaseModel):
    text: str
    actions: list = []


@router.post("/chat", response_model=ChatResponse)
async def post_chat(req: ChatRequest):
    """Process a chat message through the maritime LLM agent."""
    result = await llm_agent.chat(req.message, req.history)
    return ChatResponse(text=result["text"], actions=result["actions"])
```

- [ ] **Step 2: main.py에 router 등록**

`backend/main.py` 수정:

Line 12 — import에 추가:
```python
from .routers import ships, satellites, events, data, sentinel, alerts, history, metrics, health, collision, weather, route, aircraft, chat
```

Line 177 뒤에 추가:
```python
app.include_router(chat.router, prefix="/api/v1")
```

- [ ] **Step 3: 동작 테스트**

Run: `curl -X POST http://localhost:8000/api/v1/chat -H "Content-Type: application/json" -d '{"message": "현재 추적 중인 선박 몇 척이야?"}'`

Expected: JSON response with `text` and `actions` fields

- [ ] **Step 4: Commit**

```bash
git add -f backend/routers/chat.py backend/main.py
git commit -m "feat(llm): add POST /api/v1/chat endpoint"
```

---

### Task 5: 프론트엔드 Chat UI

**Files:**
- Create: `static/js/chat.js`
- Modify: `static/css/main.css` (하단에 chat 스타일 추가)
- Modify: `static/index.html` (chat 컨테이너 + script 태그)

- [ ] **Step 1: Chat UI JavaScript**

```javascript
// static/js/chat.js
// ── Chat UI — LLM Agent interaction panel ──
var ChatUI = (function () {
    'use strict';

    var panel = null;
    var messagesEl = null;
    var inputEl = null;
    var history = [];
    var isOpen = false;
    var isLoading = false;

    function init() {
        panel = document.getElementById('chat-panel');
        messagesEl = document.getElementById('chat-messages');
        inputEl = document.getElementById('chat-input');

        if (!panel) return;

        // Toggle button
        var toggleBtn = document.getElementById('chat-toggle-btn');
        if (toggleBtn) toggleBtn.addEventListener('click', toggle);

        // Send button
        var sendBtn = document.getElementById('chat-send-btn');
        if (sendBtn) sendBtn.addEventListener('click', send);

        // Enter key
        if (inputEl) {
            inputEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                }
            });
        }
    }

    function toggle() {
        isOpen = !isOpen;
        panel.classList.toggle('chat-panel-open', isOpen);
    }

    function send() {
        if (isLoading || !inputEl) return;
        var msg = inputEl.value.trim();
        if (!msg) return;

        inputEl.value = '';
        _appendMessage('user', msg);
        history.push({ role: 'user', content: msg });

        isLoading = true;
        _showTyping();

        fetch('/api/v1/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: history.slice(-10) })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                _hideTyping();
                isLoading = false;

                _appendMessage('assistant', data.text);
                history.push({ role: 'assistant', content: data.text });

                // Execute actions via EventBus
                if (data.actions && data.actions.length) {
                    data.actions.forEach(function (action) {
                        if (action.action === 'flyTo') {
                            EventBus.emit('command:flyTo', {
                                lat: action.lat,
                                lon: action.lon,
                                zoom: action.zoom
                            });
                        } else if (action.action === 'filter') {
                            EventBus.emit('command:filter', {
                                shipType: action.ship_type
                            });
                        }
                    });
                }
            })
            .catch(function (err) {
                _hideTyping();
                isLoading = false;
                _appendMessage('assistant', '오류가 발생했습니다. 다시 시도해주세요.');
            });
    }

    function _appendMessage(role, text) {
        var div = document.createElement('div');
        div.className = 'chat-msg chat-msg-' + role;
        div.textContent = text;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function _showTyping() {
        var div = document.createElement('div');
        div.className = 'chat-msg chat-msg-typing';
        div.id = 'chat-typing';
        div.textContent = '생각 중...';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function _hideTyping() {
        var el = document.getElementById('chat-typing');
        if (el) el.parentNode.removeChild(el);
    }

    return { init: init, toggle: toggle };
})();

// Initialize when DOM ready
document.addEventListener('DOMContentLoaded', function () {
    ChatUI.init();
});
```

- [ ] **Step 2: Chat HTML 컨테이너 추가**

`static/index.html`에 우측 사이드바 하단 또는 body 끝에 추가:

```html
<!-- Chat Panel -->
<div id="chat-panel" class="chat-panel">
    <div class="chat-panel-header" id="chat-toggle-btn">
        <span class="chat-panel-title">AI 어시스턴트</span>
        <span class="chat-panel-toggle-icon">&#9650;</span>
    </div>
    <div class="chat-panel-body">
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-row">
            <input type="text" id="chat-input" class="chat-input" placeholder="질문을 입력하세요..." autocomplete="off" />
            <button id="chat-send-btn" class="chat-send-btn" title="전송">
                <i class="fa fa-paper-plane"></i>
            </button>
        </div>
    </div>
</div>
```

`static/index.html` script 태그에 추가 (event-bus.js, data-service.js 뒤):
```html
<script src="js/chat.js"></script>
```

- [ ] **Step 3: Chat CSS 스타일**

`static/css/main.css` 하단에 추가:

```css
/* ── Chat Panel ── */
.chat-panel {
    position: fixed;
    bottom: 0;
    right: 16px;
    width: 340px;
    max-height: 48px;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-bottom: none;
    border-radius: 12px 12px 0 0;
    backdrop-filter: blur(16px);
    z-index: 1100;
    transition: max-height 0.3s ease;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.chat-panel-open {
    max-height: 420px;
}

.chat-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
}

.chat-panel-title {
    font-family: 'Pretendard Variable', 'Inter', sans-serif;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-main);
}

.chat-panel-toggle-icon {
    font-size: 0.6rem;
    color: var(--text-sub);
    transition: transform 0.3s ease;
}

.chat-panel-open .chat-panel-toggle-icon {
    transform: rotate(180deg);
}

.chat-panel-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 0 12px 12px;
}

.chat-messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0;
    min-height: 0;
}

.chat-msg {
    font-family: 'Pretendard Variable', 'Inter', sans-serif;
    font-size: 0.75rem;
    line-height: 1.5;
    padding: 8px 12px;
    border-radius: 10px;
    max-width: 85%;
    word-break: break-word;
}

.chat-msg-user {
    align-self: flex-end;
    background: rgba(59, 130, 246, 0.2);
    color: var(--text-main);
}

.chat-msg-assistant {
    align-self: flex-start;
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-sub);
}

.chat-msg-typing {
    align-self: flex-start;
    color: var(--text-dim);
    font-style: italic;
    font-size: 0.7rem;
}

.chat-input-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
}

.chat-input {
    flex: 1;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    padding: 8px 12px;
    font-family: 'Pretendard Variable', 'Inter', sans-serif;
    font-size: 0.75rem;
    color: var(--text-main);
    outline: none;
    transition: border-color 0.2s;
}

.chat-input:focus {
    border-color: var(--accent);
}

.chat-send-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    transition: opacity 0.2s;
}

.chat-send-btn:hover {
    opacity: 0.85;
}
```

- [ ] **Step 4: Commit**

```bash
git add static/js/chat.js static/css/main.css static/index.html
git commit -m "feat(llm): add Chat UI panel with EventBus action dispatch"
```

---

### Task 6: EventBus 연결 — command:filter 핸들러

**Files:**
- Modify: `static/js/ui-controls.js` (또는 적절한 위치)

- [ ] **Step 1: filter 이벤트 핸들러 추가**

`static/js/ui-controls.js` 하단 EventBus 구독부에 추가:

```javascript
EventBus.on('command:filter', function (data) {
    var type = data.shipType;
    if (!type) return;

    // 'all'이면 모든 필터 해제
    var chips = document.querySelectorAll('.layer-chip[data-type]');
    chips.forEach(function (chip) {
        if (type === 'all') {
            chip.classList.add('active');
        } else {
            chip.classList.toggle('active', chip.dataset.type === type);
        }
    });

    // 기존 필터 토글 로직 트리거
    if (typeof applyShipFilters === 'function') {
        applyShipFilters();
    }
});
```

- [ ] **Step 2: Commit**

```bash
git add static/js/ui-controls.js
git commit -m "feat(llm): add command:filter EventBus handler for chat actions"
```

---

### Task 7: 통합 테스트 및 최종 확인

**Files:** (수정 없음 — 테스트만)

- [ ] **Step 1: 백엔드 서버 시작**

Run: `cd /home/yhlee/4dwar && python -m uvicorn backend.main:app --reload --port 8000`

- [ ] **Step 2: Ollama 실행 확인**

Run: `ollama list` — qwen2.5:7b 모델 확인
Run: `curl http://localhost:11434/api/tags` — 서버 응답 확인

- [ ] **Step 3: Chat API 테스트**

```bash
curl -X POST http://localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "현재 추적 중인 선박이 몇 척이야?"}'
```

Expected: `{"text": "현재 ... 척의 선박이 추적되고 있습니다.", "actions": []}`

```bash
curl -X POST http://localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "부산항으로 이동해줘"}'
```

Expected: `{"text": "부산항으로 이동합니다.", "actions": [{"action": "flyTo", "lat": 35.1, "lon": 129.05, ...}]}`

- [ ] **Step 4: 브라우저에서 Chat UI 확인**

1. http://localhost:8000 접속
2. 우측 하단 "AI 어시스턴트" 클릭 → 패널 열림
3. "부산항 근처 선박 보여줘" 입력 → 응답 + 지도 이동 확인

- [ ] **Step 5: 최종 커밋 (필요시)**

```bash
git add -A
git commit -m "feat(llm): Phase 1 complete — chat UI with tool-calling agent"
```

---

## Dependencies

- `httpx` — 이미 설치됨 (requirements에 있음)
- `ollama` — 시스템에 설치 필요 (Task 1)
- 추가 pip 패키지 없음

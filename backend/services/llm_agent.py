"""
Maritime OSINT LLM Agent — Ollama tool-calling implementation.

Wraps Ollama's /api/chat endpoint with iterative tool-call resolution,
collecting frontend actions (flyTo, filter) from tool results.
"""

import json
import logging
from typing import Any

import httpx

from backend.config_llm import (
    OLLAMA_BASE_URL,
    OLLAMA_MODEL,
    OLLAMA_TIMEOUT,
    SYSTEM_PROMPT,
    MAX_RESPONSE_TOKENS,
    MAX_TOOL_CALLS,
)
from backend.services.llm_tools import TOOL_DEFINITIONS, execute_tool

logger = logging.getLogger(__name__)

# Module-level httpx client — reuses connection pool across all chat requests.
# Lazy-initialized on first use; lives for process lifetime (acceptable for a long-running server).
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Return the shared httpx client, creating it on first call."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=OLLAMA_TIMEOUT)
    return _http_client


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_context_message(context: dict | None) -> str | None:
    """Render the frontend state snapshot as a short Korean system reminder.

    Returns None when there's no useful context to inject. The frontend sends
    this every turn so the LLM knows what '이 배' / '현재 선박' refers to —
    without it, the model hallucinates ship names from chat history.
    """
    if not context:
        return None

    # 항로/사고 화면 상태 — roll_viewer가 없어도 단독으로 안내할 수 있다.
    extra: list[str] = []
    route = context.get("route")
    if route and route.get("active"):
        frm = route.get("from") or "미지정"
        to = route.get("to") or "미지정"
        extra.append(
            f"[현재 화면 상태] 항로(경로 추론) 화면이 열려 있습니다. 출발지='{frm}', "
            f"도착지='{to}', 선박 크기 등급={route.get('size_class', 'C')}. "
            "사용자가 '여기서/지금 화면에서 경로' 같이 말하면 이 상태를 기준으로 plan_route를 호출하세요."
        )
    if context.get("hazard_zones_active"):
        extra.append("현재 지도에 사고 위험구역 오버레이가 켜져 있습니다.")

    rv = context.get("roll_viewer")
    if not rv:
        return " ".join(extra) if extra else None
    name = rv.get("name") or "UNKNOWN"
    mmsi = rv.get("mmsi", "?")
    parts = [
        f"[현재 화면 상태] 횡요각 시뮬레이션 화면이 열려 있고, 표시 중인 선박은 "
        f"'{name}' (MMSI {mmsi}) 입니다."
    ]
    if rv.get("is_capsizing"):
        parts.append("현재 전복 시뮬레이션이 진행 중입니다.")
    if rv.get("is_turning"):
        parts.append("현재 선회 시나리오가 활성화되어 있습니다.")
    parts.append(
        "사용자가 '이 배', '현재 선박', '이 선박', '얘'처럼 지시 표현을 쓰면 "
        "반드시 위 선박을 의미합니다 — 다른 선박 이름을 추측하지 마세요. "
        "또한 화면이 이미 열려 있으므로 '횡요각 화면을 먼저 열어주세요' 같은 안내는 하지 마세요."
    )
    return " ".join(extra + parts)


def _build_initial_messages(
    user_message: str,
    history: list | None,
    context: dict | None = None,
) -> list[dict]:
    """Construct the messages list: system + trimmed history + context + new user turn."""
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    if history:
        # Keep only the last 10 history entries to avoid context overflow
        trimmed = history[-10:]
        messages.extend(trimmed)

    ctx_msg = _build_context_message(context)
    if ctx_msg:
        messages.append({"role": "system", "content": ctx_msg})

    messages.append({"role": "user", "content": user_message})
    return messages


def _extract_tool_calls(message: dict) -> list[dict]:
    """Return the tool_calls list from an Ollama message, or empty list."""
    return message.get("tool_calls") or []


async def _call_ollama(client: httpx.AsyncClient, messages: list[dict]) -> dict:
    """POST to Ollama /api/chat and return the parsed response dict."""
    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "tools": TOOL_DEFINITIONS,
        "stream": False,
        "keep_alive": -1,  # keep model loaded indefinitely → no cold-start between calls
        "options": {
            "num_predict": MAX_RESPONSE_TOKENS,
        },
    }

    response = await client.post(
        f"{OLLAMA_BASE_URL}/api/chat",
        json=payload,
        timeout=OLLAMA_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

async def chat(user_message: str, history: list = None, context: dict = None) -> dict:
    """Run a single user turn through the Maritime OSINT agent.

    Iteratively resolves tool calls (up to MAX_TOOL_CALLS) before returning
    the final text response. Frontend actions (flyTo, filter) are collected
    from tool results that contain an "action" key.

    Args:
        user_message: The user's natural-language query.
        history: Optional list of prior {role, content} message dicts.
                 Only the last 10 entries are kept to cap context size.

    Returns:
        {
            "text":    str   — final assistant response text,
            "actions": list  — list of frontend action dicts (may be empty),
        }
    """
    messages = _build_initial_messages(user_message, history, context)
    actions: list[dict[str, Any]] = []
    tool_call_count = 0

    try:
        client = _get_client()
        if True:  # preserved indentation level so the inner block stays untouched
            while True:
                # --- Call Ollama ---
                try:
                    response_data = await _call_ollama(client, messages)
                except httpx.TimeoutException:
                    logger.error(
                        "Ollama request timed out after %s seconds", OLLAMA_TIMEOUT
                    )
                    return {
                        "text": "요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
                        "actions": actions,
                    }
                except httpx.HTTPStatusError as exc:
                    logger.error(
                        "Ollama HTTP error %s: %s", exc.response.status_code, exc
                    )
                    return {
                        "text": f"AI 서비스 오류가 발생했습니다 (HTTP {exc.response.status_code}).",
                        "actions": actions,
                    }
                except httpx.RequestError as exc:
                    logger.error("Ollama connection error: %s", exc)
                    return {
                        "text": "AI 서비스에 연결할 수 없습니다. 서버 상태를 확인해 주세요.",
                        "actions": actions,
                    }

                # --- Parse assistant message ---
                assistant_message: dict = response_data.get("message", {})
                tool_calls = _extract_tool_calls(assistant_message)

                # Append assistant turn to conversation
                messages.append(assistant_message)

                # --- No tool calls → final answer ---
                if not tool_calls:
                    final_text: str = assistant_message.get("content", "")
                    logger.debug(
                        "Agent finished after %d tool call(s)", tool_call_count
                    )
                    return {"text": final_text, "actions": actions}

                # --- Guard against runaway loops ---
                if tool_call_count >= MAX_TOOL_CALLS:
                    logger.warning(
                        "MAX_TOOL_CALLS (%d) reached; returning partial response",
                        MAX_TOOL_CALLS,
                    )
                    partial_text: str = assistant_message.get("content", "")
                    if not partial_text:
                        partial_text = (
                            "도구 호출 한도에 도달했습니다. "
                            "지금까지 수집된 정보를 바탕으로 답변드립니다."
                        )
                    return {"text": partial_text, "actions": actions}

                # --- Execute each tool call ---
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    tool_name: str = fn.get("name", "")
                    tool_args: dict = fn.get("arguments", {})

                    # arguments may arrive as a JSON string from some Ollama builds
                    if isinstance(tool_args, str):
                        try:
                            tool_args = json.loads(tool_args)
                        except json.JSONDecodeError:
                            logger.warning(
                                "Could not parse tool arguments as JSON for '%s': %r",
                                tool_name,
                                tool_args,
                            )
                            tool_args = {}

                    logger.info(
                        "Tool call #%d — name=%r args=%s",
                        tool_call_count + 1,
                        tool_name,
                        json.dumps(tool_args, ensure_ascii=False),
                    )

                    result: dict = execute_tool(tool_name, tool_args)
                    tool_call_count += 1

                    # Collect frontend actions
                    if "action" in result:
                        actions.append(result)
                        logger.debug(
                            "Action collected: type=%r", result["action"]
                        )

                    # Append tool result to conversation
                    messages.append({
                        "role": "tool",
                        "content": json.dumps(result, ensure_ascii=False),
                    })

                # Loop back to call Ollama with the tool results appended

    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Unexpected error in MaritimeAgent.chat: %s", exc)
        return {
            "text": "예상치 못한 오류가 발생했습니다. 관리자에게 문의해 주세요.",
            "actions": actions,
        }

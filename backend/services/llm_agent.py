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
    ENABLE_PLANNER,
)
from backend.services.llm_tools import TOOL_DEFINITIONS, execute_tool
from backend.services import llm_planner

logger = logging.getLogger(__name__)

# Module-level httpx client — reuses connection pool across all chat requests.
# Lazy-initialized on first use; lives for process lifetime (acceptable for a long-running server).
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Return the shared httpx client, creating it on first call."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            timeout=OLLAMA_TIMEOUT,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client


async def close_client() -> None:
    """Close the shared httpx client. Called from the app lifespan shutdown so the
    connection pool is released cleanly. Safe to call when no client was created."""
    global _http_client
    if _http_client is not None:
        client, _http_client = _http_client, None
        await client.aclose()


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

async def _run_reactive(
    client: httpx.AsyncClient,
    messages: list[dict],
    actions: list[dict[str, Any]],
    tool_call_count: int = 0,
) -> dict:
    """The reactive ReAct loop: call Ollama, resolve tool calls, repeat until a
    plain text answer or MAX_TOOL_CALLS. Returns {"text", "actions"}.

    This is the original agent loop, factored out so it can serve as both the
    fast path (simple turns) and the fallback when planning is unavailable.
    """
    try:
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
        logger.exception("Unexpected error in reactive loop: %s", exc)
        return {
            "text": "예상치 못한 오류가 발생했습니다. 관리자에게 문의해 주세요.",
            "actions": actions,
        }


# ---------------------------------------------------------------------------
# Plan-and-Execute orchestration (hybrid)
# ---------------------------------------------------------------------------
def _plan_public(plan: dict) -> dict:
    """Trim a plan to the fields worth surfacing to the frontend."""
    return {
        "goal": plan.get("goal", ""),
        "steps": [
            {"n": s["n"], "tool": s["tool"], "why": s.get("why", "")}
            for s in plan.get("steps", [])
        ],
    }


def _fallback_summary(executed: list[dict]) -> str:
    """Deterministic answer assembled from action labels when the summary LLM
    call is unavailable."""
    labels = [
        e["result"]["label"]
        for e in executed
        if isinstance(e.get("result"), dict) and e["result"].get("label")
    ]
    if labels:
        return "요청을 처리했습니다: " + " · ".join(labels)
    return "요청하신 작업을 수행했습니다."


async def _summarize(
    client: httpx.AsyncClient,
    user_message: str,
    executed: list[dict],
    context_msg: str | None,
) -> str:
    """One tool-free LLM call that turns executed step results into the final
    Korean answer. Degrades to a label-based summary on any error."""
    digest = json.dumps(executed, ensure_ascii=False)[:2500]
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if context_msg:
        messages.append({"role": "system", "content": context_msg})
    messages.append({"role": "user", "content": user_message})
    messages.append({
        "role": "system",
        "content": (
            "아래는 사용자 요청을 처리하며 실행한 단계와 그 결과(JSON)입니다. "
            "이 결과만 근거로 한국어로 간결하게 최종 답변을 작성하세요. 도구를 더 호출하지 말고, "
            "지도/화면 조작은 이미 수행됐다고 전제하세요.\n" + digest
        ),
    })

    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": -1,
        "options": {"num_predict": MAX_RESPONSE_TOKENS},
    }
    try:
        response = await client.post(
            f"{OLLAMA_BASE_URL}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT
        )
        response.raise_for_status()
        text = response.json().get("message", {}).get("content", "")
        return text or _fallback_summary(executed)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Summary call failed (%s) — using label fallback", exc)
        return _fallback_summary(executed)


async def _reactive_step(
    client: httpx.AsyncClient,
    step: dict,
    results: dict,
    context: dict | None,
    actions: list[dict[str, Any]],
) -> dict:
    """Hybrid fallback: hand a single under-specified step to the reactive loop.

    Used when a step's args reference prior results that didn't resolve — the
    model decides the concrete call. Any frontend actions accumulate into the
    shared ``actions`` list.
    """
    ctx_msg = _build_context_message(context)
    note = (
        f"지금은 다단계 작업 중 한 단계만 수행합니다. 목적: {step.get('why') or step['tool']}. "
        f"'{step['tool']}' 도구를 적절한 인자로 한 번 호출하세요. "
        f"참고 가능한 이전 단계 결과(JSON): {json.dumps(results, ensure_ascii=False)[:800]}"
    )
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if ctx_msg:
        messages.append({"role": "system", "content": ctx_msg})
    messages.append({"role": "user", "content": note})

    sub = await _run_reactive(client, messages, actions)
    return {"delegated": True, "tool": step["tool"], "text": sub.get("text", "")}


async def _execute_plan(
    client: httpx.AsyncClient,
    plan: dict,
    user_message: str,
    context: dict | None,
    context_msg: str | None,
) -> dict:
    """Execute a validated plan step-by-step, then summarize. Resolved steps run
    deterministically via execute_tool; unresolved ones fall back to reactive."""
    if plan.get("clarify"):
        return {"text": plan["clarify"], "actions": [], "plan": _plan_public(plan)}

    actions: list[dict[str, Any]] = []
    results: dict[int, dict] = {}
    executed: list[dict] = []

    for step in llm_planner.topo_sort(plan["steps"]):
        args, resolved = llm_planner.resolve_refs(step.get("args", {}), results)
        if resolved:
            result = execute_tool(step["tool"], args)
            if isinstance(result, dict) and "action" in result:
                actions.append(result)
        else:
            logger.info("Step %s args unresolved — delegating to reactive", step.get("n"))
            result = await _reactive_step(client, step, results, context, actions)

        results[step["n"]] = result
        executed.append({
            "n": step["n"],
            "tool": step["tool"],
            "why": step.get("why", ""),
            "result": result,
        })

    text = await _summarize(client, user_message, executed, context_msg)
    return {"text": text, "actions": actions, "plan": _plan_public(plan)}


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------
async def chat(user_message: str, history: list = None, context: dict = None) -> dict:
    """Run a single user turn through the Maritime OSINT agent.

    Multi-domain, multi-step requests are routed through an explicit
    Plan-and-Execute path (planner → step execution → summary). Everything else
    takes the fast reactive ReAct loop. Either way the return contract is
    ``{"text", "actions"}``; planned turns add an optional ``"plan"``.

    Args:
        user_message: The user's natural-language query.
        history: Optional list of prior {role, content} message dicts.
                 Only the last 10 entries are kept to cap context size.
        context: Optional frontend state snapshot (current screen, ship, etc.).

    Returns:
        {"text": str, "actions": list, ["plan": dict]}
    """
    try:
        client = _get_client()
        context_msg = _build_context_message(context)

        # --- Planner gate: only clearly multi-step/multi-domain turns ---
        if ENABLE_PLANNER and llm_planner.should_plan(user_message):
            plan = await llm_planner.build_plan(client, user_message, context_msg)
            if plan:
                return await _execute_plan(client, plan, user_message, context, context_msg)
            # plan is None → fall through to the reactive loop

        # --- Reactive fast path / fallback ---
        messages = _build_initial_messages(user_message, history, context)
        return await _run_reactive(client, messages, [])

    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Unexpected error in chat: %s", exc)
        return {
            "text": "예상치 못한 오류가 발생했습니다. 관리자에게 문의해 주세요.",
            "actions": [],
        }

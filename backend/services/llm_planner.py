"""
Autonomous planner for the Maritime OSINT agent (Plan-and-Execute, hybrid).

Pure-ish helpers + a single LLM call that decomposes a multi-domain request into
an ordered, validated plan of tool steps. Orchestration (executing the plan,
collecting frontend actions, summarizing) lives in ``llm_agent.py``; this module
only *produces and validates* the plan.

Design notes:
  * Tool vocabulary is derived from ``TOOL_DEFINITIONS`` (the single registry),
    so the planner can never invent a tool that doesn't exist.
  * Cross-step data dependencies are expressed as ``"{{n.key}}"`` references and
    resolved deterministically at execution time (``resolve_refs``).
  * Every failure mode degrades to ``None`` so the caller can fall back to the
    existing reactive loop — matching the project's graceful-degrade convention.
"""

import json
import logging
import re
from typing import Any

import httpx

from backend.config_llm import (
    OLLAMA_BASE_URL,
    OLLAMA_TIMEOUT,
    PLANNER_MODEL,
    PLANNER_MAX_TOKENS,
    PLANNER_SYSTEM_PROMPT,
    MAX_PLAN_STEPS,
)
from backend.services.llm_tools import TOOL_DEFINITIONS

logger = logging.getLogger(__name__)

# A "{{3.toLat}}" style reference to a prior step's result field.
_REF_RE = re.compile(r"^\{\{\s*(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$")

# ---------------------------------------------------------------------------
# Gate — decide whether a turn is worth planning
# ---------------------------------------------------------------------------
# Distinct capability domains. A request spanning >= 2 of these *and* using a
# sequencing connector is what benefits from an explicit plan; everything else
# stays on the fast reactive path (no extra LLM call, no behavior change).
_DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "route":   ("항로", "경로", "루트", "route"),
    "hazard":  ("사고", "위험구역", "위험도", "hazard"),
    "roll":    ("횡요각", "전복", "선회", "롤", "침몰", "capsize"),
    "area":    ("해역", "근처", "부근", "주변", "앞바다", "반경"),
    "fleet":   ("선박", "충돌", "국적", "함정"),
    "nav":     ("이동", "가줘", "보여줘", "날아", "fly"),
}
_CONNECTORS: tuple[str, ...] = (
    "그리고", "그 다음", "그다음", "다음에", "이후", "한 뒤", "한뒤",
    "한 다음", "하고 나서", "하고나서", "그러고", "그런 다음", "및 ",
)


def _distinct_domains(text: str) -> set[str]:
    hits = set()
    for domain, kws in _DOMAIN_KEYWORDS.items():
        if any(kw in text for kw in kws):
            hits.add(domain)
    return hits


def has_connector(text: str) -> bool:
    return any(c in text for c in _CONNECTORS)


def should_plan(user_message: str) -> bool:
    """Heuristic gate: plan only for clearly multi-step, multi-domain requests.

    Conservative by design — single-domain composites (e.g. roll "선회하다 전복")
    are already handled well by the reactive loop and stay there to avoid latency.
    """
    if not user_message:
        return False
    domains = _distinct_domains(user_message)
    if len(domains) >= 3:
        return True
    return len(domains) >= 2 and has_connector(user_message)


# ---------------------------------------------------------------------------
# Plan validation + reference/topo helpers
# ---------------------------------------------------------------------------
def _tool_names() -> set[str]:
    return {entry["function"]["name"] for entry in TOOL_DEFINITIONS}


def validate_plan(plan: Any) -> dict | None:
    """Coerce a raw planner output into a safe plan dict, or None if unusable.

    Drops steps referencing unknown tools, caps step count, and ensures the
    minimal shape ({goal, clarify, steps[]}) the executor relies on.
    """
    if not isinstance(plan, dict):
        return None

    clarify = plan.get("clarify")
    if isinstance(clarify, str) and clarify.strip():
        # A clarification request is a valid, terminal plan — no steps needed.
        return {"goal": str(plan.get("goal", "")), "clarify": clarify.strip(), "steps": []}

    raw_steps = plan.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        return None

    known = _tool_names()
    steps: list[dict] = []
    for i, s in enumerate(raw_steps[:MAX_PLAN_STEPS], start=1):
        if not isinstance(s, dict):
            continue
        tool = s.get("tool")
        if tool not in known:
            logger.warning("Planner produced unknown/invalid tool %r — dropping step", tool)
            continue
        n = s.get("n")
        if not isinstance(n, int):
            n = i
        args = s.get("args") if isinstance(s.get("args"), dict) else {}
        needs = [x for x in s.get("needs", []) if isinstance(x, int)] if isinstance(s.get("needs"), list) else []
        steps.append({"n": n, "tool": tool, "args": args, "why": str(s.get("why", "")), "needs": needs})

    if not steps:
        return None
    return {"goal": str(plan.get("goal", "")), "clarify": None, "steps": steps}


def topo_sort(steps: list[dict]) -> list[dict]:
    """Order steps so each runs after its ``needs``. Falls back to declared order
    on a cycle or dangling reference (never raises)."""
    by_n = {s["n"]: s for s in steps}
    ordered: list[dict] = []
    visited: set = set()
    temp: set = set()
    cyclic = False

    def visit(n):
        nonlocal cyclic
        if n in visited or n not in by_n:
            return
        if n in temp:
            cyclic = True
            return
        temp.add(n)
        for dep in by_n[n].get("needs", []):
            visit(dep)
        temp.discard(n)
        visited.add(n)
        ordered.append(by_n[n])

    for s in steps:
        visit(s["n"])

    if cyclic or len(ordered) != len(steps):
        logger.warning("Plan dependency graph unusable (cycle/dangling) — using declared order")
        return list(steps)
    return ordered


def resolve_refs(args: dict, results: dict[int, dict]) -> tuple[dict, bool]:
    """Replace ``"{{n.key}}"`` arg values with prior step result fields.

    Returns ``(resolved_args, fully_resolved)``. ``fully_resolved`` is False when
    any reference can't be satisfied — the caller then routes that step to the
    reactive fallback instead of calling the tool with a broken arg.
    """
    resolved: dict = {}
    ok = True
    for key, val in args.items():
        if isinstance(val, str):
            m = _REF_RE.match(val)
            if m:
                step_n, field = int(m.group(1)), m.group(2)
                src = results.get(step_n)
                if isinstance(src, dict) and field in src and src[field] is not None:
                    resolved[key] = src[field]
                else:
                    ok = False
                    resolved[key] = None
                continue
        resolved[key] = val
    return resolved, ok


# ---------------------------------------------------------------------------
# Plan generation (one LLM call)
# ---------------------------------------------------------------------------
def _tool_catalog() -> str:
    """Compact tool catalog injected into the planner prompt."""
    lines = []
    for entry in TOOL_DEFINITIONS:
        fn = entry["function"]
        props = fn.get("parameters", {}).get("properties", {})
        params = ", ".join(props.keys()) or "—"
        desc = fn["description"].split(". ")[0]  # first sentence keeps the prompt small
        lines.append(f"- {fn['name']}({params}): {desc}")
    return "\n".join(lines)


def _extract_json(text: str) -> Any:
    """Best-effort JSON extraction from a model response."""
    text = (text or "").strip()
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    # Grab the outermost {...} block as a fallback.
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start : end + 1])
        except (ValueError, TypeError):
            return None
    return None


async def build_plan(
    client: httpx.AsyncClient,
    user_message: str,
    context_msg: str | None = None,
) -> dict | None:
    """Ask the planner model for a structured plan. Returns a validated plan or
    None (→ caller falls back to the reactive loop)."""
    sys_prompt = PLANNER_SYSTEM_PROMPT + "\n\n사용 가능한 도구:\n" + _tool_catalog()
    messages = [{"role": "system", "content": sys_prompt}]
    if context_msg:
        messages.append({"role": "system", "content": context_msg})
    messages.append({"role": "user", "content": user_message})

    payload = {
        "model": PLANNER_MODEL,
        "messages": messages,
        "stream": False,
        "format": "json",  # force valid JSON output from Ollama
        "keep_alive": -1,
        "options": {"num_predict": PLANNER_MAX_TOKENS, "temperature": 0.1},
    }

    try:
        resp = await client.post(
            f"{OLLAMA_BASE_URL}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT
        )
        resp.raise_for_status()
        content = resp.json().get("message", {}).get("content", "")
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Planner call failed (%s) — falling back to reactive", exc)
        return None

    plan = validate_plan(_extract_json(content))
    if plan is None:
        logger.warning("Planner output unusable — falling back to reactive")
    else:
        logger.info(
            "Plan built: goal=%r steps=%d clarify=%s",
            plan.get("goal"),
            len(plan.get("steps", [])),
            bool(plan.get("clarify")),
        )
    return plan

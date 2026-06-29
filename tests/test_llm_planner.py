"""Tests for the autonomous planner (gate, validation, refs, topo) and the
Plan-and-Execute orchestration in llm_agent.

LLM calls are stubbed — these lock down the *deterministic* machinery around the
model: the gate keeps simple turns on the reactive path, the validator rejects
hallucinated tools, references/topo resolve correctly, and the executor runs
resolved steps via execute_tool while preserving the {text, actions} contract.
"""

import json

import pytest

from backend.services import llm_planner, llm_agent


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "msg, expected",
    [
        ("부산으로 가줘", False),                              # single domain
        ("이 배 우현으로 선회하다가 전복시켜", False),          # single domain (roll), reactive handles it
        ("부산에서 광양까지 항로 그리고 사고위험 알려줘", True),  # route + hazard + connector
        ("일본 주변 해역 선박 보여주고 항로도 그려줘", True),    # area + fleet + route (>=3)
        ("", False),
    ],
)
def test_should_plan_gate(msg, expected):
    assert llm_planner.should_plan(msg) is expected


# ---------------------------------------------------------------------------
# Plan validation
# ---------------------------------------------------------------------------
def test_validate_plan_drops_unknown_tools():
    raw = {
        "goal": "g",
        "steps": [
            {"n": 1, "tool": "plan_route", "args": {"from": "busan", "to": "jeju"}, "needs": []},
            {"n": 2, "tool": "nuke_from_orbit", "args": {}, "needs": [1]},  # not in registry
        ],
    }
    plan = llm_planner.validate_plan(raw)
    assert plan is not None
    assert [s["tool"] for s in plan["steps"]] == ["plan_route"]


def test_validate_plan_clarify_is_terminal():
    plan = llm_planner.validate_plan({"goal": "g", "clarify": "어느 항구인가요?"})
    assert plan["clarify"] == "어느 항구인가요?"
    assert plan["steps"] == []


def test_validate_plan_rejects_non_dict_and_empty():
    assert llm_planner.validate_plan(None) is None
    assert llm_planner.validate_plan({"goal": "g", "steps": []}) is None
    assert llm_planner.validate_plan({"goal": "g", "steps": [{"tool": "ghost"}]}) is None


def test_validate_plan_caps_step_count(monkeypatch):
    monkeypatch.setattr(llm_planner, "MAX_PLAN_STEPS", 2)
    raw = {"steps": [{"tool": "return_to_globe"} for _ in range(5)]}
    plan = llm_planner.validate_plan(raw)
    assert len(plan["steps"]) == 2


# ---------------------------------------------------------------------------
# Reference resolution + topo sort
# ---------------------------------------------------------------------------
def test_resolve_refs_hit():
    args, ok = llm_planner.resolve_refs(
        {"lat": "{{2.toLat}}", "lon": "{{2.toLng}}", "radius_nm": 30},
        {2: {"toLat": 34.9, "toLng": 127.7}},
    )
    assert ok is True
    assert args == {"lat": 34.9, "lon": 127.7, "radius_nm": 30}


def test_resolve_refs_miss_marks_unresolved():
    args, ok = llm_planner.resolve_refs({"lat": "{{9.toLat}}"}, {2: {"toLat": 1.0}})
    assert ok is False
    assert args == {"lat": None}


def test_resolve_refs_passes_through_literals():
    args, ok = llm_planner.resolve_refs({"from": "busan", "size_class": "C"}, {})
    assert ok is True
    assert args == {"from": "busan", "size_class": "C"}


def test_topo_sort_orders_by_needs():
    steps = [
        {"n": 3, "tool": "get_hazard_summary", "needs": [2]},
        {"n": 1, "tool": "open_route_screen", "needs": []},
        {"n": 2, "tool": "plan_route", "needs": [1]},
    ]
    ordered = [s["n"] for s in llm_planner.topo_sort(steps)]
    assert ordered == [1, 2, 3]


def test_topo_sort_cycle_falls_back_to_declared_order():
    steps = [
        {"n": 1, "tool": "a", "needs": [2]},
        {"n": 2, "tool": "b", "needs": [1]},
    ]
    ordered = [s["n"] for s in llm_planner.topo_sort(steps)]
    assert ordered == [1, 2]  # declared order, no crash


# ---------------------------------------------------------------------------
# Plan execution (LLM stubbed)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_execute_plan_runs_resolved_steps_and_collects_actions(monkeypatch):
    """A fully-resolved 3-step plan executes deterministically; actions from
    tool results accumulate; summary is stubbed."""
    plan = llm_planner.validate_plan({
        "goal": "부산→광양 항로 + 도착지 위험",
        "steps": [
            {"n": 1, "tool": "open_route_screen", "args": {}, "needs": []},
            {"n": 2, "tool": "plan_route",
             "args": {"from": "busan", "to": "gwangyang", "size_class": "C"}, "needs": [1]},
            {"n": 3, "tool": "get_hazard_summary",
             "args": {"lat": "{{2.toLat}}", "lon": "{{2.toLng}}", "radius_nm": 30}, "needs": [2]},
        ],
    })

    async def fake_summarize(client, user_message, executed, context_msg):
        # All three steps must have executed before summary.
        assert [e["n"] for e in executed] == [1, 2, 3]
        return "요약 완료"

    monkeypatch.setattr(llm_agent, "_summarize", fake_summarize)

    out = await llm_agent._execute_plan(
        client=None, plan=plan, user_message="...", context=None, context_msg=None
    )

    assert out["text"] == "요약 완료"
    # open_route_screen + plan_route emit frontend actions; get_hazard_summary doesn't.
    action_types = [a["action"] for a in out["actions"]]
    assert action_types == ["open_route_screen", "plan_route"]
    assert out["plan"]["steps"][1]["tool"] == "plan_route"


@pytest.mark.asyncio
async def test_execute_plan_clarify_short_circuits(monkeypatch):
    plan = {"goal": "g", "clarify": "출발지가 어디인가요?", "steps": []}
    called = False

    async def fake_summarize(*a, **k):
        nonlocal called
        called = True
        return "x"

    monkeypatch.setattr(llm_agent, "_summarize", fake_summarize)
    out = await llm_agent._execute_plan(None, plan, "...", None, None)
    assert out["text"] == "출발지가 어디인가요?"
    assert out["actions"] == []
    assert called is False  # no execution / summary on a clarify plan


@pytest.mark.asyncio
async def test_execute_plan_delegates_unresolved_step(monkeypatch):
    """A step whose ref can't resolve is handed to the reactive fallback."""
    plan = llm_planner.validate_plan({
        "goal": "g",
        "steps": [
            {"n": 1, "tool": "get_hazard_summary", "args": {"lat": "{{7.toLat}}"}, "needs": []},
        ],
    })

    delegated = {}

    async def fake_reactive_step(client, step, results, context, actions):
        delegated["tool"] = step["tool"]
        actions.append({"action": "fly_to", "label": "위임됨"})
        return {"delegated": True}

    async def fake_summarize(*a, **k):
        return "요약"

    monkeypatch.setattr(llm_agent, "_reactive_step", fake_reactive_step)
    monkeypatch.setattr(llm_agent, "_summarize", fake_summarize)

    out = await llm_agent._execute_plan(None, plan, "...", None, None)
    assert delegated["tool"] == "get_hazard_summary"
    assert out["actions"] == [{"action": "fly_to", "label": "위임됨"}]


# ---------------------------------------------------------------------------
# chat() routing: simple turns must NOT touch the planner
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_chat_simple_turn_skips_planner(monkeypatch):
    monkeypatch.setattr(llm_agent, "ENABLE_PLANNER", True)

    async def fail_build_plan(*a, **k):
        raise AssertionError("planner must not run for a simple turn")

    async def fake_reactive(client, messages, actions, tool_call_count=0):
        return {"text": "즉답", "actions": actions}

    monkeypatch.setattr(llm_agent.llm_planner, "build_plan", fail_build_plan)
    monkeypatch.setattr(llm_agent, "_run_reactive", fake_reactive)
    monkeypatch.setattr(llm_agent, "_get_client", lambda: None)

    out = await llm_agent.chat("부산으로 가줘")
    assert out == {"text": "즉답", "actions": []}


@pytest.mark.asyncio
async def test_chat_falls_back_to_reactive_when_plan_none(monkeypatch):
    monkeypatch.setattr(llm_agent, "ENABLE_PLANNER", True)

    async def none_build_plan(*a, **k):
        return None  # planner unusable

    async def fake_reactive(client, messages, actions, tool_call_count=0):
        return {"text": "폴백", "actions": actions}

    monkeypatch.setattr(llm_agent.llm_planner, "build_plan", none_build_plan)
    monkeypatch.setattr(llm_agent, "_run_reactive", fake_reactive)
    monkeypatch.setattr(llm_agent, "_get_client", lambda: None)

    out = await llm_agent.chat("부산에서 광양까지 항로 그리고 사고위험 알려줘")
    assert out == {"text": "폴백", "actions": []}

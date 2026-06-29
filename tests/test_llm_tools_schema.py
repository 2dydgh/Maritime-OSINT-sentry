"""Behavior-preservation tests for the LLM tool registry.

These tests lock down the *external contract* of ``backend.services.llm_tools``
so the decorator-based refactor cannot silently change what the LLM (Ollama) sees
or how tool calls dispatch:

  1. ``TOOL_DEFINITIONS`` must remain semantically identical to the frozen golden
     snapshot in ``tests/fixtures/llm_tool_definitions_golden.json`` (captured from
     the pre-refactor implementation).
  2. ``execute_tool`` must dispatch every advertised tool, reject unknown names,
     and swallow handler exceptions into an ``{"error": ...}`` dict.
  3. A handful of pure-logic handlers must return byte-identical payloads
     (no external/AIS state needed), pinning the frontend-action contract.

Normalization note: three original entries (``open_route_screen``,
``toggle_hazard_zones``, ``get_hazard_summary``) omitted the ``required`` key
entirely, while the rest used ``"required": []``. That difference is a no-op for
the LLM, so the comparison normalizes a missing ``required`` to ``[]`` on both
sides. Everything else is compared for deep (object) equality, order-insensitive
by tool name — matching how the model actually consumes the tool list.
"""

import json
from pathlib import Path

import pytest

from backend.services import llm_tools as t

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "llm_tool_definitions_golden.json"


def _by_name(definitions: list[dict]) -> dict[str, dict]:
    """Index tool entries by name and normalize the optional ``required`` key."""
    out: dict[str, dict] = {}
    for entry in definitions:
        fn = entry["function"]
        params = fn.get("parameters", {})
        # Normalize: a missing ``required`` is equivalent to an empty one.
        params.setdefault("required", [])
        out[fn["name"]] = entry
    return out


@pytest.fixture(scope="module")
def golden() -> list[dict]:
    with open(GOLDEN_PATH, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# 1. Schema contract
# ---------------------------------------------------------------------------
def test_tool_names_unchanged(golden):
    assert {d["function"]["name"] for d in t.TOOL_DEFINITIONS} == {
        d["function"]["name"] for d in golden
    }


def test_tool_count_unchanged(golden):
    assert len(t.TOOL_DEFINITIONS) == len(golden)


def test_tool_definitions_match_golden(golden):
    """Every tool's full schema must deep-equal the frozen golden snapshot."""
    current = _by_name(t.TOOL_DEFINITIONS)
    expected = _by_name(golden)
    assert current.keys() == expected.keys()
    for name in expected:
        assert current[name] == expected[name], f"schema drift in tool '{name}'"


def test_every_entry_is_ollama_function_shape():
    for entry in t.TOOL_DEFINITIONS:
        assert entry["type"] == "function"
        fn = entry["function"]
        assert isinstance(fn["name"], str) and fn["name"]
        assert isinstance(fn["description"], str) and fn["description"]
        assert fn["parameters"]["type"] == "object"
        assert "properties" in fn["parameters"]


# ---------------------------------------------------------------------------
# 2. Dispatch contract
# ---------------------------------------------------------------------------
def test_every_advertised_tool_is_dispatchable():
    """Each name in TOOL_DEFINITIONS must resolve to a handler (no orphans)."""
    for entry in t.TOOL_DEFINITIONS:
        name = entry["function"]["name"]
        result = t.execute_tool(name, {})
        # Handlers may return a validation error for empty args, but must NOT
        # return the "unknown tool" sentinel — that means it isn't registered.
        assert result.get("error") != f"알 수 없는 도구: {name}", f"'{name}' not registered"


def test_unknown_tool_returns_error():
    result = t.execute_tool("does_not_exist", {})
    assert result == {"error": "알 수 없는 도구: does_not_exist"}


def test_handler_exception_is_wrapped(monkeypatch):
    """A raising handler must be caught and returned as an error dict."""

    def boom(arguments):
        raise RuntimeError("kaboom")

    # Register a temporary throwing tool through whatever registry backs dispatch.
    monkeypatch.setitem(t._TOOL_HANDLERS, "boom", boom)
    result = t.execute_tool("boom", {})
    assert "error" in result
    assert "boom" in result["error"]


# ---------------------------------------------------------------------------
# 3. Pure-logic payload contract (no AIS/external state)
# ---------------------------------------------------------------------------
def test_return_to_globe_payload():
    assert t.execute_tool("return_to_globe", {}) == {
        "action": "return_to_globe",
        "label": "지구본 메인 지도로 복귀",
    }


def test_open_route_screen_payload():
    assert t.execute_tool("open_route_screen", {}) == {
        "action": "open_route_screen",
        "label": "항로 화면 열기",
    }


def test_fly_to_known_port_payload():
    assert t.execute_tool("fly_to", {"port": "busan"}) == {
        "action": "fly_to",
        "lat": 35.10,
        "lon": 129.05,
        "zoom": 10.0,
        "label": "부산항",
    }


def test_fly_to_unknown_port_errors():
    assert t.execute_tool("fly_to", {"port": "atlantis"}) == {
        "error": "알 수 없는 항구: atlantis"
    }


def test_set_route_size_class_payload():
    assert t.execute_tool("set_route_size_class", {"size_class": "c"}) == {
        "action": "set_route_size_class",
        "size_class": "C",
        "label": "선박 크기 등급 C 적용",
    }


def test_set_route_size_class_rejects_bad_class():
    assert t.execute_tool("set_route_size_class", {"size_class": "Z"}) == {
        "error": "size_class는 A~E 중 하나여야 합니다."
    }


def test_toggle_hazard_zones_defaults_on():
    assert t.execute_tool("toggle_hazard_zones", {}) == {
        "action": "toggle_hazard_zones",
        "on": True,
        "label": "사고 위험구역 표시",
    }


def test_plan_route_port_to_port_payload():
    assert t.execute_tool("plan_route", {"from": "busan", "to": "gwangyang"}) == {
        "action": "plan_route",
        "fromLat": 35.10,
        "fromLng": 129.05,
        "fromName": "부산항",
        "toLat": 34.90,
        "toLng": 127.70,
        "toName": "광양항",
        "sizeClass": None,
        "label": "항로 추론: 부산항 → 광양항",
    }


def test_trigger_capsize_clear_payload():
    assert t.execute_tool("trigger_capsize", {"clear": True}) == {
        "action": "trigger_capsize",
        "clear": True,
        "label": "전복 시뮬레이션 해제 (정상 자세 복귀)",
    }

"""당직사관 — 충돌 위험 고단계를 조치 제안으로 바꾸고 승인/기각을 기록한다.

규칙이 탐지·조치를 결정한다. LLM은 브리핑 문장만 다듬는다 (Task 5).
입력은 collision_analyzer 캐시의 위험 리스트뿐이다. vessel dict 전체를 넘기지 말 것.
"""
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

from backend.config import WATCH_COOLDOWN_MIN, WATCH_DCPA_NM, WATCH_TCPA_MIN

logger = logging.getLogger(__name__)

MAX_PROPOSALS = 500
ENCOUNTER_KO = {"head-on": "정면", "crossing": "횡단", "overtaking": "추월"}

# 상태 — 단일 이벤트 루프에서만 만지므로 락 없음
_proposals: dict[str, dict] = {}            # id → record (삽입순)
_open_by_pair: dict[tuple[int, int], str] = {}
_cooldown_until: dict[tuple[int, int], float] = {}


def reset() -> None:
    _proposals.clear()
    _open_by_pair.clear()
    _cooldown_until.clear()


def pair_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a <= b else (b, a)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _subject(info: dict, observed_at: str) -> dict:
    return {
        "mmsi": int(info["mmsi"]), "name": info.get("name") or str(info["mmsi"]),
        "ship_type": info.get("type", "unknown"), "lat": info["lat"], "lng": info["lng"],
        "sog": info.get("sog", 0), "cog": info.get("cog", 0), "observed_at": observed_at,
    }


# ── 규칙 ──────────────────────────────────────────────────────────────────

def collision_high_risk(ml_risks: list[dict], distance_risks: list[dict]) -> list[dict]:
    """ML 등급 3 또는 (DCPA < WATCH_DCPA_NM and 0 < TCPA < WATCH_TCPA_MIN). 쌍당 후보 1개, ML 우선."""
    out: dict[tuple[int, int], dict] = {}
    for r in ml_risks:
        if int(r.get("risk_level", 0)) < 3:
            continue
        key = pair_key(r["ship_a"]["mmsi"], r["ship_b"]["mmsi"])
        out[key] = {
            "pair": key,
            "trigger": {"kind": "collision_risk", "source": "ml", "risk_level": 3, "risk_label": r["risk_label"],
                        "dcpa_nm": r["dcpa_nm"], "tcpa_min": r["tcpa_min"], "encounter": r.get("encounter")},
            "subjects": [_subject(r["ship_a"], r["ts"]), _subject(r["ship_b"], r["ts"])],
        }
    for r in distance_risks:
        if not (r["dcpa_nm"] < WATCH_DCPA_NM and 0 < r["tcpa_min"] < WATCH_TCPA_MIN):
            continue
        key = pair_key(r["ship_a"]["mmsi"], r["ship_b"]["mmsi"])
        if key in out:
            continue
        out[key] = {
            "pair": key,
            "trigger": {"kind": "collision_risk", "source": "distance", "risk_level": None, "risk_label": "CPA 임계",
                        "dcpa_nm": r["dcpa_nm"], "tcpa_min": r["tcpa_min"], "encounter": r.get("encounter")},
            "subjects": [_subject(r["ship_a"], r["ts"]), _subject(r["ship_b"], r["ts"])],
        }
    return list(out.values())


RULES = [collision_high_risk]


# ── 브리핑 ────────────────────────────────────────────────────────────────

def build_brief(record: dict) -> str:
    a, b = record["subjects"]
    t = record["trigger"]
    enc = ENCOUNTER_KO.get(t.get("encounter") or "", "근접")
    return (
        f"{a['name']}({a['ship_type']})와 {b['name']}({b['ship_type']})가 {enc} 조우 중. "
        f"DCPA {t['dcpa_nm']:.2f} nm, TCPA {t['tcpa_min']:.1f}분, 등급 {t['risk_label']}. "
        f"조우 지점으로 이동해 두 선박을 추적할 것을 제안."
    )


# ── 레코드 ────────────────────────────────────────────────────────────────

def _make_record(cand: dict, now: float) -> dict:
    a, b = cand["subjects"]
    ts = _iso(now)
    rec = {
        "id": f"p_{ts.replace('-', '').replace(':', '')}_{cand['pair'][0]}_{cand['pair'][1]}",
        "created_at": ts, "updated_at": ts,
        "trigger": cand["trigger"], "subjects": cand["subjects"],
        "brief": "", "brief_source": "template",
        "actions": [
            {"action": "fly_to", "lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lng"] + b["lng"]) / 2,
             "zoom": 12, "label": "조우 지점"},
            {"action": "highlight_pair", "mmsi": [a["mmsi"], b["mmsi"]],
             "risk_level": cand["trigger"]["risk_level"] or 3},
        ],
        "status": "open", "decision": None,
    }
    rec["brief"] = build_brief(rec)
    return rec


def _trim() -> None:
    """상한 초과 시 결정·만료된 오래된 것부터 버린다. 열린 제안은 남긴다."""
    while len(_proposals) > MAX_PROPOSALS:
        victim = next((pid for pid, p in _proposals.items() if p["status"] != "open"), None)
        if victim is None:
            return
        del _proposals[victim]


def evaluate(ml_risks: list[dict], distance_risks: list[dict], now: float | None = None):
    """규칙 평가 → (new, updated, expired). 상태만 바꾸고 I/O는 하지 않는다."""
    now = time.time() if now is None else now
    cands = {c["pair"]: c for rule in RULES for c in rule(ml_risks, distance_risks)}
    new, updated, expired = [], [], []

    for key, pid in list(_open_by_pair.items()):
        if key not in cands:
            rec = _proposals[pid]
            rec["status"], rec["updated_at"] = "expired", _iso(now)
            _cooldown_until[key] = now + WATCH_COOLDOWN_MIN * 60
            del _open_by_pair[key]
            expired.append(rec)

    for key, cand in cands.items():
        if key in _open_by_pair:
            rec = _proposals[_open_by_pair[key]]
            rec["trigger"], rec["subjects"], rec["updated_at"] = cand["trigger"], cand["subjects"], _iso(now)
            if rec["brief_source"] == "template":
                rec["brief"] = build_brief(rec)
            updated.append(rec)
        elif _cooldown_until.get(key, 0) <= now:
            rec = _make_record(cand, now)
            _proposals[rec["id"]] = rec
            _open_by_pair[key] = rec["id"]
            new.append(rec)

    _trim()
    return new, updated, expired


def decide(proposal_id: str, outcome: str, reason: str | None = None, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    rec = _proposals[proposal_id]                      # KeyError if unknown
    if rec["status"] != "open":
        raise ValueError(f"proposal {proposal_id} is {rec['status']}, not open")
    if outcome not in ("approved", "dismissed"):
        raise ValueError(f"bad outcome {outcome}")
    rec["status"], rec["updated_at"] = outcome, _iso(now)
    rec["decision"] = {"at": _iso(now), "by": "operator", "reason": reason}
    key = pair_key(rec["subjects"][0]["mmsi"], rec["subjects"][1]["mmsi"])
    _open_by_pair.pop(key, None)
    _cooldown_until[key] = now + WATCH_COOLDOWN_MIN * 60
    return rec


def get_proposal(proposal_id: str) -> dict | None:
    return _proposals.get(proposal_id)


def list_proposals(status: str | None = None, limit: int = 50) -> list[dict]:
    items = [p for p in reversed(_proposals.values()) if status is None or p["status"] == status]
    return items[:limit]


JSONL_PATH = Path(__file__).resolve().parent.parent / "cache" / "proposals.jsonl"


def append_jsonl(record: dict, path: Path | None = None) -> None:
    """레코드 한 줄 append. 실패해도 제안 전달은 계속돼야 하므로 로그만 남긴다."""
    try:
        with open(path or JSONL_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning("proposal jsonl append failed: %s", e)


def restore(path: Path | None = None) -> int:
    """파일을 읽어 id별 마지막 줄로 복원. 열려 있던 제안은 expired로 닫는다."""
    path = path or JSONL_PATH
    if not path.exists():
        return 0
    reset()
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict) or "id" not in rec:
                continue
            if rec.get("status") == "open":
                rec["status"] = "expired"
            _proposals[rec["id"]] = rec
    _trim()
    return len(_proposals)

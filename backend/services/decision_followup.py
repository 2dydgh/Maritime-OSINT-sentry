"""Local AIS observations and frozen prediction residuals; no execution inference."""

import math
from datetime import datetime
from itertools import pairwise

from backend.services import collision_scenarios as scenarios


def timestamp(value):
    return datetime.fromisoformat(value).timestamp()


def observe(pair, vessels, now, rule):
    by_id = {int(v["mmsi"]): v for v in vessels}
    if any(m not in by_id or not scenarios.valid(by_id[m], now) for m in pair):
        return None
    selected = [by_id[m] for m in pair]
    snap = scenarios.capture(pair, selected, now)
    a, b = snap["ships"]
    metric = scenarios.closest(a, b, rule["tcpa_min"] * 60, snap["origin"])
    high = (
        metric["tcpa_min"] is not None
        and 0 < metric["tcpa_min"] < rule["tcpa_min"]
        and metric["dcpa_nm"] is not None
        and metric["dcpa_nm"] < rule["dcpa_nm"]
    )
    return {
        "at": scenarios.stamp(now),
        "subjects": [{k: v[k] for k in ("mmsi", "lat", "lng", "sog", "cog", "_updated")} for v in selected],
        "distance_nm": math.hypot(a["x_nm"] - b["x_nm"], a["y_nm"] - b["y_nm"]),
        "dcpa_nm": metric["dcpa_nm"],
        "tcpa_min": metric["tcpa_min"],
        "risk_state": "high" if high else "reduced",
    }


def interpolate(points, seconds):
    if seconds < points[0]["t_s"] or seconds > points[-1]["t_s"]:
        return None
    for a, b in pairwise(points):
        if a["t_s"] <= seconds <= b["t_s"]:
            ratio = (seconds - a["t_s"]) / (b["t_s"] - a["t_s"])
            return {k: a[k] + (b[k] - a[k]) * ratio for k in ("x_nm", "y_nm")}
    return points[-1]


def residuals(run, observations):
    start = timestamp(run["snapshot"]["created_at"])
    points = {str(m): [] for m in run["snapshot"]["pair"]}
    seen = set()
    for observation in observations:
        for v in observation["subjects"]:
            key = (v["mmsi"], v["_updated"])
            elapsed = v["_updated"] - start
            if key in seen or not 0 <= elapsed <= run["horizon_s"]:
                continue
            seen.add(key)
            x, y = scenarios.xy(v["lat"], v["lng"], run["snapshot"]["origin"])
            errors = {}
            for name, scenario in run["scenarios"].items():
                p = interpolate(scenario["tracks"][str(v["mmsi"])]["points"], elapsed)
                errors[name] = math.hypot(x - p["x_nm"], y - p["y_nm"])
            points[str(v["mmsi"])].append(
                {"t_s": elapsed, "lat": v["lat"], "lng": v["lng"], "x_nm": x, "y_nm": y, "errors_nm": errors}
            )
    return {
        "tracks": points,
        "note": "로컬 AIS 수신 시각 기준 위치 차이입니다. 관측 시각 오차가 포함되며 변경안의 실제 실행 여부를 뜻하지 않습니다.",
    }

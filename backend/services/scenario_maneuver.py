"""Hypothetical ramp maneuvers, integrated at 1 s; not calibrated ship dynamics."""

import math
from itertools import pairwise

MODEL = "ramped-motion-local-plane-v1"


def path(ship, speed, course, turn_seconds, speed_seconds, horizon, origin):
    from backend.services import collision_scenarios as s

    delta = (course - ship["cog"] + 180) % 360 - 180
    # Exactly 180 degrees uses a clockwise turn; other turns use the shortest arc.
    if delta == -180:
        delta = 180

    def state(t):
        return (
            ship["sog"] + (speed - ship["sog"]) * min(1, t / speed_seconds) if speed_seconds else speed,
            (ship["cog"] + delta * min(1, t / turn_seconds)) % 360 if turn_seconds else course,
        )

    x, y = ship["x_nm"], ship["y_nm"]
    points = []
    for t in range(horizon + 1):
        if t:
            v, c = state(t - 0.5)
            angle = math.radians(c)
            x += v * math.sin(angle) / 3600
            y += v * math.cos(angle) / 3600
        v, c = state(t)
        p = s.point(dict(ship, x_nm=x, y_nm=y, sog=0), 0, origin)
        p.update(t_s=t, sog=v, cog=c)
        points.append(p)
    return points


def closest_to_path(points, other, origin):
    from backend.services import collision_scenarios as s

    vx, vy = s.velocity(other)
    best = None
    for a, b in pairwise(points):
        t = a["t_s"]
        ox = other["x_nm"] + vx * t
        oy = other["y_nm"] + vy * t
        rx, ry = ox - a["x_nm"], oy - a["y_nm"]
        dx, dy = vx - (b["x_nm"] - a["x_nm"]), vy - (b["y_nm"] - a["y_nm"])
        vv = dx * dx + dy * dy
        f = max(0, min(1, -(rx * dx + ry * dy) / vv)) if vv else 0
        distance = math.hypot(rx + dx * f, ry + dy * f)
        if best is None or distance < best[0]:
            best = (distance, t + f, a, b, f)
    distance, t, a, b, f = best
    projected = {k: a[k] + (b[k] - a[k]) * f for k in ("x_nm", "y_nm")}
    p = s.point(dict(other, **projected, sog=0), 0, origin)
    p["t_s"] = t
    return {
        "closest_distance_nm": distance,
        "closest_time_s": t,
        "tcpa_min": None,
        "dcpa_nm": None,
        "within_horizon": None,
        "metric_method": "piecewise-linear-1s",
        "a": p,
        "b": s.point(other, t, origin),
    }


def apply(result, turn_seconds, speed_seconds):
    from backend.services import collision_scenarios as s

    snapshot = result["snapshot"]
    target = result["change"]["mmsi"]
    origin = snapshot["origin"]
    subject = next(v for v in snapshot["ships"] if v["mmsi"] == target)
    points = path(
        subject,
        result["change"]["sog"],
        result["change"]["cog"],
        turn_seconds,
        speed_seconds,
        int(result["horizon_s"]),
        origin,
    )
    alt = result["scenarios"]["alternative"]
    alt["tracks"][str(target)]["points"] = points[::10]
    other = next(v for v in snapshot["ships"][:2] if v["mmsi"] != target)
    metric = closest_to_path(points, other, origin)
    if snapshot["pair"][0] != target:
        metric["a"], metric["b"] = metric["b"], metric["a"]
    alt["pair"] = metric
    nearby = []
    for neighbor in snapshot["ships"][2:]:
        for vessel in (subject, other):
            metric = (
                closest_to_path(points, neighbor, origin)
                if vessel is subject
                else s.closest(vessel, neighbor, result["horizon_s"], origin)
            )
            nearby.append(
                {
                    "subject": vessel["mmsi"],
                    "other": neighbor["mmsi"],
                    "name": neighbor["name"],
                    "distance_nm": metric["closest_distance_nm"],
                    "time_s": metric["closest_time_s"],
                }
            )
    nearby.sort(key=lambda r: r["distance_nm"])
    alt["nearby"] = nearby[:10]
    alt["nearby_under_05nm"] = sum(r["distance_nm"] < 0.5 for r in nearby)
    result["model"] = MODEL
    result["change"].update(turn_seconds=turn_seconds, speed_seconds=speed_seconds)
    result["assumptions"] = [
        snapshot["assumptions"][0],
        "속력과 침로는 각각 지정 시간 동안 선형 변화합니다. 침로는 짧은 회전 방향(정반대는 시계 방향)을 사용합니다.",
        "선박별 성능으로 보정되지 않은 가정값입니다. 1초 적분과 구간 선형 보간으로 최소 거리를 계산합니다.",
        "해안·수심·항법규칙·기상은 계산하지 않습니다. 실제 운항 지시가 아닌 가정 비교입니다.",
    ]
    return result

from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.services import watch_officer as w

NOW = 1800000000.0
PAIR = (440000001, 440000002)


def data():
    vessels = [
        dict(mmsi=PAIR[0], name="A", lat=35.0, lng=129.0, sog=12, cog=90, _updated=NOW),
        dict(mmsi=PAIR[1], name="B", lat=35.0, lng=129.04, sog=12, cog=270, _updated=NOW),
    ]
    r = dict(ship_a=vessels[0], ship_b=vessels[1], dcpa_nm=0.1, tcpa_min=5, ts=w.iso(NOW))
    return dict(distance=[r], ml=[], updated_at=NOW), lambda pair: vessels


@pytest.fixture
def setup(tmp_path):
    store = w.Store(tmp_path / "watch.sqlite3")
    risks, lookup = data()
    store.refresh(risks, lookup, NOW)
    return store, risks, lookup, store.list()[0]["id"]


def approve(setup, client="tab1"):
    store, risks, lookup, pid = setup
    return store.decide(pid, "approved", "집중 추적 필요", client, risks, lookup, NOW + 1)


def test_rule_dedup_and_persistent_decision(setup):
    store, risks, lookup, pid = setup
    store.refresh(risks, lookup, NOW + 1)
    assert len(store.list()) == 1
    first = approve(setup)
    assert first["execute"] is True
    restored = w.Store(store.path)
    again = restored.decide(pid, "approved", "retry", "tab1", risks, lookup, NOW + 2)
    assert again["execute"] is False
    assert restored.list()[0]["decision"]["reason"] == "집중 추적 필요"
    assert first["proposal"]["approval_evidence"]["dcpa_nm"] < 0.01


@pytest.mark.parametrize("condition", ["analysis_stale", "vessel_stale", "vessel_missing", "risk_changed"])
def test_revalidate_blocks_stale_or_changed(setup, condition):
    store, risks, lookup, pid = setup
    if condition == "analysis_stale":
        risks["updated_at"] = NOW - 31
    elif condition == "vessel_stale":
        lookup(PAIR)[0]["_updated"] = NOW - 61
    elif condition == "vessel_missing":
        lookup = lambda pair: []
    else:
        lookup(PAIR)[1]["cog"] = 90
    result = store.decide(pid, "approved", "reason", "tab1", risks, lookup, NOW + 1)
    # 어떤 사유든 실행은 절대 나가지 않는다 — 이게 안전 속성이다.
    assert not result["execute"]
    if condition == "risk_changed":
        # 조건이 실제로 해소된 경우에만 제안을 닫는다.
        assert result["proposal"]["status"] == "expired"
        assert result["proposal"]["events"][-1]["reason"] == condition
    else:
        # 관측 공백은 해소가 아니다. 승인만 막고 제안은 살려둬야 AIS 가 돌아왔을 때
        # 운용자가 같은 사건을 이어서 볼 수 있다(닫아버리면 쿨다운에 가려진다).
        assert result["proposal"]["status"] == "open"
        assert result["proposal"]["stale"] == condition


def record(store, pid):
    return next(p for p in store.list() if p["id"] == pid)


def feed(t):
    """시각 t 기준의 위험 피드. 분석 시각·수신 시각이 모두 t 라서, 공백을
    만들고 싶은 항목만 골라 늦추면 된다(그러지 않으면 분석 신선도까지 같이 낡는다)."""
    vessels = [
        dict(mmsi=PAIR[0], name="A", lat=35.0, lng=129.0, sog=12, cog=90, _updated=t),
        dict(mmsi=PAIR[1], name="B", lat=35.0, lng=129.04, sog=12, cog=270, _updated=t),
    ]
    r = dict(ship_a=vessels[0], ship_b=vessels[1], dcpa_nm=0.1, tcpa_min=5, ts=w.iso(t))
    return dict(distance=[r], ml=[], updated_at=t), (lambda pair: vessels), vessels


def gap_at(store, t):
    """분석은 신선하지만 한 척의 AIS 만 61초 낡은 상태로 한 번 스캔한다."""
    risks, lookup, vessels = feed(t)
    vessels[0]["_updated"] = t - 61
    store.refresh(risks, lookup, t)


def fresh_at(store, t):
    risks, lookup, _ = feed(t)
    store.refresh(risks, lookup, t)


def test_observation_gap_keeps_proposal_open_then_expires_after_grace(setup):
    """운영 기록상 만료 사유 1위가 vessel_stale(64%), 만료까지 중앙값 35초였다.
    AIS 공백만으로 검토 대기 제안을 닫으면 운용자가 카드를 읽을 시간이 사라진다."""
    store, _risks, _lookup, pid = setup

    gap_at(store, NOW + 10)
    p = record(store, pid)
    assert p["status"] == "open", "공백만으로 닫으면 안 된다"
    assert p["stale"] == "vessel_stale"

    # AIS 복귀 — 지연 표시가 걷히고 다시 정상 검토 대상이 된다.
    fresh_at(store, NOW + 20)
    p = record(store, pid)
    assert p["status"] == "open"
    assert "stale" not in p, "복구되면 지연 표시가 사라져야 한다"

    # 공백이 유예를 넘기면 그때는 닫는다 — 무한정 열어두지 않는다.
    gap_at(store, NOW + 30)
    gap_at(store, NOW + 30 + w.config.WATCH_STALE_GRACE_SEC + 10)
    assert record(store, pid)["status"] == "expired"


def test_system_expiry_does_not_hide_the_pair_for_the_operator_cooldown(setup):
    """운용자 기각은 30분 쉬어가야 하지만, 관측 공백으로 끝난 제안까지 30분 가리면
    위험이 계속되는 쌍이 그동안 화면에서 사라진다. 운영 기록에서 같은 쌍의
    재제안이 1800초 안에 한 건도 없던 것이 그 증거다."""
    store, _risks, _lookup, pid = setup

    gap_at(store, NOW + 10)
    expired_at = NOW + 10 + w.config.WATCH_STALE_GRACE_SEC + 10
    gap_at(store, expired_at)
    assert record(store, pid)["status"] == "expired"

    # AIS 가 돌아오면 짧은 재시도 간격 뒤 같은 쌍이 다시 올라와야 한다.
    fresh_at(store, expired_at + w.config.WATCH_RETRY_COOLDOWN_SEC + 5)
    assert any(p["status"] == "open" for p in store.list()), "시스템 사정 만료는 30분 가리면 안 된다"


def test_operator_dismissal_still_respects_the_long_cooldown(setup):
    store, risks, lookup, pid = setup
    store.decide(pid, "dismissed", "관망", "tab1", risks, lookup, NOW + 1)
    # 기각 직후 재제안이 올라오면 운용자 판단을 무시하는 셈이다.
    fresh_at(store, NOW + w.config.WATCH_RETRY_COOLDOWN_SEC + 5)
    assert not any(p["status"] == "open" for p in store.list())


def test_concurrent_approvals_only_one_executes(setup):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda c: approve(setup, c), ["tab1", "tab2"]))
    assert sum(r["execute"] for r in results) == 1


def test_dismissal_never_executes_and_cooldown(setup):
    store, risks, lookup, pid = setup
    result = store.decide(pid, "dismissed", "관망", "tab1", risks, lookup, NOW + 1)
    assert not result["execute"]
    store.refresh(risks, lookup, NOW + 2)
    assert len(store.list()) == 1
    assert not approve(setup)["execute"]


def test_receipt_lifecycle_and_stale_receipt_cannot_resurrect(setup):
    store, _risks, _lookup, pid = setup
    p = approve(setup)["proposal"]
    eid = p["execution"]["id"]
    with pytest.raises(ValueError, match="owner"):
        store.receipt(pid, eid, "other", "tracking", "", NOW + 2)
    assert store.receipt(pid, eid, "tab1", "tracking", "started", NOW + 2)["status"] == "tracking"
    assert store.receipt(pid, eid, "tab1", "tracking", "heartbeat", NOW + 3)["status"] == "tracking"
    assert len(store.list()[0]["events"]) == 3
    assert store.receipt(pid, eid, "tab1", "completed", "operator_stop", NOW + 4)["status"] == "completed"
    assert store.receipt(pid, eid, "tab1", "tracking", "late", NOW + 5)["status"] == "completed"


def test_execution_failure_and_missing_ack_are_distinct(setup):
    store, risks, lookup, pid = setup
    p = approve(setup)["proposal"]
    result = store.receipt(pid, p["execution"]["id"], "tab1", "failed", "map unavailable", NOW + 2)
    assert result["status"] == "failed"
    # A separate database demonstrates restart without a browser receipt.
    other = w.Store(store.path.parent / "other.sqlite3")
    other.refresh(risks, lookup, NOW)
    q = other.list()[0]
    other.decide(q["id"], "approved", "reason", "tab", risks, lookup, NOW + 1)
    risks["updated_at"] = NOW + 32
    for v in lookup(PAIR):
        v["_updated"] = NOW + 32
    other.refresh(risks, lookup, NOW + 32)
    assert other.list()[0]["status"] == "unknown"
    assert other.list()[0]["events"][-1]["reason"] == "execution_receipt_timeout"


def test_risk_resolution_only_with_fresh_observations(setup):
    store, risks, lookup, pid = setup
    p = approve(setup)["proposal"]
    eid = p["execution"]["id"]
    store.receipt(pid, eid, "tab1", "tracking", "started", NOW + 2)
    risks["distance"] = []
    risks["updated_at"] = NOW + 3
    store.refresh(risks, lookup, NOW + 3)
    assert store.list()[0]["status"] == "completed"
    assert store.list()[0]["events"][-1]["reason"] == "risk_no_longer_listed"


def test_write_failure_does_not_return_execution_grant(setup, monkeypatch):
    store, _risks, _lookup, _pid = setup
    monkeypatch.setattr(store, "save", lambda *args: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        approve(setup)
    assert store.list()[0]["status"] == "open"


def many_risks(t, n):
    """DCPA 가 서로 다른 n 개 쌍. 가장 위험한 것부터 정원만큼만 열려야 한다."""
    vessels, entries = [], []
    for i in range(n):
        a = dict(mmsi=500000000 + i * 2, name=f"A{i}", lat=35.0, lng=129.0, sog=12, cog=90, _updated=t)
        b = dict(mmsi=500000001 + i * 2, name=f"B{i}", lat=35.0, lng=129.04, sog=12, cog=270, _updated=t)
        vessels += [a, b]
        # i 가 클수록 덜 위험하게(DCPA 큼)
        entries.append(dict(ship_a=a, ship_b=b, dcpa_nm=0.01 * (i + 1), tcpa_min=5, ts=w.iso(t)))
    by = {v["mmsi"]: v for v in vessels}
    return dict(distance=entries, ml=[], updated_at=t), (lambda pair: [by[m] for m in pair if m in by])


def test_open_proposals_are_capped_and_worst_first(tmp_path):
    """전역 피드에서는 임계값을 조여도 근접 쌍이 수백 건씩 나온다(운영 기록 시간당
    551건). 당직자가 볼 수 있는 건 최악 몇 건이므로 정원을 두고 그 순서로 채운다."""
    store = w.Store(tmp_path / "watch.sqlite3")
    risks, lookup = many_risks(NOW, w.config.WATCH_MAX_OPEN + 8)
    store.refresh(risks, lookup, NOW)

    opened = [p for p in store.list(limit=500) if p["status"] == "open"]
    assert len(opened) == w.config.WATCH_MAX_OPEN, "정원을 넘겨 쌓이면 최악 몇 건이 묻힌다"
    worst = sorted(p["trigger"]["dcpa_nm"] for p in opened)
    assert worst == [round(0.01 * (i + 1), 10) for i in range(w.config.WATCH_MAX_OPEN)], (
        "가장 위험한 것부터 열려야 한다"
    )


def test_capacity_frees_up_when_a_proposal_closes(tmp_path):
    store = w.Store(tmp_path / "watch.sqlite3")
    risks, lookup = many_risks(NOW, w.config.WATCH_MAX_OPEN + 3)
    store.refresh(risks, lookup, NOW)
    opened = [p for p in store.list(limit=500) if p["status"] == "open"]
    store.decide(opened[0]["id"], "dismissed", "관망", "tab1", risks, lookup, NOW + 1)

    later = NOW + 5
    risks2, lookup2 = many_risks(later, w.config.WATCH_MAX_OPEN + 3)
    store.refresh(risks2, lookup2, later)
    still = [p for p in store.list(limit=500) if p["status"] == "open"]
    assert len(still) == w.config.WATCH_MAX_OPEN, "한 건을 처리하면 다음 위험이 올라와야 한다"


def test_handoff_captures_what_was_handed_over_and_scopes_decisions(tmp_path):
    """교대자는 '지난 인계 이후 무엇이 있었고 지금 무엇을 넘겨받는가' 를 봐야 한다.
    인계 기록에는 그 시점에 열려 있던 사건이 남아야 사후에 '무엇을 넘겨받았나' 가 확인된다."""
    store = w.Store(tmp_path / "watch.sqlite3")
    risks, lookup = many_risks(NOW, 3)
    store.refresh(risks, lookup, NOW)
    opened = [p for p in store.list(limit=50) if p["status"] == "open"]
    assert len(opened) == 3

    # 인계 전 판단 1건 — 첫 인계 요약(기본 창)에는 보여야 한다.
    store.decide(opened[0]["id"], "dismissed", "관망", "tab1", risks, lookup, NOW + 1)
    first = store.handoff_summary(NOW + 2)
    assert first["last_handoff"] is None
    assert [d["id"] for d in first["decisions"]] == [opened[0]["id"]]

    h = store.record_handoff("홍길동", "2번 쌍 주시", "tab1", NOW + 3)
    assert h["operator"] == "홍길동"
    assert sorted(h["open_ids"]) == sorted(p["id"] for p in opened[1:]), "인수 시점에 열린 사건이 기록돼야 한다"

    # 인계 이후 판단 1건 — 다음 요약에는 이것만 보여야 한다.
    store.decide(opened[1]["id"], "dismissed", "관망", "tab2", risks, lookup, NOW + 4)
    after = store.handoff_summary(NOW + 5)
    assert after["last_handoff"]["id"] == h["id"]
    assert [d["id"] for d in after["decisions"]] == [opened[1]["id"]], "지난 인계 이전 판단은 빠져야 한다"
    assert [p["id"] for p in after["open"]] == [opened[2]["id"]]


def test_handoff_open_cases_are_ranked_worst_first(tmp_path):
    store = w.Store(tmp_path / "watch.sqlite3")
    risks, lookup = many_risks(NOW, 4)
    store.refresh(risks, lookup, NOW)
    dcpas = [p["trigger"]["dcpa_nm"] for p in store.handoff_summary(NOW + 1)["open"]]
    assert dcpas == sorted(dcpas), "인계 화면도 제안 생성과 같은 위험 순서여야 한다"


def test_stale_cases_do_not_block_fresh_risks_from_the_board(tmp_path):
    """정원이 관측 지연 사건으로 차면 승인도 못 하는 사건이 자리를 막아, 신선하고
    더 위험한 사건이 유예 시간 동안 올라오지 못했다. 정원은 승인 가능한 사건만 센다."""
    store = w.Store(tmp_path / "watch.sqlite3")
    n = w.config.WATCH_MAX_OPEN
    risks, lookup = many_risks(NOW, n)
    store.refresh(risks, lookup, NOW)
    assert sum(p["status"] == "open" for p in store.list(limit=500)) == n

    t = NOW + 10
    risks2, lookup2 = many_risks(t, n + 1)
    for i in range(n):  # 기존 사건들만 AIS 공백
        lookup2((500000000 + i * 2,))[0]["_updated"] = t - 61
    store.refresh(risks2, lookup2, t)

    opened = [p for p in store.list(limit=500) if p["status"] == "open"]
    assert sum(1 for p in opened if p.get("stale")) == n, "지연 사건은 닫히지 않고 남는다"
    assert sum(1 for p in opened if not p.get("stale")) == 1, (
        "지연 사건이 정원을 막아 새 위험이 올라오지 못하면 안 된다"
    )


def risk_at(t, a_pos, b_pos, base=600000000):
    """두 선박 위치를 지정한 위험 쌍 하나."""
    a = dict(mmsi=base, name="A", lat=a_pos[0], lng=a_pos[1], sog=12, cog=90, _updated=t)
    b = dict(mmsi=base + 1, name="B", lat=b_pos[0], lng=b_pos[1] + 0.04, sog=12, cog=270, _updated=t)
    r = dict(ship_a=a, ship_b=b, dcpa_nm=0.05, tcpa_min=5, ts=w.iso(t))
    return r, {a["mmsi"]: a, b["mmsi"]: b}


def test_aor_filters_new_proposals_but_keeps_existing_cases_honest(tmp_path, monkeypatch):
    """담당 해역 밖 사건이 한국 해역 당직자의 정원을 차지하지 않게 한다. 다만 필터는 새 제안에만
    건다 — 이미 열린 해역 밖 사건까지 거르면 '조건 해소' 로 잘못 만료된다."""
    busan, hongkong = (35.1, 129.0), (22.3, 114.1)
    store = w.Store(tmp_path / "watch.sqlite3")

    # 필터가 없던 때 홍콩 사건이 열려 있었다.
    monkeypatch.setattr(w.config, "WATCH_AOR_BOX", None)
    hk, hk_v = risk_at(NOW, hongkong, hongkong, base=600000000)
    store.refresh(dict(distance=[hk], ml=[], updated_at=NOW), lambda pair: [hk_v[m] for m in pair], NOW)
    hk_id = next(p["id"] for p in store.list() if p["status"] == "open")

    # 한국 근해 필터를 켠다. 새 홍콩 사건은 안 올라오고 부산 사건은 올라와야 한다.
    monkeypatch.setattr(w.config, "WATCH_AOR_BOX", (32, 124, 39.5, 132))
    t = NOW + 10
    hk, hk_v = risk_at(t, hongkong, hongkong, base=600000000)
    hk2, hk2_v = risk_at(t, hongkong, hongkong, base=610000000)
    bs, bs_v = risk_at(t, busan, busan, base=620000000)
    vessels = {**hk_v, **hk2_v, **bs_v}
    store.refresh(dict(distance=[hk, hk2, bs], ml=[], updated_at=t), lambda pair: [vessels[m] for m in pair], t)

    opened = {p["id"]: p for p in store.list(limit=50) if p["status"] == "open"}
    lats = sorted(p["trigger"]["subjects"][0]["lat"] for p in opened.values())
    assert 35.1 in lats, "담당 해역 안 사건은 제안돼야 한다"
    assert not any(p["pair"][0] == 610000000 for p in opened.values()), "해역 밖 새 사건은 제안하지 않는다"
    assert hk_id in opened, "이미 열린 해역 밖 사건을 필터가 조건 해소로 닫으면 안 된다"


def test_aor_includes_pairs_that_straddle_the_boundary(monkeypatch):
    monkeypatch.setattr(w.config, "WATCH_AOR_BOX", (32, 124, 39.5, 132))
    inside, outside = {"lat": 35.0, "lng": 131.9}, {"lat": 35.0, "lng": 132.2}
    assert w.in_aor({"subjects": [inside, outside]}), "한 척이라도 안이면 우리 사건"
    assert not w.in_aor({"subjects": [outside, {"lat": 22.3, "lng": 114.1}]})
    assert w.in_aor({"subjects": [{"lat": None, "lng": None}]}), "위치를 모르면 놓치지 않는 쪽(포함)"
    monkeypatch.setattr(w.config, "WATCH_AOR_BOX", None)
    assert w.in_aor({"subjects": [outside]}), "필터를 끄면 전부 포함"


def test_bad_aor_config_fails_wide_not_narrow():
    from backend import config as c

    assert c._parse_box("32,124,39.5,132", "X") == (32, 124, 39.5, 132)
    assert c._parse_box("off", "X") is None
    # 오타·뒤바뀐 범위는 필터를 끈다 — 조용히 좁아져 위험을 놓치는 것보다 낫다.
    assert c._parse_box("32,124,oops,132", "X") is None
    assert c._parse_box("39.5,124,32,132", "X") is None


def test_only_one_backend_scans_a_database(tmp_path):
    """운영 기록: 기준이 다른 두 서버(5nm·0.3nm)가 같은 DB 를 동시에 갱신해 한 시간에 제안
    161건을 생성 직후 서로 닫았다. 임대를 쥔 한 곳만 스캔한다."""
    store = w.Store(tmp_path / "watch.sqlite3")
    lease = w.config.WATCH_SCANNER_LEASE_SEC
    assert store.acquire_scanner("server-a", NOW) == (True, "server-a")
    assert store.acquire_scanner("server-b", NOW + 1) == (False, "server-a"), "임대 중에는 다른 서버가 스캔하지 않는다"
    assert store.acquire_scanner("server-a", NOW + lease - 1) == (True, "server-a"), "쥔 서버는 계속 갱신한다"
    # 쥔 서버가 멈추면 임대가 끝난 뒤 다른 서버가 이어받는다.
    assert store.acquire_scanner("server-b", NOW + lease - 1 + lease + 1) == (True, "server-b")


def test_passive_backend_does_not_touch_proposals(tmp_path, monkeypatch):
    store = w.Store(tmp_path / "watch.sqlite3")
    store.acquire_scanner("someone-else")
    monkeypatch.setattr(w, "get_store", lambda: store)
    monkeypatch.setattr(w, "snapshot", lambda: pytest.fail("임대가 없는 서버는 스냅샷조차 뜨지 않아야 한다"))
    w.on_collision_update()  # 예외 없이 조용히 넘어가야 한다

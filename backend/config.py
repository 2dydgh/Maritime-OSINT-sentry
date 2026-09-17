import logging
import os
from dotenv import load_dotenv

load_dotenv()

# Database
DB_USER = os.getenv("DB_USER", "db_user")
DB_PASSWORD = os.getenv("DB_PASSWORD", "db_password")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "osint_4d")

# AIS
AIS_API_KEY = os.getenv("AIS_API_KEY", "")
# 구독 범위 "minLat,minLng,maxLat,maxLng". 기본값은 한국/동아시아 근해
# (동중국해·황해·일본 인근) — 전세계로 받으면 2~3만 척이 몰려 저사양 서버가 못 버틴다.
# 전세계로 받으려면 "-90,-180,90,180"으로 오버라이드.
# `or` 로 받는다: .env.example 을 복사하면 `AIS_BOUNDING_BOX=` 가 빈 문자열로 들어오는데,
# getenv 의 기본값은 "변수 없음" 에만 적용돼 빈 값이 그대로 프록시로 가고, 프록시는 빈 값을
# 전세계(-90,-180,90,180)로 해석한다 — 위 경고의 2~3만 척 상태가 된다.
AIS_BOUNDING_BOX = os.getenv("AIS_BOUNDING_BOX") or "20,110,45,145"
# 개발 중 aisstream 연결을 끄는 플래그. 라이브 키가 rate-limit/throttle 됐을 때
# 쿨다운을 방해하지 않으려고 프록시 자체를 안 띄운다. 끄면 DB fallback 으로 degrade.
AIS_DISABLED = os.getenv("DISABLE_AIS", "False").lower() in ("1", "true")

# OpenSky Network (optional credentials for higher rate limits)
OPENSKY_USERNAME = os.getenv("OPENSKY_USERNAME", "")
OPENSKY_PASSWORD = os.getenv("OPENSKY_PASSWORD", "")

# App
PORT = int(os.getenv("PORT", 8001))
DEBUG = os.getenv("DEBUG", "False").lower() == "true"
# Dev only: send Cache-Control: no-store on static assets so a plain refresh always
# fetches the latest CSS/JS (no manual ?v= cache-busting). Keep OFF in production.
DEV_NO_CACHE = os.getenv("DEV_NO_CACHE", "false").lower() in ("1", "true")

# Phase 1
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
METRICS_ENABLED = os.getenv("METRICS_ENABLED", "true").lower() == "true"

# Local durable staging for the cloud data platform (opt-in).
DATA_PLATFORM_ENABLED = os.getenv("DATA_PLATFORM_ENABLED", "false").lower() in ("1", "true")
DATA_PLATFORM_DB = os.getenv("DATA_PLATFORM_DB", "var/data-platform/journal.sqlite3")

# Operator-approved map tracking; local policy values, not navigation standards.
WATCH_DB = os.getenv("WATCH_DB", "var/data-platform/watch-officer.sqlite3")
WATCH_DCPA_NM = float(os.getenv("WATCH_DCPA_NM", "0.3"))
WATCH_TCPA_MIN = float(os.getenv("WATCH_TCPA_MIN", "10"))
WATCH_COOLDOWN_MIN = float(os.getenv("WATCH_COOLDOWN_MIN", "30"))
WATCH_MAX_ANALYSIS_AGE_SEC = float(os.getenv("WATCH_MAX_ANALYSIS_AGE_SEC", "30"))
WATCH_MAX_VESSEL_AGE_SEC = float(os.getenv("WATCH_MAX_VESSEL_AGE_SEC", "60"))
# 관측 공백을 견디는 시간. AIS 가 잠시 끊겼다고 검토 대기 제안을 즉시 만료시키면
# 운용자가 카드를 읽을 시간 자체가 사라진다(운영 기록상 만료까지 중앙값 35초).
# 승인은 decide() 가 같은 검증을 다시 하므로 안전선은 그대로다.
WATCH_STALE_GRACE_SEC = float(os.getenv("WATCH_STALE_GRACE_SEC", "300"))
# 시스템 사정(관측 공백·분석 지연)으로 끝난 제안의 재시도 간격. 운용자가 기각했을
# 때 적용하는 WATCH_COOLDOWN_MIN 과 달리 짧아야 한다 — 위험이 계속되는 쌍을
# 30분간 가리면 지휘통제 도구가 방금 탐지한 위험을 숨기는 셈이 된다.
WATCH_RETRY_COOLDOWN_SEC = float(os.getenv("WATCH_RETRY_COOLDOWN_SEC", "60"))
# 동시에 열어두는 검토 대기 제안 수. 전역 피드에서는 임계값을 조여도 근접 쌍이
# 줄지 않는다(운영 기록: 시간당 551건, DCPA 를 5nm→0.3nm 로 낮춰도 290건. 이미
# 95% 분위가 0.891nm 이라 임계값이 구속 조건이 아니다). 당직자는 수백 건을 볼 수
# 없으므로 '지금 가장 위험한 N건' 만 올린다 — 경보 목록이 아니라 우선순위 보드다.
# 관측 지연(승인 불가) 사건은 세지 않는다 — 지연 사건이 정원을 막아 새 위험을 가리지 않도록.
WATCH_MAX_OPEN = int(os.getenv("WATCH_MAX_OPEN", "10"))
# 제안 스캐너 임대 시간(초). 같은 DB 를 여는 백엔드가 여럿이면 임대를 쥔 한 곳만 제안을
# 갱신한다. 운영 기록: 12081(5nm)·12082(0.3nm) 두 서버가 동시에 돌며 한 시간에 제안 161건을
# 생성 직후 15초 안에 서로 닫았다. 충돌 분석 한 주기가 ~40초라 그보다 넉넉히 잡는다.
# 쥔 서버가 죽으면 이 시간 뒤 다른 서버가 이어받는다.
WATCH_SCANNER_LEASE_SEC = float(os.getenv("WATCH_SCANNER_LEASE_SEC", "120"))


def _parse_box(raw, name):
    """"minLat,minLng,maxLat,maxLng" → 튜플, 'off' → None(필터 없음).
    값이 틀리면 None 으로 — 넓히는 쪽으로 실패한다. 오타로 담당 해역이 조용히 좁아지면
    위험을 놓치지만, 넓어지면 사건이 더 보일 뿐이다."""
    if raw.strip().lower() in ('off', 'none', 'all'):
        return None
    try:
        min_lat, min_lng, max_lat, max_lng = (float(x) for x in raw.split(','))
        ok = -90 <= min_lat < max_lat <= 90 and -180 <= min_lng < max_lng <= 180
    except ValueError:
        ok = False
    if not ok:
        logging.getLogger(__name__).error('%s 형식이 잘못돼 무시합니다(담당 해역 필터 없음): %r', name, raw)
        return None
    return (min_lat, min_lng, max_lat, max_lng)


# 담당 해역: 제안·알림·인계를 받을 책임 범위. 수신 범위(AIS_BOUNDING_BOX, 상황판)와 별개다 —
# 수신을 좁히면 상황판까지 줄어든다. 기본은 한국 근해 사각형 근사(부산·인천·목포·제주·포항·
# 동해·울릉도·독도 포함, 홍콩·상하이·칭다오·도쿄·오사카 제외, 대한해협을 공유해 후쿠오카
# 근해는 포함). 비우면 기본값, 'off' 면 수신 범위 전체.
# ponytail: 사각형만 지원(날짜변경선을 가로지르는 범위는 거부). EEZ·작전구역 같은 다각형이
# 필요하면 이 튜플을 폴리곤으로 바꾸고 watch_officer.in_aor 만 고치면 된다.
WATCH_AOR_BOX = _parse_box(os.getenv("WATCH_AOR_BOX") or "32,124,39.5,132", "WATCH_AOR_BOX")

SCENARIO_DB = os.getenv("SCENARIO_DB", "var/data-platform/collision-scenarios.sqlite3")

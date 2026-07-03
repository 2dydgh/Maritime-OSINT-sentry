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
AIS_BOUNDING_BOX = os.getenv("AIS_BOUNDING_BOX", "20,110,45,145")
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
DEV_NO_CACHE = os.getenv("DEV_NO_CACHE", "False").lower() == "true"

# Phase 1
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
METRICS_ENABLED = os.getenv("METRICS_ENABLED", "true").lower() == "true"

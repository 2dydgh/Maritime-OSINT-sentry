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

# OpenSky Network (optional credentials for higher rate limits)
OPENSKY_USERNAME = os.getenv("OPENSKY_USERNAME", "")
OPENSKY_PASSWORD = os.getenv("OPENSKY_PASSWORD", "")

# App
PORT = int(os.getenv("PORT", 8001))
DEBUG = os.getenv("DEBUG", "False").lower() == "true"

# Phase 1
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
METRICS_ENABLED = os.getenv("METRICS_ENABLED", "true").lower() == "true"

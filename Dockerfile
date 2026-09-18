# syntax=docker/dockerfile:1

# ---------- builder: uv로 의존성만 설치 ----------
# (pyproject에 [build-system]이 없어 virtual 프로젝트 → 소스는 설치 않고 .venv에 deps만)
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# 의존성 레이어 캐싱: 락파일만 먼저 복사해 설치 (소스 변경 시 재설치 회피)
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ---------- runtime: 슬림 이미지 ----------
FROM python:3.12-slim-bookworm AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# AIS 스트림 프록시(backend/ais_proxy.js)용 Node 의존성
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 육지 차폐 필터용 GSHHG 고해상도 해안선 데이터.
# SOEST 서버 한 곳에 의존하므로 재시도·타임아웃을 두고, CI(GSHHG_REQUIRED=0)에서는 실패해도
# 빌드를 계속한다 — land_filter 는 셰이프파일이 없으면 경고만 남기고 육지 차폐 없이 동작한다.
# 운영 빌드(기본값 1)는 데이터 없이 조용히 나가지 않도록 그대로 실패시킨다.
ARG GSHHG_REQUIRED=1
RUN mkdir -p backend/data/land && \
    { curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
        -o /tmp/gshhg.zip "https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip" && \
      unzip -o /tmp/gshhg.zip "GSHHS_shp/i/GSHHS_i_L1.*" -d /tmp/ && \
      cp /tmp/GSHHS_shp/i/GSHHS_i_L1.* backend/data/land/ ; } || \
    { [ "$GSHHG_REQUIRED" = "0" ] || exit 1; echo "WARN: GSHHG 다운로드 실패 — 육지 차폐 없이 빌드합니다"; } && \
    rm -rf /tmp/gshhg.zip /tmp/GSHHS_shp

# builder가 만든 가상환경(.venv)을 복사
COPY --from=builder /app/.venv /app/.venv

# 애플리케이션 코드 (virtual 프로젝트라 cwd에서 직접 import)
COPY backend/ backend/
COPY static/ static/
COPY schema.sql ./

# uv 가상환경을 PATH에 노출
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

EXPOSE 8001

# Render/Cloud Run 등은 런타임에 $PORT를 주입한다. shell 폼으로 받아 쓰고, 없으면 8001 fallback.
CMD python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8001}

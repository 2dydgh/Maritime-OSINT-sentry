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
    curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 육지 차폐 필터용 GSHHG 고해상도 해안선 데이터
RUN mkdir -p backend/data/land && \
    curl -L -o /tmp/gshhg.zip "https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip" && \
    unzip -o /tmp/gshhg.zip "GSHHS_shp/i/GSHHS_i_L1.*" -d /tmp/ && \
    cp /tmp/GSHHS_shp/i/GSHHS_i_L1.* backend/data/land/ && \
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

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8001"]

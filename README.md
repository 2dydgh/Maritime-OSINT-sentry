# 🌊 Maritime OSINT Sentry

A high-performance, real-time maritime surveillance and intelligence dashboard. This platform integrates live AIS vessel streams, orbital satellite propagation, and automated anomaly detection into a tactical 4D geospatial interface.

![Main Interface](static/osint.gif)

## 🚀 Key Features

### 📡 Real-time Vessel Tracking (AIS)
- Live stream integration with **AisStream.io**.
- High-fidelity synchronization with CesiumJS tactical globe.
- Detailed vessel metadata: MMSI, Name, Type, SOG, COG, and Destination.

### 🛰️ Orbital Satellite Propagation (SGP4)
- Real-time calculation of intelligence-relevant satellites (Military, SAR, SIGINT).
- Robust TLE fetching logic with automatic failover.
- High-precision SGP4 propagation for accurate position, velocity, and heading.

### 🚨 Automated Anomaly Detection (Live Feed)
- **Speeding Alerts**: Automated detection of vessels exceeding operational limits (25kt+ for cargo/tankers).
- **Signal Loss Monitoring**: Real-time identification of "dark" vessels or signal dropouts.
- **Destination Changes**: Immediate notification when a vessel updates its tactical destination in mid-transit.
- **Interactive Feed**: Click-to-fly functionality that automatically selects the target vessel and opens technical dossiers.

### ⚠️ Collision Risk Analysis (Dual Engine)
- **Distance-Based Analysis**: TCPA/DCPA calculation with spatial grid filtering (5nm radius). Danger (DCPA < 0.5nm) and Warning (DCPA < 1.0nm) classification.
- **ML Model Analysis**: XGBoost-based collision risk prediction (0~3 risk levels) via da10-service. Features include COG difference, approach signal, bearing analysis, and 14 input parameters.
- **Collision Candidate Pre-filter**: Range rate + bearing validation — filters out diverging vessel pairs before analysis. Requires at least one vessel heading toward the other (within 90°).
- **Land Obstruction Filter**: Automatic exclusion of vessel pairs separated by land masses using GSHHG coastline data.
- **Interactive Visualization**:
  - COG projection lines (dashed) showing predicted vessel course over 10 minutes.
  - CPA (Closest Point of Approach) marker with real-time DCPA/TCPA labels.
  - Pulsing risk zone circle at CPA point, radius proportional to DCPA.
  - Risk level color coding: Danger (red), Warning (orange), Caution (yellow), Safe (green).

### 🖼️ Sentinel-2 Imagery Search
- Right-click contextual search for high-resolution satellite imagery via Microsoft Planetary Computer.
- Immediate thumbnail preview and metadata fetching for precise site intelligence.

## 🛠️ Tech Stack

- **Frontend**: CesiumJS, Vanilla CSS (Glassmorphism), JavaScript (ES6+).
- **Backend**: FastAPI (Python 3.12), Uvicorn.
- **Database**: PostgreSQL with PostGIS extension for spatial intelligence.
- **Collision Model**: XGBoost (da10-service), GSHHG coastline shapefile (`shapely`, `pyshp`).
- **Core Libraries**: `sgp4` (Orbital math), `asyncpg`, `apscheduler`, `websockets`, `httpx`.

## 📦 Quick Start

### 1. Prerequisites
- Python 3.12+
- PostgreSQL + PostGIS
- AISStream.io API Key

### 2. Environment Setup
Create a `.env` file in the root directory:
```env
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=osint_4d
DB_HOST=127.0.0.1
DB_PORT=5432
AIS_API_KEY=your_aisstream_key
```

### 3. Installation
```bash
pip install -r requirements.txt
```

### 4. Running the Dashboard
```bash
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

## Monitoring

Start the full stack with monitoring:

```bash
cp .env.example .env  # 환경변수 설정 후 값 수정
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

| Service | URL | Purpose |
|---------|-----|---------|
| App | http://localhost:8001 | Maritime OSINT Dashboard |
| Prometheus | http://localhost:9090 | Metrics collection |
| Grafana | http://localhost:3001 | Monitoring dashboard (admin/admin) |
| Redis | localhost:6379 | Stream pipeline |

## 🔒 Security Note
This repository includes a `.gitignore` to prevent leaking sensitive API keys and database credentials. Never commit your `.env` file.

---
*Developed as part of an Advanced Maritime OSINT Capability project.*

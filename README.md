# 🌊 Maritime OSINT Sentry

A high-performance, real-time maritime surveillance and intelligence dashboard. This platform integrates live AIS vessel streams, orbital satellite propagation, and automated anomaly detection into a tactical 4D geospatial interface.

<!-- ![Main Interface](static/screenshot_placeholder.png) *(Note: Add your actual dashboard screenshot here)* -->

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

### 🖼️ Sentinel-2 Imagery Search
- Right-click contextual search for high-resolution satellite imagery via Microsoft Planetary Computer.
- Immediate thumbnail preview and metadata fetching for precise site intelligence.

## 🛠️ Tech Stack

- **Frontend**: CesiumJS, Vanilla CSS (Glassmorphism), JavaScript (ES6+).
- **Backend**: FastAPI (Python 3.12), Uvicorn.
- **Database**: PostgreSQL with PostGIS extension for spatial intelligence.
- **Core Libraries**: `sgp4` (Orbital math), `asyncpg`, `apscheduler`, `websockets`.

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

## 🔒 Security Note
This repository includes a `.gitignore` to prevent leaking sensitive API keys and database credentials. Never commit your `.env` file.

---
*Developed as part of an Advanced Maritime OSINT Capability project.*

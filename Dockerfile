FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download GSHHG high-resolution coastline for land obstruction filter
RUN mkdir -p backend/data/land && \
    curl -L -o /tmp/gshhg.zip "https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip" && \
    unzip -o /tmp/gshhg.zip "GSHHS_shp/h/GSHHS_h_L1.*" -d /tmp/ && \
    cp /tmp/GSHHS_shp/h/GSHHS_h_L1.* backend/data/land/ && \
    rm -rf /tmp/gshhg.zip /tmp/GSHHS_shp

# Application code
COPY backend/ backend/
COPY static/ static/
COPY schema.sql .

EXPOSE 8001

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8001"]

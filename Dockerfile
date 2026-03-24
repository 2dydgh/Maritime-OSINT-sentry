FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download Natural Earth land shapefile for collision land obstruction filter
RUN mkdir -p backend/data/land && \
    curl -L -o /tmp/ne_10m_land.zip "https://naciscdn.org/naturalearth/10m/physical/ne_10m_land.zip" && \
    unzip -o /tmp/ne_10m_land.zip -d backend/data/land/ && \
    rm /tmp/ne_10m_land.zip

# Application code
COPY backend/ backend/
COPY static/ static/
COPY schema.sql .

EXPOSE 8001

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8001"]

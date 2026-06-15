import os
import json
import logging
import random
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import asyncpg
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

DB_USER = os.getenv("DB_USER", "db_user")
DB_PASSWORD = os.getenv("DB_PASSWORD", "db_password")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "osint_4d")
AIS_API_KEY = os.getenv("AIS_API_KEY", "")

# Global DB Pool
db_pool = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global db_pool
    logger.info("Initializing database connection pool...")
    try:
        db_pool = await asyncpg.create_pool(
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            host=DB_HOST,
            port=DB_PORT
        )
        logger.info("Database connection pool established.")
    except Exception as e:
        logger.error(f"Failed to connect to the database: {e}")
        raise e
    
    yield
    
    logger.info("Closing database connection pool...")
    if db_pool:
        await db_pool.close()

app = FastAPI(title="OSINT 4D Dashboard API", lifespan=lifespan)

# --- Models ---
class RawOSINTData(BaseModel):
    source_id: str
    raw_text: str

class ExtractedEvent(BaseModel):
    event_type: str = Field(description="사건의 종류 (예: 폭발, 비행통제, 병력동원 등)")
    latitude: float = Field(description="위도 (Decimal degrees)")
    longitude: float = Field(description="경도 (Decimal degrees)")
    event_time: str = Field(description="사건 발생 시간 (ISO 8601 포맷)")
    confidence_score: int = Field(description="추출된 정보의 신뢰도 (1~100)")

# --- Endpoints ---
def mock_extract_event(text: str) -> dict:
    # A simple mock extraction since we don't have the paid OpenAI API.
    # We will look for coordinates if they exist in the text, otherwise mock it.
    
    # Very basic regex mock for coordinates roughly near the Middle East
    base_lat = 35.6892
    base_lon = 51.3134
    
    # Try somewhat parsing dates or assume current
    current_time = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    
    event_type = "explosion" if "폭발" in text or "explosion" in text.lower() else "unknown_movement"
    
    return {
        "event_type": event_type,
        "latitude": base_lat + random.uniform(-0.1, 0.1),
        "longitude": base_lon + random.uniform(-0.1, 0.1),
        "event_time": current_time,
        "confidence_score": random.randint(70, 95)
    }


@app.post("/api/v1/process-osint", response_model=ExtractedEvent)
async def process_osint_text(data: RawOSINTData):
    try:
        logger.info(f"Processing OSINT text source {data.source_id}")
        
        # Using MOCK logic instead of OpenAI AI to extract from text
        extracted_json = mock_extract_event(data.raw_text)
        logger.info(f"Mock Extracted JSON: {extracted_json}")
        
        extracted_data = ExtractedEvent(**extracted_json)
        
        # Clean event time string
        event_time_str = extracted_data.event_time.replace("Z", "+00:00")
        dt_val = datetime.fromisoformat(event_time_str)
        
        async with db_pool.acquire() as conn:
            insert_query = """
                INSERT INTO military_events (source_id, event_type, event_time, geom, confidence)
                VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6)
                RETURNING id;
            """
            event_id = await conn.fetchval(
                insert_query,
                data.source_id,
                extracted_data.event_type,
                dt_val,
                extracted_data.longitude,
                extracted_data.latitude,
                extracted_data.confidence_score
            )
            logger.info(f"Inserted event with ID: {event_id}")
        
        return extracted_data

    except Exception as e:
        logger.error(f"Error processing OSINT data: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/events")
async def get_military_events():
    try:
        async with db_pool.acquire() as conn:
            query = """
                SELECT json_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(json_agg(ST_AsGeoJSON(t.*)::json), '[]'::json)
                ) AS geojson
                FROM (
                    SELECT id, event_type, event_time, confidence, geom 
                    FROM military_events
                ) AS t;
            """
            result = await conn.fetchval(query)
            
            # Use json.loads because fetchval returns a string of JSON in this context
            if isinstance(result, str):
                return json.loads(result)
            return result
    except Exception as e:
        logger.error(f"Error fetching events: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/restricted-areas")
async def get_restricted_areas():
    try:
        async with db_pool.acquire() as conn:
            query = """
                SELECT json_build_object(
                    'type', 'FeatureCollection',
                    'features', COALESCE(json_agg(ST_AsGeoJSON(t.*)::json), '[]'::json)
                ) AS geojson
                FROM (
                    SELECT id, area_type, start_time, end_time, source_agency, geom 
                    FROM restricted_areas
                    WHERE is_active = TRUE
                ) AS t;
            """
            result = await conn.fetchval(query)
            
            if isinstance(result, str):
                return json.loads(result)
            return result
    except Exception as e:
        logger.error(f"Error fetching restricted areas: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/config")
async def get_config():
    return {"ais_api_key": AIS_API_KEY}

@app.get("/api/v1/trajectories")
async def get_trajectories():
    czml = [
        {
            "id": "document",
            "name": "OSINT 4D Trajectories",
            "version": "1.0",
            "clock": {
                "interval": "2023-10-24T00:00:00Z/2023-10-25T00:00:00Z",
                "currentTime": "2023-10-24T00:00:00Z",
                "multiplier": 3600,
                "range": "LOOP_STOP",
                "step": "SYSTEM_CLOCK_MULTIPLIER"
            }
        }
    ]
    
    # Generate 5 random drones
    for i in range(1, 6):
        lat_offset = random.uniform(-2.0, 2.0)
        lon_offset = random.uniform(-2.0, 2.0)
        
        czml.append({
            "id": f"Aircraft_{i}",
            "name": f"Surveillance Drone {i}",
            "availability": "2023-10-24T00:00:00Z/2023-10-25T00:00:00Z",
            "description": f"Simulated drone {i} flying.",
            "point": {
                "color": { "rgba": [0, 255, 0, 255] },
                "pixelSize": 10,
                "outlineColor": { "rgba": [255, 255, 255, 255] },
                "outlineWidth": 2
            },
            "path": {
                "material": {
                    "solidColor": {
                        "color": {
                            "rgba": [0, 255, 255, 150]
                        }
                    }
                },
                "width": 3,
                "leadTime": 0,
                "trailTime": 86400,
                "resolution": 5
            },
            "position": {
                "interpolationAlgorithm": "LINEAR",
                "interpolationDegree": 1,
                "epoch": "2023-10-24T00:00:00Z",
                "cartographicDegrees": [
                    0,     45.0 + lon_offset, 30.0 + lat_offset, 5000.0,
                    14400, 48.0 + lon_offset, 31.0 + lat_offset, 5000.0,
                    28800, 51.0 + lon_offset, 35.0 + lat_offset, 5000.0,
                    43200, 53.0 + lon_offset, 34.0 + lat_offset, 5000.0,
                    86400, 45.0 + lon_offset, 30.0 + lat_offset, 5000.0
                ]
            }
        })

    # Add a High-Altitude Reconnaissance Satellite (Blue Orbit)
    czml.append({
        "id": "Satellite_1",
        "name": "LEO Recon Satellite",
        "availability": "2023-10-24T00:00:00Z/2023-10-25T00:00:00Z",
        "description": "A low earth orbit spy satellite passing over the region.",
        "point": {
            "color": { "rgba": [0, 0, 255, 255] },
            "pixelSize": 15,
            "outlineColor": { "rgba": [255, 255, 255, 255] },
            "outlineWidth": 2
        },
        "path": {
            "material": { "solidColor": { "color": { "rgba": [0, 100, 255, 200] } } },
            "width": 4,
            "leadTime": 0,
            "trailTime": 86400,
            "resolution": 1
        },
        "position": {
            "interpolationAlgorithm": "LAGRANGE", # Lagrangian interpolation for curved orbital paths
            "interpolationDegree": 5,
            "epoch": "2023-10-24T00:00:00Z",
            "cartographicDegrees": [
                0,     30.0, 15.0, 400000.0,  # Orbiting at 400km altitude
                21600, 40.0, 25.0, 400000.0,  # +6 hours
                43200, 50.0, 35.0, 400000.0,  # +12 hours (Over target region)
                64800, 60.0, 45.0, 400000.0,  # +18 hours
                86400, 70.0, 55.0, 400000.0   # +24 hours
            ]
        }
    })

    # Add a Ballistic Missile with a Parabolic Trajectory (Red)
    czml.append({
        "id": "Missile_1",
        "name": "Ballistic Missile Launch",
        "availability": "2023-10-24T12:00:00Z/2023-10-24T12:30:00Z", # Very short availability (30 mins flight time)
        "description": "A simulated ballistic missile launch",
        "point": {
            "color": { "rgba": [255, 0, 0, 255] }, # Red point
            "pixelSize": 12,
            "outlineColor": { "rgba": [255, 255, 0, 255] },
            "outlineWidth": 3
        },
        "path": {
            "material": { "solidColor": { "color": { "rgba": [255, 50, 50, 255] } } },
            "width": 5,
            "leadTime": 0,
            "trailTime": 86400,
            "resolution": 1
        },
        "position": {
            "interpolationAlgorithm": "LAGRANGE", # Parabolic interpolation
            "interpolationDegree": 3,
            "epoch": "2023-10-24T12:00:00Z",      # Starts at noon
            "cartographicDegrees": [
                0,    48.0, 30.0, 0.0,        # Launch (Ground level)
                450,  50.0, 32.0, 150000.0,   # Apogee (150km out into space midway)
                900,  52.0, 34.0, 0.0         # Impact (15 mins later back at ground)
            ]
        }
    })
        
    return czml

# Note: Ensure you run the server from the directory containing `static`
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)

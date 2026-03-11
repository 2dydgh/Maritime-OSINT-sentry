import asyncio
import httpx
import random

event_templates = [
    "Explosion reported near {lat}, {lon}",
    "Troop movements spotted at {lat}, {lon}",
    "Air raid sirens going off at {lat}, {lon}",
    "Suspicious military convoy seen heading towards {lat}, {lon}",
    "Unknown drones flying over {lat}, {lon}"
]

async def insert_events():
    base_lat = 33.0
    base_lon = 48.0
    
    async with httpx.AsyncClient() as client:
        for i in range(15):
            lat = base_lat + random.uniform(-10.0, 10.0)
            lon = base_lon + random.uniform(-10.0, 10.0)
            
            text = random.choice(event_templates).format(lat=round(lat, 4), lon=round(lon, 4))
            
            payload = {
                "source_id": f"mock_tweet_{i}",
                "raw_text": text
            }
            
            try:
                res = await client.post("http://localhost:8000/api/v1/process-osint", json=payload, timeout=10.0)
                if res.status_code == 200:
                    print(f"Inserted event {i}: {text}")
                else:
                    print(f"Failed to insert event {i}: {res.text}")
            except Exception as e:
                print(f"Error {i}: {e}")

if __name__ == "__main__":
    asyncio.run(insert_events())

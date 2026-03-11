import asyncio
import httpx

async def run_test():
    async with httpx.AsyncClient() as client:
        # Test 1: Insert OSINT Event
        try:
            print("Testing POST /api/v1/process-osint...")
            payload = {
                "source_id": "test_tweet_1",
                "raw_text": "Breaking: Explosion reported near military base at 35.6892, 51.3134. Timing exactly at 2023-10-24T18:30:00Z"
            }
            res = await client.post("http://localhost:8000/api/v1/process-osint", json=payload, timeout=20.0)
            if res.status_code == 200:
                print("1. Event inserted successfully:\n", res.json())
            else:
                print("1. Failed to insert event:", res.text)
        except Exception as e:
            print("Error during insertion:", e)

        # Test 2: Fetch Events GeoJSON
        try:
            print("\nTesting GET /api/v1/events...")
            res = await client.get("http://localhost:8000/api/v1/events")
            if res.status_code == 200:
                print("2. Fetched events successfully:\n", res.json())
            else:
                print("2. Failed to fetch events:", res.text)
        except Exception as e:
            print("Error during fetching:", e)

if __name__ == "__main__":
    asyncio.run(run_test())

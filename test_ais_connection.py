import asyncio
import json
import os
import websockets
from dotenv import load_dotenv

load_dotenv()

async def test_ais():
    api_key = os.getenv("AIS_API_KEY")
    if not api_key:
        print("Error: AIS_API_KEY not found in .env")
        return

    print(f"Testing AIS with key: {api_key[:5]}...")
    
    # Korea Bounding Box
    bb = [[[33, 124], [39, 132]]]
    
    async with websockets.connect("wss://stream.aisstream.io/v0/stream") as websocket:
        subscribe_msg = {
            "APIKey": api_key,
            "BoundingBoxes": bb,
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"]
        }
        
        await websocket.send(json.dumps(subscribe_msg))
        print("Subscription sent for Korea region...")
        
        try:
            # Wait for up to 30 seconds for any message
            for _ in range(10):
                msg = await asyncio.wait_for(websocket.recv(), timeout=10)
                data = json.loads(msg)
                print(f"Received message type: {data.get('MessageType')}")
                if "MetaData" in data:
                    print(f"Ship: {data['MetaData'].get('ShipName')} (MMSI: {data['MetaData'].get('MMSI')})")
                break # We just need to see one message to confirm it works
        except asyncio.TimeoutError:
            print("Timeout: No messages received in 30 seconds.")
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    try:
        import websockets
    except ImportError:
        print("Installing websockets library...")
        os.system("pip install websockets")
    
    asyncio.run(test_ais())

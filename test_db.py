import asyncpg
import asyncio

async def test():
    conn = await asyncpg.connect(user='db_user', password='db_password', database='osint_4d', host='127.0.0.1')
    print("DB Connection Success! Result: ", await conn.fetchval('SELECT 1'))
    await conn.close()

asyncio.run(test())

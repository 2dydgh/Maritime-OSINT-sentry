import asyncio
import logging
from . import config

logger = logging.getLogger(__name__)

db_pool = None

try:
    import asyncpg
    _HAS_ASYNCPG = True
except ImportError:
    _HAS_ASYNCPG = False
    logger.info("asyncpg not installed — running without database (lightweight mode)")

async def init_db():
    global db_pool
    if not _HAS_ASYNCPG:
        logger.info("Database disabled (asyncpg not installed)")
        return
    try:
        db_pool = await asyncio.wait_for(
            asyncpg.create_pool(
                user=config.DB_USER,
                password=config.DB_PASSWORD,
                database=config.DB_NAME,
                host=config.DB_HOST,
                port=config.DB_PORT,
            ),
            timeout=5,
        )
        logger.info("Database connection pool established.")
    except Exception as e:
        logger.warning(f"Database not available — running without DB: {e}")
        db_pool = None

async def close_db():
    global db_pool
    if db_pool and _HAS_ASYNCPG:
        await db_pool.close()
        logger.info("Database connection pool closed.")

def get_db_pool():
    return db_pool

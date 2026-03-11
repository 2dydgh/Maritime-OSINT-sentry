import asyncpg
import logging
from . import config

logger = logging.getLogger(__name__)

db_pool = None

async def init_db():
    global db_pool
    try:
        db_pool = await asyncpg.create_pool(
            user=config.DB_USER,
            password=config.DB_PASSWORD,
            database=config.DB_NAME,
            host=config.DB_HOST,
            port=config.DB_PORT
        )
        logger.info("Database connection pool established.")
    except Exception as e:
        logger.error(f"Failed to connect to the database: {e}")
        raise e

async def close_db():
    global db_pool
    if db_pool:
        await db_pool.close()
        logger.info("Database connection pool closed.")

def get_db_pool():
    return db_pool

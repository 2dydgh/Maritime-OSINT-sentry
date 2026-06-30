"""Chat API endpoint for LLM agent interaction."""

from fastapi import APIRouter
from pydantic import BaseModel
import logging

from backend.services import llm_agent

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    history: list = []
    context: dict = {}


class ChatResponse(BaseModel):
    text: str
    actions: list = []
    plan: dict | None = None  # present on planned (multi-step) turns


@router.post("/chat", response_model=ChatResponse)
async def post_chat(req: ChatRequest):
    """Process a chat message through the maritime LLM agent."""
    try:
        result = await llm_agent.chat(req.message, req.history, req.context)
    except Exception:
        logger.exception("LLM agent chat() failed")
        return ChatResponse(
            text="죄송합니다. 지금은 응답을 생성할 수 없습니다. 잠시 후 다시 시도해 주세요.",
            actions=[],
            plan=None,
        )
    return ChatResponse(
        text=result["text"],
        actions=result["actions"],
        plan=result.get("plan"),
    )

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


@router.post("/chat", response_model=ChatResponse)
async def post_chat(req: ChatRequest):
    """Process a chat message through the maritime LLM agent."""
    result = await llm_agent.chat(req.message, req.history, req.context)
    return ChatResponse(text=result["text"], actions=result["actions"])

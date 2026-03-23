"""LangChain and CrewAI compatible tools for Central Intelligence."""

from typing import Optional, Type
from pydantic import BaseModel, Field

try:
    from langchain_core.tools import BaseTool
except ImportError:
    from langchain.tools import BaseTool

from .client import CentralIntelligence


# --- Input Schemas ---

class RememberInput(BaseModel):
    content: str = Field(description="The information to remember for later recall")
    tags: Optional[list[str]] = Field(default=None, description="Optional tags for categorization")

class RecallInput(BaseModel):
    query: str = Field(description="Natural language search query to find relevant memories")
    limit: int = Field(default=5, description="Maximum number of memories to return")

class ContextInput(BaseModel):
    query: str = Field(description="Description of the current task to load relevant context")

class ForgetInput(BaseModel):
    memory_id: str = Field(description="The ID of the memory to delete")

class ShareInput(BaseModel):
    memory_id: str = Field(description="The ID of the memory to share")
    scope: str = Field(description="Visibility scope: 'agent', 'user', or 'org'")


# --- Tools ---

class CIRememberTool(BaseTool):
    """Store information for later recall. Builds persistent memory across sessions."""

    name: str = "ci_remember"
    description: str = (
        "Store information in persistent memory for later recall. "
        "Use this to save user preferences, project decisions, architecture notes, "
        "debugging insights, or any knowledge that should persist across sessions."
    )
    args_schema: Type[BaseModel] = RememberInput
    ci: CentralIntelligence = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, content: str, tags: Optional[list[str]] = None) -> str:
        result = self.ci.remember(content, tags=tags)
        memory = result.get("memory", {})
        return f"Remembered (ID: {memory.get('id', 'unknown')[:8]}...)"

    async def _arun(self, content: str, tags: Optional[list[str]] = None) -> str:
        return self._run(content, tags)


class CIRecallTool(BaseTool):
    """Semantic search across all stored memories."""

    name: str = "ci_recall"
    description: str = (
        "Search persistent memory using natural language. "
        "Finds relevant information by meaning, not just keywords. "
        "Use this to retrieve past decisions, preferences, or context."
    )
    args_schema: Type[BaseModel] = RecallInput
    ci: CentralIntelligence = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, query: str, limit: int = 5) -> str:
        result = self.ci.recall(query, limit=limit)
        memories = result.get("memories", [])
        if not memories:
            return "No relevant memories found."
        lines = []
        for m in memories:
            score = f" ({m['similarity']:.0%})" if "similarity" in m else ""
            lines.append(f"- {m['content'][:200]}{score}")
        return f"Found {len(memories)} memories:\n" + "\n".join(lines)

    async def _arun(self, query: str, limit: int = 5) -> str:
        return self._run(query, limit)


class CIContextTool(BaseTool):
    """Auto-load relevant memories for the current task."""

    name: str = "ci_context"
    description: str = (
        "Load all relevant memories for the current task. "
        "Describe what you're working on and get back everything you knew before. "
        "Use this at the start of a session to restore context."
    )
    args_schema: Type[BaseModel] = ContextInput
    ci: CentralIntelligence = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, query: str) -> str:
        result = self.ci.context(query)
        memories = result.get("memories", [])
        if not memories:
            return "No relevant context found."
        lines = [f"- {m['content'][:200]}" for m in memories]
        return f"Loaded {len(memories)} relevant memories:\n" + "\n".join(lines)

    async def _arun(self, query: str) -> str:
        return self._run(query)


class CIForgetTool(BaseTool):
    """Delete a memory by ID."""

    name: str = "ci_forget"
    description: str = "Delete a specific memory by its ID. Use to remove outdated or incorrect information."
    args_schema: Type[BaseModel] = ForgetInput
    ci: CentralIntelligence = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, memory_id: str) -> str:
        result = self.ci.forget(memory_id)
        return "Memory deleted." if result.get("deleted") else f"Failed: {result.get('error', 'unknown')}"

    async def _arun(self, memory_id: str) -> str:
        return self._run(memory_id)


class CIShareTool(BaseTool):
    """Share a memory across scopes (agent, user, org)."""

    name: str = "ci_share"
    description: str = (
        "Change a memory's visibility scope. Share knowledge between agents (agent scope), "
        "across all agents for a user (user scope), or organization-wide (org scope)."
    )
    args_schema: Type[BaseModel] = ShareInput
    ci: CentralIntelligence = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, memory_id: str, scope: str) -> str:
        result = self.ci.share(memory_id, scope)
        return f"Memory shared with scope: {scope}" if result.get("shared") else f"Failed: {result.get('error', 'unknown')}"

    async def _arun(self, memory_id: str, scope: str) -> str:
        return self._run(memory_id, scope)


def get_ci_tools(
    api_key: Optional[str] = None,
    agent_id: str = "langchain-agent",
    base_url: str = "https://central-intelligence-api.fly.dev",
) -> list[BaseTool]:
    """Get all Central Intelligence tools ready for LangChain/CrewAI.

    Usage with LangChain:
        from central_intelligence import get_ci_tools
        tools = get_ci_tools(api_key="ci_sk_...")
        agent = initialize_agent(tools=tools, llm=llm)

    Usage with CrewAI:
        from central_intelligence import get_ci_tools
        tools = get_ci_tools(api_key="ci_sk_...")
        agent = Agent(role="...", tools=tools)
    """
    ci = CentralIntelligence(api_key=api_key, agent_id=agent_id, base_url=base_url)
    return [
        CIRememberTool(ci=ci),
        CIRecallTool(ci=ci),
        CIContextTool(ci=ci),
        CIForgetTool(ci=ci),
        CIShareTool(ci=ci),
    ]

"""Core HTTP client for Central Intelligence API."""

import os
import httpx
from typing import Optional


class CentralIntelligence:
    """Client for the Central Intelligence persistent memory API."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://central-intelligence-api.fly.dev",
        agent_id: str = "default",
    ):
        self.api_key = api_key or os.environ.get("CI_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.agent_id = agent_id
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    def remember(
        self,
        content: str,
        tags: Optional[list[str]] = None,
        scope: str = "agent",
        user_id: Optional[str] = None,
    ) -> dict:
        """Store a memory for later recall."""
        payload = {
            "agent_id": self.agent_id,
            "content": content,
            "scope": scope,
        }
        if tags:
            payload["tags"] = tags
        if user_id:
            payload["user_id"] = user_id
        resp = self._client.post("/memories/remember", json=payload)
        resp.raise_for_status()
        return resp.json()

    def recall(
        self,
        query: str,
        limit: int = 5,
        scope: Optional[str] = None,
    ) -> dict:
        """Semantic search across stored memories."""
        payload = {
            "agent_id": self.agent_id,
            "query": query,
            "limit": limit,
        }
        if scope:
            payload["scope"] = scope
        resp = self._client.post("/memories/recall", json=payload)
        resp.raise_for_status()
        return resp.json()

    def context(self, query: str) -> dict:
        """Auto-load relevant memories for the current task."""
        resp = self._client.post(
            "/memories/context",
            json={"agent_id": self.agent_id, "query": query},
        )
        resp.raise_for_status()
        return resp.json()

    def forget(self, memory_id: str) -> dict:
        """Delete a memory by ID."""
        resp = self._client.post(
            "/memories/forget",
            json={"agent_id": self.agent_id, "memory_id": memory_id},
        )
        resp.raise_for_status()
        return resp.json()

    def share(self, memory_id: str, scope: str) -> dict:
        """Change a memory's visibility scope."""
        resp = self._client.post(
            "/memories/share",
            json={
                "agent_id": self.agent_id,
                "memory_id": memory_id,
                "scope": scope,
            },
        )
        resp.raise_for_status()
        return resp.json()

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

---
name: central-intelligence
description: >
  Persistent memory across sessions. Remember facts, recall them later with
  semantic search, and share knowledge between agents. Use when you need to
  store information for later, load context from past sessions, or forget
  outdated memories. Five commands: remember, recall, context, forget, share.
version: 1.0.0
license: MIT
metadata:
  author: AlekseiMarchenko
  homepage: https://centralintelligence.online
  repository: https://github.com/AlekseiMarchenko/central-intelligence
  tags:
    - memory
    - persistence
    - knowledge
    - context
    - recall
    - semantic-search
  openclaw:
    env:
      required:
        - CI_API_KEY
    user-invocable: true
---

# Central Intelligence — Persistent Memory for AI Agents

You now have persistent memory. Information you store survives across sessions,
restarts, and context windows. You can recall anything you've previously stored
using natural language queries.

## Setup

The environment variable `CI_API_KEY` must be set. If it is not set, tell the
user to run this command to get a free API key:

```bash
npx central-intelligence-cli signup
```

Then set it: `export CI_API_KEY=ci_sk_...`

## API Base

```
https://central-intelligence-api.fly.dev
```

All requests use `Authorization: Bearer $CI_API_KEY` header.

## Commands

### 1. Remember — Store a memory

When you learn something important (user preferences, project decisions,
architecture choices, debugging insights, environment details), store it.

```bash
curl -s -X POST https://central-intelligence-api.fly.dev/memories/remember \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "YOUR_AGENT_NAME",
    "content": "The fact or insight to remember",
    "tags": ["optional", "tags"],
    "scope": "agent"
  }'
```

**When to remember:**
- User states a preference ("I prefer TypeScript", "Always use dark mode")
- A project decision is made ("We chose PostgreSQL over MongoDB")
- You discover something about the environment ("Node 22, macOS, Homebrew")
- A bug fix reveals an insight worth keeping

### 2. Recall — Search past memories

Retrieve memories using natural language. Returns semantically similar results.

```bash
curl -s https://central-intelligence-api.fly.dev/memories/recall \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "YOUR_AGENT_NAME",
    "query": "what programming language does the user prefer",
    "top_k": 5
  }'
```

**When to recall:**
- Starting a new session (recall general context)
- Before making a decision that might conflict with past preferences
- When the user references something from a previous conversation

### 3. Context — Auto-load relevant memories

Load memories relevant to the current task. Use this at the start of every session.

```bash
curl -s https://central-intelligence-api.fly.dev/memories/recall \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "YOUR_AGENT_NAME",
    "query": "important context preferences decisions",
    "top_k": 10
  }'
```

**Always run context at session start** to load relevant memories from past sessions.

### 4. Forget — Delete outdated memories

Remove memories that are no longer accurate or relevant.

```bash
curl -s -X POST https://central-intelligence-api.fly.dev/memories/forget \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "YOUR_AGENT_NAME",
    "memory_id": "uuid-of-memory-to-forget"
  }'
```

### 5. Share — Share memories across scopes

Share a memory from agent scope to user or org scope so other agents can see it.

```bash
curl -s -X POST https://central-intelligence-api.fly.dev/memories/share \
  -H "Authorization: Bearer $CI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "memory_id": "uuid-of-memory",
    "target_scope": "user"
  }'
```

Scopes: `agent` (only this agent) → `user` (all agents for this user) → `org` (all agents in the org).

## Behavior Rules

1. **Session start**: Always run a context query to load relevant past memories.
2. **Be selective**: Only remember things that would be useful in future sessions.
   Don't store transient information like "running npm install now".
3. **Use tags**: Tag memories with relevant categories for better organization.
4. **Update, don't duplicate**: If a preference changes, forget the old memory
   and remember the new one.
5. **Respect scope**: Use `agent` scope by default. Only share to `user` or `org`
   when the information is relevant to other agents.

## Response Format

All API responses return JSON. Recall returns an array of memories with
similarity scores:

```json
{
  "memories": [
    {
      "id": "uuid",
      "content": "User prefers TypeScript over JavaScript",
      "tags": ["preferences", "language"],
      "scope": "agent",
      "similarity": 0.89,
      "created_at": "2026-03-23T10:00:00Z"
    }
  ]
}
```

## Error Handling

- `401` — Invalid or missing API key. Tell user to run `npx central-intelligence-cli signup`.
- `429` — Rate limited. Wait and retry.
- `500` — Server error. Retry once, then inform the user.

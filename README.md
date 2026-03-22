# Central Intelligence

**Agents forget. CI remembers.**

Persistent memory for AI agents. Store, recall, and share information across sessions. Works with Claude Code, Cursor, LangChain, CrewAI, and any agent that supports MCP.

## Quick Start (30 seconds)

```bash
# 1. Install the CLI
npm install -g central-intelligence-cli

# 2. Get an API key
ci signup

# 3. Add to Claude Code
ci init claude

# Done. Your agent now has persistent memory.
```

## What It Does

AI agents lose all context between sessions. Central Intelligence gives them a long-term memory:

- **`remember`** — Store information for later ("User prefers TypeScript", "Auth uses JWT tokens", "Deploy to us-east-1")
- **`recall`** — Semantic search across past memories ("What does the user prefer?", "How does auth work?")
- **`context`** — Auto-load relevant memories for the current conversation
- **`forget`** — Delete outdated memories
- **`share`** — Make memories available to other agents in your org

## How It Works

```
Agent (Claude, GPT, etc.)
    ↓ MCP protocol
Central Intelligence MCP Server (local, thin client)
    ↓ HTTPS
Central Intelligence API (hosted)
    ↓
PostgreSQL + pgvector (semantic search)
```

Memories are stored as text with vector embeddings. Recall uses cosine similarity to find semantically relevant memories, not just keyword matches.

## Memory Scopes

| Scope | Visible to | Use case |
|-------|-----------|----------|
| `agent` | Only the agent that stored it | Personal context, session continuity |
| `user` | All agents serving the same user | User preferences, cross-tool context |
| `org` | All agents in the organization | Shared knowledge, team decisions |

## MCP Server Setup (Manual)

If you prefer manual setup over `ci init`:

### Claude Code

Add to `~/.claude/mcp_servers.json`:

```json
{
  "central-intelligence": {
    "command": "npx",
    "args": ["-y", "@central-intelligence/mcp-server"],
    "env": {
      "CI_API_KEY": "your-api-key"
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp_servers.json` (same format as above).

## CLI Usage

```bash
# Store a memory
ci remember "The user prefers dark mode and TypeScript"

# Search memories
ci recall "what are the user's preferences?"

# Delete a memory
ci forget <memory-id>

# Check connection
ci status
```

## REST API

All endpoints require `Authorization: Bearer <api-key>` header.

### POST /memories/remember
```json
{
  "agent_id": "my-agent",
  "content": "User prefers TypeScript over Python",
  "tags": ["preference", "language"],
  "scope": "user"
}
```

### POST /memories/recall
```json
{
  "agent_id": "my-agent",
  "query": "what programming language does the user prefer?",
  "limit": 5,
  "scope": "user"
}
```

### POST /memories/context
```json
{
  "agent_id": "my-agent",
  "current_context": "Setting up a new web project for the user",
  "max_memories": 5
}
```

### DELETE /memories/:id

### POST /memories/:id/share
```json
{
  "target_scope": "org"
}
```

## Self-Hosting

```bash
# Clone and install
git clone https://github.com/central-intelligence/central-intelligence.git
cd central-intelligence
npm install

# Set up PostgreSQL with pgvector
createdb central_intelligence
npm run db:migrate

# Configure
cp .env.example .env
# Edit .env with your DATABASE_URL and OPENAI_API_KEY

# Run
npm run dev:api
```

### Deploy to Fly.io

```bash
fly apps create central-intelligence-api
fly postgres create --name ci-db
fly postgres attach ci-db
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

## Architecture

```
central-intelligence/
├── packages/
│   ├── api/          # Backend API (Hono + PostgreSQL + pgvector)
│   │   └── src/
│   │       ├── db/           # Schema, migrations, connection
│   │       ├── middleware/    # Auth middleware
│   │       ├── routes/       # API endpoints
│   │       └── services/     # Business logic (memories, embeddings, auth)
│   ├── mcp-server/   # MCP server (distributed via npm)
│   └── cli/          # CLI tool (`ci` command)
├── Dockerfile
├── fly.toml
└── README.md
```

## License

MIT

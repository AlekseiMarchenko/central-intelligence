# Central Intelligence

**Agents forget. CI remembers.**

Persistent memory for AI agents. Store, recall, and share information across sessions. Works with Claude Code, Cursor, LangChain, CrewAI, and any agent that supports MCP.

**CI never rewrites your memories.** Facts are extracted for search, but your content is always returned verbatim. No junk memories, no hallucinated rewrites, no data loss.

[![npm](https://img.shields.io/npm/v/central-intelligence-mcp)](https://www.npmjs.com/package/central-intelligence-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)


[![Central Intelligence MCP server](https://glama.ai/mcp/servers/AlekseiMarchenko/central-intelligence/badges/card.svg)](https://glama.ai/mcp/servers/AlekseiMarchenko/central-intelligence)

[![LifeBench 45.9%](https://img.shields.io/badge/LifeBench_(2026)-45.9%25-6d5aff?style=for-the-badge)](https://arxiv.org/abs/2603.03781)
[![AMB 90/100](https://img.shields.io/badge/AMB_Score-90%2F100_(A%2B)-22c55e?style=for-the-badge)](https://github.com/AlekseiMarchenko/agent-memory-benchmark)

## Quick Start (30 seconds)

```bash
# 1. Get an API key
npx central-intelligence-cli signup

# 2. Add to Claude Code
npx central-intelligence-cli init claude

# Done. Your agent now has persistent memory.
```

## When to Use Central Intelligence

> **Heuristic:** If you would write it in a note to your future self, store it in Central Intelligence.

| Scenario | What to do |
|----------|-----------|
| Starting a new session, need context from before | `recall` or `context` |
| Discovered something important (architecture, preferences, fixes) | `remember` |
| Multiple agents working on the same project | `share` with user/org scope |
| You keep re-learning the same things each session | `remember` once, `recall` forever |
| Handing off a task to another agent or session | `remember` key decisions, next agent calls `context` |
| User tells you the same preferences repeatedly | `remember` them, check with `recall` next time |

**Don't store:** secrets, passwords, API keys, PII, large binary files, or ephemeral scratch data.

## The Problem

Every AI agent session starts from zero. Your agent learns your preferences, understands your codebase, figures out your architecture — then the session ends and it forgets everything. Next session? Same questions. Same mistakes. Same context-building from scratch.

Central Intelligence fixes this.

## What It Does

Five MCP tools give your agent a long-term memory:

| Tool | Description | Example |
|------|-------------|---------|
| **`remember`** | Store information for later | "User prefers TypeScript and deploys to Fly.io" |
| **`recall`** | Semantic search across past memories | "What does the user prefer?" |
| **`context`** | Auto-load relevant memories for the current task | "Working on the auth system refactor" |
| **`forget`** | Delete outdated or incorrect memories | `forget("memory_abc123")` |
| **`share`** | Make memories available to other agents | scope: "agent" → "org" |

## Benchmarks

### LifeBench (2026) — Long-Term Multi-Source Memory

CI scores **45.9%** on [LifeBench](https://arxiv.org/abs/2603.03781), the hardest published memory benchmark (2,003 questions across 10 users, 51K real-world events including messages, calendar, health records, notes, and calls).

| Overall | Info Extraction | Multi-hop | Temporal |
|---------|-----------------|-----------|----------|
| **45.9%** | **52.8%** | **45.6%** | **39.3%** |

Evaluation harness: [lifebench-eval](https://github.com/AlekseiMarchenko/lifebench-eval)

### Agent Memory Benchmark (AMB) — Infrastructure Testing

Test CI against other providers using the open-source [Agent Memory Benchmark](https://github.com/AlekseiMarchenko/agent-memory-benchmark):

```bash
npx agent-memory-benchmark --provider central-intelligence --api-key $CI_API_KEY
```

> **Note:** AMB is maintained by the same author as Central Intelligence. Run it yourself and verify the results. PRs with new provider adapters are welcome.

## Cross-Tool Memory (NEW in v0.5.0)

CI Local reads config files from **5 AI coding platforms** and makes them searchable alongside your stored memories:

| Platform | Config file | How it's parsed |
|----------|------------|-----------------|
| Claude Code | `CLAUDE.md` | Section-based (## headings) |
| Cursor | `.cursor/rules` | Paragraph-based |
| Windsurf | `.windsurf/rules` | Paragraph-based |
| Codex | `codex.md` | Section-based |
| GitHub Copilot | `.github/copilot-instructions.md` | Section-based |

Memories stored via Claude Code are discoverable when using Cursor, and vice versa. Your AI memory works everywhere, not just in one tool.

Recall responses now include `source` (which tool the memory came from), `freshness_score` (how recent), and `duplicate_group` (near-duplicate detection across tools).

## How It Works

```
Agent (Claude, Cursor, Windsurf, Copilot, Codex)
    ↓ MCP protocol
Central Intelligence MCP Server (local, thin client)
    ↓
SQLite + vector embeddings + config file parsing
    ↓
Hybrid search: vector + FTS5 + fuzzy + temporal decay
```

Memories are stored as text with vector embeddings. Recall uses cosine similarity to find semantically relevant memories, not just keyword matches. Config files from all supported platforms are parsed, embedded, and cached locally.

## Memory Scopes

| Scope | Visible to | Use case |
|-------|-----------|----------|
| `agent` | Only the agent that stored it | Personal context, session continuity |
| `user` | All agents serving the same user | User preferences, cross-tool context |
| `org` | All agents in the organization | Shared knowledge, team decisions |

## MCP Server Setup

### Claude Code

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "central-intelligence": {
    "command": "npx",
    "args": ["-y", "central-intelligence-mcp"],
    "env": {
      "CI_API_KEY": "your-api-key"
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "central-intelligence": {
      "command": "npx",
      "args": ["-y", "central-intelligence-mcp"],
      "env": {
        "CI_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Any MCP-Compatible Client

The MCP server is published as [`central-intelligence-mcp`](https://www.npmjs.com/package/central-intelligence-mcp) on npm. Point your MCP client to it with the `CI_API_KEY` environment variable set.

## CLI Usage

```bash
# Sign up and get an API key
npx central-intelligence-cli signup

# Add to Claude Code / Cursor
npx central-intelligence-cli init claude
npx central-intelligence-cli init cursor

# Store a memory
npx central-intelligence-cli remember "The user prefers dark mode and TypeScript"

# Search memories
npx central-intelligence-cli recall "what are the user's preferences?"

# Delete a memory
npx central-intelligence-cli forget <memory-id>

# Check connection
npx central-intelligence-cli status
```

Or install globally for shorter commands:

```bash
npm install -g central-intelligence-cli
ci-memory signup
ci-memory remember "User prefers TypeScript"
ci-memory recall "language preferences"
```

## REST API

Base URL: `https://central-intelligence-api.fly.dev`

All endpoints require `Authorization: Bearer <api-key>` header.

### Create API Key

```bash
curl -X POST https://central-intelligence-api.fly.dev/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-key"}'
```

### POST /memories/remember

```json
{
  "agent_id": "my-agent",
  "content": "User prefers TypeScript over Python",
  "tags": ["preference", "language"],
  "scope": "agent"
}
```

### POST /memories/recall

```json
{
  "agent_id": "my-agent",
  "query": "what programming language does the user prefer?",
  "limit": 5
}
```

Response:

```json
{
  "memories": [
    {
      "id": "uuid",
      "content": "User prefers TypeScript over Python",
      "relevance_score": 0.434,
      "tags": ["preference", "language"],
      "scope": "agent",
      "created_at": "2026-03-22T21:42:34.590Z"
    }
  ]
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

### GET /usage

Returns memory counts, usage events, and active agents for the authenticated API key.

## Self-Hosting

```bash
# Clone and install
git clone https://github.com/AlekseiMarchenko/central-intelligence.git
cd central-intelligence
npm install

# Set up PostgreSQL
createdb central_intelligence
psql -d central_intelligence -f packages/api/src/db/schema.sql

# Configure
cp .env.example .env
# Edit .env: set DATABASE_URL and OPENAI_API_KEY

# Run
npm run dev:api
```

### Deploy to Fly.io

```bash
fly apps create my-ci-api
fly postgres create --name my-ci-db
fly postgres attach my-ci-db
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

Then point the MCP server to your instance:

```json
{
  "env": {
    "CI_API_KEY": "your-key",
    "CI_API_URL": "https://your-app.fly.dev"
  }
}
```

## Architecture

```
central-intelligence/
├── packages/
│   ├── api/            # Backend API (Hono + PostgreSQL)
│   │   └── src/
│   │       ├── db/           # Schema, migrations, connection
│   │       ├── middleware/   # Auth, rate limiting
│   │       ├── routes/       # API endpoints
│   │       └── services/     # Business logic (memories, embeddings, auth)
│   ├── mcp-server/     # MCP server (npm: central-intelligence-mcp)
│   ├── cli/            # CLI tool (npm: central-intelligence-cli)
│   ├── node-sdk/       # Node.js/TypeScript SDK (npm: central-intelligence-sdk)
│   ├── python-sdk/     # Python SDK (PyPI: central-intelligence)
│   └── openclaw-skill/ # OpenClaw skill file
├── landing/            # Landing page
├── Dockerfile          # API container
├── fly.toml            # Fly.io config
└── README.md
```

## Pricing

| Tier | Price | Memories | Agents |
|------|-------|----------|--------|
| Free | $0 | 500 | 1 |
| Pro | $29/mo | 50,000 | 20 |
| Team | $99/mo | 500,000 | Unlimited |

## Contributing

Contributions welcome. Open an issue or PR.

## License

[Apache 2.0](LICENSE)
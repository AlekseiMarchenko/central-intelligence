# Central Intelligence — Python SDK

Persistent memory for AI agents. Works with LangChain, CrewAI, and any Python agent framework.

## Install

```bash
pip install central-intelligence
# With LangChain support:
pip install central-intelligence[langchain]
# With CrewAI support:
pip install central-intelligence[crewai]
```

## Quick Start

```python
from central_intelligence import get_ci_tools

# Get all 5 tools ready for your agent
tools = get_ci_tools(api_key="ci_sk_...")

# Use with LangChain
from langchain.agents import initialize_agent
agent = initialize_agent(tools=tools, llm=llm)

# Use with CrewAI
from crewai import Agent
agent = Agent(role="researcher", tools=tools)
```

## Standalone Client

```python
from central_intelligence import CentralIntelligence

ci = CentralIntelligence(api_key="ci_sk_...", agent_id="my-agent")

# Store a memory
ci.remember("User prefers TypeScript over JavaScript")

# Search memories
results = ci.recall("programming language preferences")

# Load context for current task
context = ci.context("working on the auth system")

# Delete outdated info
ci.forget("memory-id-here")
```

## Get an API Key

```bash
npx central-intelligence-cli signup
```

## Links

- [Website](https://centralintelligence.online)
- [API Docs](https://central-intelligence-api.fly.dev/docs)
- [GitHub](https://github.com/AlekseiMarchenko/central-intelligence)
- [npm (MCP Server)](https://www.npmjs.com/package/central-intelligence-mcp)

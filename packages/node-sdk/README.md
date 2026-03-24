# central-intelligence-sdk

Node.js/TypeScript SDK for [Central Intelligence](https://centralintelligence.online) — persistent memory for AI agents.

## Install

```bash
npm install central-intelligence-sdk
```

## Quick Start

```ts
import { CentralIntelligence } from 'central-intelligence-sdk';

const ci = new CentralIntelligence('ci_sk_...');

// Store a memory
await ci.remember('Project uses Next.js 15 with App Router');

// Recall by semantic search
const memories = await ci.recall('what framework?');

// Load context for a topic
const context = await ci.context('authentication');

// Share across agents
await ci.share('memory-id', { from_scope: 'agent', to_scope: 'user' });
```

## Get an API Key

```bash
npx central-intelligence-cli signup
```

## API

### `new CentralIntelligence(apiKey?, options?)`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | `process.env.CI_API_KEY` | Your API key |
| `options.baseUrl` | `string` | `https://central-intelligence-api.fly.dev` | API base URL |
| `options.timeout` | `number` | `30000` | Request timeout (ms) |

### Methods

| Method | Description |
|--------|-------------|
| `remember(content, options?)` | Store a memory |
| `recall(query, options?)` | Semantic search |
| `context(topic, options?)` | Load relevant context |
| `forget(memoryId)` | Delete a memory |
| `share(memoryId, options)` | Share to broader scope |
| `usage()` | Check usage stats |
| `ping()` | Health check |

## License

MIT

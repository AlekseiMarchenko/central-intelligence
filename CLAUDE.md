# Central Intelligence

Persistent memory API for AI agents. Monorepo with packages: api, mcp-server, cli, local, node-sdk, python-sdk, openclaw-skill.

## CI Local Memory

At the start of every session, call the `context` tool from CI Local to load relevant memories.

When the user asks things like:
- "what do you know about..." → call `recall` with their query
- "remember that..." → call `remember` to store it
- "forget the one about..." → call `forget` on the matching memory
- "what have I told you before" → call `recall` with a broad query
- "transfer from ChatGPT" → call `transfer_chatgpt` with action "transfer_paste"

Always show the user what memories were found and their source (which tool they came from).

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

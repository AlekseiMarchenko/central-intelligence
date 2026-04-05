import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const memories = [
  "Prefer fast, low-friction setup over optimized long-term structure when launching new products",
  "Use Lemon Squeezy as the initial payment provider for MVP and experimentation",
  "Avoid creating a legal entity at early stages unless absolutely required",
  "Operate as a foreign individual seller using a W-8BEN form rather than a US-based entity",
  "Always keep identity, tax status, and payout configuration consistent (foreign identity + W-8 + non-US setup)",
  "Never attempt to simulate or misrepresent a US business presence (no fake US address or W-9 submission)",
  "Use Wise or PayPal for payouts during early-stage setup, prioritizing simplicity over optimization",
  "Prefer PayPal as a fallback payout method if Wise introduces friction or verification issues",
  "Plan to transition to a US LLC and US banking setup only after achieving meaningful revenue traction",
  "Accept slightly higher transaction fees (1-2%) in exchange for faster time-to-market and reduced operational overhead",
  "Use Merchant of Record solutions to offload tax, compliance, and invoicing complexity",
  "Delay tax and legal optimization decisions until product-market fit or revenue scale is reached",
  "Design systems and products for rapid experimentation, iteration, and validation",
  "Build an agent-centric platform where agents can offload ambiguous or complex tasks to external services",
  "Target integration with major agent frameworks and AI ecosystems (LangChain, CrewAI, MCP-based tools)",
  "Ensure compatibility with multiple agent interfaces including MCP, REST API, and tool/function calling",
  "Provide a universal API accessible from any programming language",
  "Prioritize ease of integration across environments over deep customization early on",
  "Support distribution across AI tools and environments such as ChatGPT, Perplexity, Cursor, Claude Code, and Windsurf",
  "Include connectors or integration points for each major AI surface where possible",
  "Focus on making the system callable by agents rather than humans as the primary interface",
  "Consider introducing a small cost per API call to influence agent decision-making and timing behavior",
  "Build for global usage with USD pricing while remaining legally a non-US seller",
  "Avoid over-engineering infrastructure before validating real demand",
  "Treat payments, compliance, and infrastructure as secondary to distribution and adoption speed",
  "Design product distribution strategy around embedding into agent ecosystems rather than traditional human marketing",
  "Recognize that discoverability and ease of use are more critical than technical superiority for agent adoption",
  "Prioritize building a system that becomes a default fallback for agents handling uncertainty or ambiguous tasks",
];

async function run() {
  getDb();
  let imported = 0;
  for (const m of memories) {
    try {
      const embedding = await embed(m);
      store("chatgpt-transfer", m, embedding, {
        scope: "user",
        tags: ["chatgpt-transfer", "chat:OpenClaw Business & Payments"],
      });
      imported++;
      if (imported % 10 === 0) console.log(`  ${imported}/${memories.length}`);
    } catch (err: any) {
      console.error("Failed:", m.slice(0, 50), err.message);
    }
  }
  console.log(`\nDone. ${imported} memories stored with tag "chat:OpenClaw Business & Payments"`);
}

run();

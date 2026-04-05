import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const memories = [
  "Prefer concise, Slack-style communication for technical and founder-facing messages",
  "Use a security-first, zero-trust mindset when designing and deploying systems",
  "Deploy OpenClaw agents only in fully isolated environments (Docker sandbox or microVM)",
  "Never allow OpenClaw agents access to host machine, dev accounts, or sensitive systems",
  "Always review latest security best practices before implementing OpenClaw or similar agent frameworks",
  "Restrict agent permissions to the minimum required with no implicit trust",
  "Avoid running agents as first-class system actors without strict containment boundaries",
  "Prefer minimal, tightly scoped agent wrappers over full-featured autonomous agents",
  "Design agent systems as API-first interfaces rather than UI-first platforms",
  "Use compatibility with agent ecosystems (LangChain, OpenAI tools, etc.) as a distribution strategy",
  "Build systems assuming agents execute integrations rather than browse or discover content",
  "Prefer exposing APIs or tools over relying on marketplace-style posting mechanisms",
  "Treat agents as untrusted actors that may behave adversarially",
  "Design agent task platforms as structured interfaces rather than open marketplaces",
  "Always assume prompt injection is a primary attack vector in agent systems",
  "Require strict validation and policy enforcement before any financial transaction",
  "Never allow agents to trigger payments without deterministic validation layers",
  "Use allowlists for recipients, contracts, and transaction conditions in payment systems",
  "Avoid unlimited token approvals and enforce per-transaction approval mechanisms",
  "Treat wallets as untrusted input surfaces subject to manipulation",
  "Avoid enumerating arbitrary wallet assets such as unknown NFTs or tokens",
  "Ignore or filter unverified tokens and NFTs in system logic and UI",
  "Use ephemeral or session-based wallets for agent-triggered transactions",
  "Separate treasury wallets from execution wallets to limit blast radius",
  "Use budget caps, rate limits, and anomaly detection for agent-driven financial activity",
  "Prevent database bloat by aggregating micro-transactions and enforcing minimum thresholds",
  "Validate all smart contract interactions against allowlists and known bytecode",
  "Simulate transactions before execution to detect malicious behavior",
  "Protect against replay attacks using nonces, expirations, and domain separation",
  "Avoid reliance on a single RPC provider and implement fallback mechanisms",
  "Monitor for crypto-native attacks such as NFT spam, approval draining, and gas griefing",
  "Design systems to withstand token burn attacks and resource exhaustion scenarios",
  "Avoid exposing private keys, secrets, or environment variables in any runtime context",
  "Use scoped, temporary, or brokered credentials instead of persistent secrets",
  "Design systems assuming autonomous agents will interact with payment flows",
  "Prioritize prevention of unauthorized payments, fund loss, and data leakage",
  "Structure security audits around real-world attack scenarios, not theoretical risks",
  "Require audit outputs to include severity levels, code references, and mitigation steps",
  "Treat the payment system as an autonomous financial execution layer requiring strict controls",
];

async function run() {
  getDb(); // init
  let imported = 0;
  for (const m of memories) {
    try {
      const embedding = await embed(m);
      store("chatgpt-transfer", m, embedding, {
        scope: "user",
        tags: ["chatgpt-transfer"],
      });
      imported++;
      if (imported % 10 === 0) console.log(`  ${imported}/${memories.length}`);
    } catch (err: any) {
      console.error("Failed:", m.slice(0, 50), err.message);
    }
  }
  console.log(`\nDone. ${imported} memories stored in ~/.central-intelligence/memories.db`);
}

run();

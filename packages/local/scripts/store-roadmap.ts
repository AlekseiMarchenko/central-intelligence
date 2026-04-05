import { getDb, store } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const PROJECT = "CI Product Roadmap";
const memories = [
  "NEXT: Phase 1 — hosted dashboard. Move from localhost to a web app. React or Next.js on Vercel or Fly.io. Add auth (Clerk or NextAuth). Users access via URL, not terminal.",
  "Phase 2 after hosted dashboard: cloud sync. Push local SQLite to cloud PostgreSQL. Pull cloud to local. Bulk sync wrapper over existing API. Newer-wins conflict resolution.",
  "Phase 3: subscription via Lemon Squeezy. Free 500 memories local-only. Pro unlimited + cloud sync. Org tier for team shared memories.",
  "Phase 4: multi-agent workspace. Per-agent memory views. Permission controls. The scoping (agent_id, user_id, org_id) already works in the data model.",
  "Total estimated effort for full Notion-like product: 10-13 hours with CC across 4 phases. 2-3 days of building.",
];

async function run() {
  const db = getDb();
  const check = db.prepare("SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1");
  let n = 0;
  for (const m of memories) {
    if (check.get(m)) continue;
    const emb = await embed(m);
    store("session-memory", m, emb, { scope: "user", tags: ["session-memory", `chat:${PROJECT}`] });
    n++;
  }
  console.log(`Saved ${n} roadmap memories. Total: ${(db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL").get() as any).c}`);
}
run();

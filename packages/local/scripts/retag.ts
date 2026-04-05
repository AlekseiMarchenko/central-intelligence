import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { homedir } from "os";

const db = new DatabaseSync(join(homedir(), ".central-intelligence", "memories.db"));

const OLD_TAG = "chat:OpenClaw Business & Payments";
const NEW_TAG = "chat:Lemon Squeezy Setup & Agent Platform Strategy";

// Find all memories with the old tag
const rows = db.prepare("SELECT id, tags FROM memories WHERE deleted_at IS NULL").all() as { id: string; tags: string }[];

let retagged = 0;
const stmt = db.prepare("UPDATE memories SET tags = ? WHERE id = ?");

for (const row of rows) {
  const tags: string[] = JSON.parse(row.tags || "[]");
  if (tags.includes(OLD_TAG)) {
    const updated = tags.map(t => t === OLD_TAG ? NEW_TAG : t);
    stmt.run(JSON.stringify(updated), row.id);
    retagged++;
  }
}

console.log(`Retagged ${retagged} memories: "${OLD_TAG}" → "${NEW_TAG}"`);

// Verify
const check = db.prepare("SELECT tags FROM memories WHERE deleted_at IS NULL AND tags LIKE ?").all(`%${OLD_TAG}%`);
console.log(`Remaining with old tag: ${check.length}`);

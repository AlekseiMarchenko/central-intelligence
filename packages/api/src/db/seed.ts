import { sql } from "./connection.js";
import { createApiKey } from "../services/auth.js";
import { store } from "../services/memories.js";

async function seed() {
  console.log("Seeding database...\n");

  // Create a dev API key
  const { key, id } = await createApiKey("dev-key", "dev-org");
  console.log(`API Key: ${key}`);
  console.log(`Key ID:  ${id}\n`);

  // Seed some example memories
  const memories = [
    {
      content: "User prefers TypeScript over JavaScript and uses Hono for backend APIs",
      tags: ["preference", "language", "framework"],
      scope: "user" as const,
    },
    {
      content: "The project uses PostgreSQL with pgvector for semantic search",
      tags: ["architecture", "database"],
      scope: "org" as const,
    },
    {
      content: "Deploy to Fly.io using the scripts in /scripts directory",
      tags: ["deployment", "infrastructure"],
      scope: "org" as const,
    },
    {
      content: "Auth system uses API keys with SHA-256 hashing, stored in api_keys table",
      tags: ["architecture", "auth", "security"],
      scope: "org" as const,
    },
    {
      content: "User likes dark mode and minimal UI design",
      tags: ["preference", "design"],
      scope: "user" as const,
    },
  ];

  for (const mem of memories) {
    const result = await store({
      apiKeyId: id,
      agentId: "seed-agent",
      userId: "dev-user",
      orgId: "dev-org",
      ...mem,
    });
    console.log(`  Stored: "${mem.content.slice(0, 50)}..." (${result.id})`);
  }

  console.log(`\nSeeded ${memories.length} memories.`);
  console.log(`\nTo use: export CI_API_KEY="${key}"`);

  await sql.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

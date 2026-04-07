import chalk from "chalk";
import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { getDb } from "../db.js";

interface ChatGPTMemory {
  content: string;
  conversation_title: string;
  conversation_id: string;
  timestamp: string;
  content_hash: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  message_count: number;
  instructional_count: number;
  date: string;
  folder?: string;
}

interface ImportOptions {
  dryRun?: boolean;
  limit?: string;
  all?: boolean;
}

export async function chatgptImportCommand(
  file: string,
  options: ImportOptions
): Promise<void> {
  console.log(chalk.bold("\nCI Local Pro — ChatGPT Import\n"));

  const limit = parseInt(options.limit || "50", 10);

  // Load file
  let fileSize: number;
  try {
    fileSize = statSync(file).size;
  } catch (err: any) {
    console.error(chalk.red(`Cannot read file: ${err.message}`));
    console.log(chalk.dim("\nTo get this file:"));
    console.log(chalk.dim("  1. Go to chat.openai.com → Settings → Data controls"));
    console.log(chalk.dim("  2. Click 'Export data'"));
    console.log(chalk.dim("  3. Wait for email, download ZIP, unzip"));
    console.log(chalk.dim("  4. Find conversations.json inside"));
    process.exit(1);
  }

  const sizeMB = Math.round(fileSize / 1024 / 1024);
  console.log(`  File: ${file} (${sizeMB > 0 ? sizeMB + "MB" : Math.round(fileSize / 1024) + "KB"})`);

  let conversations: any[];
  try {
    conversations = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err: any) {
    if (err.message?.includes("heap") || err.message?.includes("memory")) {
      console.error(chalk.red(`File too large for available memory (${sizeMB}MB).`));
      console.log(chalk.dim("  Try: node --max-old-space-size=4096"));
      process.exit(1);
    }
    console.error(chalk.red("Invalid JSON. Expected conversations.json from ChatGPT export."));
    process.exit(1);
  }

  if (!Array.isArray(conversations)) {
    console.error(chalk.red("Expected an array of conversations."));
    process.exit(1);
  }

  // === Phase 1: Scan all conversations and build summaries ===

  const allMemories: ChatGPTMemory[] = [];
  const summaries: ConversationSummary[] = [];
  let totalMessages = 0;

  for (const conv of conversations) {
    const title = conv.title || "Untitled";
    const convId = conv.id || conv.conversation_id || title;
    const folder = conv.folder_name || conv.project_name || undefined;
    const mapping = conv.mapping;
    if (!mapping || typeof mapping !== "object") continue;

    let msgCount = 0;
    let instructionalCount = 0;

    for (const node of Object.values(mapping) as any[]) {
      const msg = node?.message;
      if (!msg || msg.author?.role !== "user") continue;
      msgCount++;
      totalMessages++;

      const parts = msg.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.filter((p: any) => typeof p === "string").join("\n").trim();
      if (!text || text.length < 30 || text.length > 2000) continue;

      // Skip questions
      const questionMarks = (text.match(/\?/g) || []).length;
      const sentences = text.split(/[.!?\n]/).filter((s) => s.trim().length > 0).length;
      if (sentences > 0 && questionMarks / sentences > 0.5) continue;

      const isInstructional =
        /\b(always|never|prefer|use|don't|avoid|make sure|remember|important)\b/i.test(text) ||
        /\b(i want|i need|i like|my preference|my style)\b/i.test(text) ||
        /\b(the project|the codebase|the stack|our team|we use)\b/i.test(text);

      if (!isInstructional) continue;

      instructionalCount++;

      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      const timestamp = msg.create_time
        ? new Date(msg.create_time * 1000).toISOString()
        : conv.create_time
        ? new Date(conv.create_time * 1000).toISOString()
        : new Date().toISOString();

      allMemories.push({
        content: text,
        conversation_title: title,
        conversation_id: convId,
        timestamp,
        content_hash: hash,
      });
    }

    if (msgCount > 0) {
      const convDate = conv.create_time
        ? new Date(conv.create_time * 1000).toLocaleDateString()
        : "unknown";

      summaries.push({
        id: convId,
        title,
        message_count: msgCount,
        instructional_count: instructionalCount,
        date: convDate,
        folder,
      });
    }
  }

  // Sort summaries: conversations with instructional content first, then by date
  summaries.sort((a, b) => b.instructional_count - a.instructional_count);

  // Deduplicate memories
  const seen = new Set<string>();
  const uniqueMemories = allMemories.filter((m) => {
    if (seen.has(m.content_hash)) return false;
    seen.add(m.content_hash);
    return true;
  });

  console.log(chalk.bold("\nScan results:"));
  console.log(`  Conversations:     ${conversations.length}`);
  console.log(`  User messages:     ${totalMessages}`);
  console.log(`  With instructions: ${summaries.filter((s) => s.instructional_count > 0).length} conversations`);
  console.log(`  Total extracted:   ${uniqueMemories.length} unique instructional memories`);

  // Check for folders/projects
  const folders = [...new Set(summaries.map((s) => s.folder).filter(Boolean))] as string[];
  if (folders.length > 0) {
    console.log(`  ChatGPT projects:  ${folders.length} (${folders.join(", ")})`);
  }
  console.log();

  if (uniqueMemories.length === 0) {
    console.log(chalk.yellow("  No instructional memories found."));
    return;
  }

  // === Phase 2: Let user pick what to import ===

  if (options.all) {
    // Skip selection, import everything
    return await importMemories(uniqueMemories.slice(0, limit), options.dryRun || false);
  }

  // Show selection menu
  console.log(chalk.bold("What would you like to import?\n"));

  const relevantSummaries = summaries.filter((s) => s.instructional_count > 0);

  // Option 1: By folder/project (if available)
  if (folders.length > 0) {
    console.log(chalk.cyan("  ChatGPT Projects:"));
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      const folderConvs = relevantSummaries.filter((s) => s.folder === folder);
      const folderMemCount = uniqueMemories.filter((m) => {
        const convSummary = summaries.find((s) => s.id === m.conversation_id);
        return convSummary?.folder === folder;
      }).length;
      console.log(`    P${i + 1}) ${chalk.bold(folder)} — ${folderConvs.length} chats, ${folderMemCount} memories`);
    }
    console.log();
  }

  // Option 2: By conversation
  console.log(chalk.cyan("  Top conversations (by instructional content):"));
  const topConvs = relevantSummaries.slice(0, 15);
  for (let i = 0; i < topConvs.length; i++) {
    const s = topConvs[i];
    const folderTag = s.folder ? chalk.dim(` [${s.folder}]`) : "";
    console.log(
      `    ${i + 1}) ${chalk.bold(s.title.slice(0, 50))}${folderTag} — ${s.instructional_count} memories (${s.date})`
    );
  }
  if (relevantSummaries.length > 15) {
    console.log(chalk.dim(`    ... and ${relevantSummaries.length - 15} more conversations`));
  }

  // Option 3: All
  console.log();
  console.log(`    ${chalk.cyan("A)")} Import all ${uniqueMemories.length} memories`);
  console.log(`    ${chalk.cyan("Q)")} Cancel`);
  console.log();

  const answer = await ask(
    "  Pick: numbers (e.g. 1,3,5), project (e.g. P1), or A for all: "
  );

  if (!answer || answer.toUpperCase() === "Q") {
    console.log(chalk.dim("  Cancelled."));
    return;
  }

  let selectedMemories: ChatGPTMemory[];

  if (answer.toUpperCase() === "A") {
    selectedMemories = uniqueMemories;
  } else if (answer.toUpperCase().startsWith("P")) {
    // Project selection
    const projectIdx = parseInt(answer.slice(1), 10) - 1;
    if (projectIdx < 0 || projectIdx >= folders.length) {
      console.log(chalk.red("  Invalid project number."));
      return;
    }
    const folder = folders[projectIdx];
    selectedMemories = uniqueMemories.filter((m) => {
      const convSummary = summaries.find((s) => s.id === m.conversation_id);
      return convSummary?.folder === folder;
    });
    console.log(chalk.dim(`\n  Selected project: ${folder} (${selectedMemories.length} memories)`));
  } else {
    // Conversation selection (comma-separated numbers)
    const indices = answer
      .split(/[,\s]+/)
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((n) => !isNaN(n) && n >= 0 && n < topConvs.length);

    if (indices.length === 0) {
      console.log(chalk.red("  No valid selections."));
      return;
    }

    const selectedConvIds = new Set(indices.map((i) => topConvs[i].id));
    selectedMemories = uniqueMemories.filter((m) => selectedConvIds.has(m.conversation_id));

    const selectedTitles = indices.map((i) => topConvs[i].title.slice(0, 40));
    console.log(chalk.dim(`\n  Selected: ${selectedTitles.join(", ")} (${selectedMemories.length} memories)`));
  }

  if (selectedMemories.length === 0) {
    console.log(chalk.yellow("  No memories in selection."));
    return;
  }

  // Apply limit
  const toImport = selectedMemories.slice(0, limit);
  if (selectedMemories.length > limit) {
    console.log(chalk.dim(`  Capped at ${limit} (use --limit to increase)`));
  }

  return await importMemories(toImport, options.dryRun || false);
}

// === Import logic ===

async function importMemories(
  memories: ChatGPTMemory[],
  dryRun: boolean
): Promise<void> {
  // Preview
  console.log(chalk.bold(`\nPreview (${memories.length} memories):\n`));
  for (let i = 0; i < Math.min(memories.length, 10); i++) {
    const m = memories[i];
    const preview = m.content.slice(0, 120).replace(/\n/g, " ");
    const date = new Date(m.timestamp).toLocaleDateString();
    console.log(`  ${chalk.dim(`${i + 1}.`)} ${chalk.dim(date)} ${chalk.cyan(m.conversation_title.slice(0, 40))}`);
    console.log(`     ${preview}${m.content.length > 120 ? "..." : ""}`);
  }
  if (memories.length > 10) {
    console.log(chalk.dim(`\n  ... and ${memories.length - 10} more`));
  }
  console.log();

  if (dryRun) {
    console.log(chalk.yellow("  Dry run — nothing stored. Remove --dry-run to import.\n"));
    return;
  }

  // Confirm
  const confirmed = await ask(`  Import ${memories.length} memories into CI Local? (y/n) `);
  if (!confirmed || !confirmed.toLowerCase().startsWith("y")) {
    console.log(chalk.dim("  Cancelled."));
    return;
  }

  // Write to SQLite
  console.log();
  const db = getDb();
  const { v4: uuid } = await import("uuid");

  let embeddingAvailable = true;
  let embed: ((text: string) => Promise<number[]>) | null = null;
  try {
    const mod = await import("../embeddings.js");
    embed = mod.embed;
  } catch {
    embeddingAvailable = false;
    console.log(chalk.dim("  Embeddings unavailable — importing text only."));
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO memories (id, agent_id, user_id, scope, content, tags, embedding, created_at)
     VALUES (?, ?, NULL, 'user', ?, ?, ?, ?)`
  );

  let imported = 0;
  let skippedDuplicate = 0;

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];

    // Check for exact duplicate
    const existing = db
      .prepare("SELECT id FROM memories WHERE content = ? AND deleted_at IS NULL LIMIT 1")
      .get(m.content) as { id: string } | undefined;

    if (existing) {
      skippedDuplicate++;
      continue;
    }

    // Compute embedding
    let embBuf: Buffer | null = null;
    if (embed) {
      try {
        const vec = await embed(m.content);
        embBuf = Buffer.from(new Float32Array(vec).buffer);
      } catch {
        // Continue without embedding
      }
    }

    insertStmt.run(
      uuid(),
      "chatgpt-import",
      m.content,
      JSON.stringify(["chatgpt-import", `chat:${m.conversation_title.slice(0, 50)}`]),
      embBuf,
      m.timestamp
    );
    imported++;

    if ((i + 1) % 10 === 0 || i === memories.length - 1) {
      process.stdout.write(`\r  Importing... ${i + 1}/${memories.length}`);
    }
  }

  console.log(chalk.green(`\n\n  ✓ Imported ${imported} memories into CI Local`));
  if (skippedDuplicate > 0) {
    console.log(chalk.dim(`  ${skippedDuplicate} skipped (already exist)`));
  }
  console.log(chalk.dim(`  Tagged with 'chatgpt-import' + conversation name`));
  console.log(chalk.dim(`  Run ${chalk.cyan("ci audit")} to see them.\n`));
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

import chalk from "chalk";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

export async function chatgptInitCommand(): Promise<void> {
  console.log(chalk.bold("\nCI Local Pro — ChatGPT Instructions Setup\n"));
  console.log("This saves your ChatGPT custom instructions as a local file");
  console.log("so CI Local can serve them to all your AI tools.\n");

  console.log(chalk.bold("Step 1:") + " Open ChatGPT");
  console.log(chalk.dim("  → chat.openai.com → Settings → Personalization → Custom instructions\n"));

  console.log(chalk.bold("Step 2:") + " Copy both text boxes:\n");
  console.log(chalk.dim('  Box 1: "What would you like ChatGPT to know about you?"'));
  console.log(chalk.dim('  Box 2: "How would you like ChatGPT to respond?"\n'));

  console.log(chalk.bold("Step 3:") + " Paste below (type " + chalk.cyan("END") + " on a new line when done):\n");

  const lines = await readMultilineInput();
  const content = lines.trim();

  if (!content) {
    console.log(chalk.yellow("\n  No input received. Exiting."));
    return;
  }

  // Check if there's already a file
  const dir = join(process.cwd(), ".chatgpt");
  const filePath = join(dir, "instructions.md");

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    console.log(chalk.yellow("\n  .chatgpt/instructions.md already exists."));
    console.log(chalk.dim("  Current content preview: " + existing.slice(0, 100) + "..."));

    const overwrite = await askYesNo("  Overwrite?");
    if (!overwrite) {
      console.log(chalk.dim("  Keeping existing file."));
      return;
    }
  }

  // Format the content
  const markdown = formatInstructions(content);

  // Write the file
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, markdown, "utf-8");

  console.log(chalk.green("\n  ✓ Saved to .chatgpt/instructions.md"));
  console.log(chalk.dim(`  ${markdown.split("\n").length} lines, ${markdown.length} chars\n`));

  // Check if CI Local is configured
  const ciConfigured = existsSync(join(process.cwd(), ".claude", "settings.json"));

  if (ciConfigured) {
    console.log(chalk.green("  ✓ CI Local MCP server detected."));
    console.log("  Your ChatGPT instructions will be included in the next " + chalk.cyan("context") + " or " + chalk.cyan("recall") + " call.\n");
  } else {
    console.log(chalk.yellow("  CI Local MCP server not configured yet."));
    console.log("  Run " + chalk.cyan("ci init") + " to set it up.\n");
  }

  // Show what CI Local will do with this
  console.log(chalk.bold("What happens next:"));
  console.log("  1. Start a Claude Code / Cursor / Windsurf session");
  console.log("  2. The agent calls " + chalk.cyan("context") + " (automatic at session start)");
  console.log("  3. CI Local returns your ChatGPT instructions alongside other memories");
  console.log("  4. The agent knows your preferences from ChatGPT — no manual transfer\n");

  // Suggest gitignore
  const gitignorePath = join(process.cwd(), ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(".chatgpt/")) {
      console.log(chalk.dim("  Tip: Add .chatgpt/ to .gitignore if these are personal preferences.\n"));
    }
  }
}

/**
 * Format raw pasted text into a structured markdown file.
 * Tries to detect if the user pasted both ChatGPT boxes or just one.
 */
function formatInstructions(raw: string): string {
  const lines: string[] = ["# ChatGPT Custom Instructions", ""];

  // Check if the content has two distinct sections
  // (users might paste both boxes with a gap between them)
  const sections = raw.split(/\n{3,}/);

  if (sections.length >= 2) {
    lines.push("## About Me");
    lines.push(sections[0].trim());
    lines.push("");
    lines.push("## Response Preferences");
    lines.push(sections.slice(1).join("\n\n").trim());
  } else {
    // Single block — just use it as-is
    lines.push("## Instructions");
    lines.push(raw.trim());
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Read multiline input until user types END on a new line.
 */
function readMultilineInput(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines: string[] = [];

    rl.on("line", (line) => {
      if (line.trim().toUpperCase() === "END") {
        rl.close();
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    });

    rl.on("close", () => {
      resolve(lines.join("\n"));
    });
  });
}

/**
 * Ask a yes/no question.
 */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + " (y/n) ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

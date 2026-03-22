#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".central-intelligence");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const API_BASE =
  process.env.CI_API_URL || "https://central-intelligence-api.fly.dev";

// --- Config ---

interface Config {
  api_key?: string;
  api_url?: string;
  default_agent_id?: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
}

function saveConfig(config: Config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getApiKey(): string {
  const envKey = process.env.CI_API_KEY;
  if (envKey) return envKey;
  const config = loadConfig();
  if (config.api_key) return config.api_key;
  console.error(
    chalk.red("No API key found. Run `ci signup` or set CI_API_KEY."),
  );
  process.exit(1);
}

async function apiCall(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
  auth = true,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) headers.Authorization = `Bearer ${getApiKey()}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(
      `API error (${res.status}): ${(err as Record<string, string>).error}`,
    );
  }
  return res.json();
}

// --- CLI ---

const program = new Command();

program
  .name("ci")
  .description("Central Intelligence — persistent memory for AI agents")
  .version("0.1.0");

// Signup
program
  .command("signup")
  .description("Create a new API key")
  .option("-n, --name <name>", "Key name", "default")
  .option("--org <org_id>", "Organization ID")
  .action(async (opts) => {
    const spinner = ora("Creating API key...").start();
    try {
      const result = (await apiCall(
        "/keys",
        "POST",
        { name: opts.name, org_id: opts.org },
        false,
      )) as { key: string; id: string };
      spinner.stop();

      saveConfig({ ...loadConfig(), api_key: result.key });

      console.log(chalk.green("\nAPI key created and saved!\n"));
      console.log(chalk.dim("Key:"), chalk.yellow(result.key));
      console.log(
        chalk.dim("\nSaved to:"),
        chalk.cyan(CONFIG_FILE),
      );
      console.log(
        chalk.dim("\nOr set as env var:"),
        chalk.cyan(`export CI_API_KEY="${result.key}"`),
      );
      console.log(
        chalk.dim("\nNext:"),
        "Run",
        chalk.cyan("ci init claude"),
        "to add memory to Claude Code",
      );
    } catch (err) {
      spinner.fail(`Signup failed: ${(err as Error).message}`);
    }
  });

// Init — configure an agent framework to use CI
program
  .command("init <platform>")
  .description(
    "Add Central Intelligence to an agent platform (claude, cursor, windsurf)",
  )
  .action(async (platform) => {
    const apiKey = getApiKey();

    const mcpEntry = {
      command: "npx",
      args: ["-y", "central-intelligence-mcp"],
      env: {
        CI_API_KEY: apiKey,
      },
    };

    if (platform === "claude") {
      // Claude Code stores MCP servers in ~/.claude/settings.json under mcpServers
      const claudeConfigDir = join(homedir(), ".claude");
      const settingsFile = join(claudeConfigDir, "settings.json");

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsFile)) {
        settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
      }

      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }
      (settings.mcpServers as Record<string, unknown>)["central-intelligence"] = mcpEntry;

      if (!existsSync(claudeConfigDir))
        mkdirSync(claudeConfigDir, { recursive: true });
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

      console.log(chalk.green("\n✓ Central Intelligence added to Claude Code!\n"));
      console.log(chalk.dim("Config:"), chalk.cyan(settingsFile));
      console.log(
        chalk.dim("\nRestart Claude Code to activate. Your agent will have these tools:"),
      );
      console.log(chalk.cyan("  remember") + chalk.dim(" — store information for later"));
      console.log(chalk.cyan("  recall") + chalk.dim("   — search past memories"));
      console.log(chalk.cyan("  context") + chalk.dim("  — auto-load relevant context"));
      console.log(chalk.cyan("  forget") + chalk.dim("   — delete outdated memories"));
      console.log(chalk.cyan("  share") + chalk.dim("    — share with other agents"));
      console.log();
    } else if (platform === "cursor") {
      // Cursor stores MCP servers in ~/.cursor/mcp.json
      const cursorConfigDir = join(homedir(), ".cursor");
      const mcpFile = join(cursorConfigDir, "mcp.json");

      let mcpConfig: Record<string, unknown> = {};
      if (existsSync(mcpFile)) {
        mcpConfig = JSON.parse(readFileSync(mcpFile, "utf-8"));
      }

      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
      (mcpConfig.mcpServers as Record<string, unknown>)["central-intelligence"] = mcpEntry;

      if (!existsSync(cursorConfigDir))
        mkdirSync(cursorConfigDir, { recursive: true });
      writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));

      console.log(chalk.green("\n✓ Central Intelligence added to Cursor!\n"));
      console.log(chalk.dim("Config:"), chalk.cyan(mcpFile));
      console.log(chalk.dim("\nRestart Cursor to activate."));
      console.log();
    } else if (platform === "windsurf") {
      // Windsurf uses ~/.codeium/windsurf/mcp_config.json
      const windsurfConfigDir = join(homedir(), ".codeium", "windsurf");
      const mcpFile = join(windsurfConfigDir, "mcp_config.json");

      let mcpConfig: Record<string, unknown> = {};
      if (existsSync(mcpFile)) {
        mcpConfig = JSON.parse(readFileSync(mcpFile, "utf-8"));
      }

      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
      (mcpConfig.mcpServers as Record<string, unknown>)["central-intelligence"] = mcpEntry;

      if (!existsSync(windsurfConfigDir))
        mkdirSync(windsurfConfigDir, { recursive: true });
      writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));

      console.log(chalk.green("\n✓ Central Intelligence added to Windsurf!\n"));
      console.log(chalk.dim("Config:"), chalk.cyan(mcpFile));
      console.log(chalk.dim("\nRestart Windsurf to activate."));
      console.log();
    } else {
      console.log(
        chalk.yellow(`\nPlatform "${platform}" — manual setup:\n`),
      );
      console.log("Add this MCP server config to your platform:\n");
      console.log(chalk.cyan(JSON.stringify({ "central-intelligence": mcpEntry }, null, 2)));
      console.log(
        chalk.dim("\nOr use the REST API directly at"),
        chalk.cyan(`${API_BASE}/memories/*`),
      );
      console.log();
    }
  });

// Remember
program
  .command("remember <content>")
  .description("Store a memory")
  .option("-a, --agent <id>", "Agent ID", "cli")
  .option("-t, --tags <tags...>", "Tags")
  .option("-s, --scope <scope>", "Scope (agent|user|org)", "agent")
  .action(async (content, opts) => {
    const spinner = ora("Storing memory...").start();
    try {
      const result = (await apiCall("/memories/remember", "POST", {
        agent_id: opts.agent,
        content,
        tags: opts.tags || [],
        scope: opts.scope,
      })) as { memory: { id: string } };
      spinner.succeed(`Remembered (id: ${result.memory.id})`);
    } catch (err) {
      spinner.fail(`Failed: ${(err as Error).message}`);
    }
  });

// Recall
program
  .command("recall <query>")
  .description("Search memories")
  .option("-a, --agent <id>", "Agent ID", "cli")
  .option("-l, --limit <n>", "Max results", "5")
  .option("-s, --scope <scope>", "Scope (agent|user|org)")
  .action(async (query, opts) => {
    const spinner = ora("Searching memories...").start();
    try {
      const result = (await apiCall("/memories/recall", "POST", {
        agent_id: opts.agent,
        query,
        limit: parseInt(opts.limit),
        scope: opts.scope,
      })) as {
        memories: Array<{
          id: string;
          content: string;
          relevance_score: number;
          tags: string[];
        }>;
      };
      spinner.stop();

      if (result.memories.length === 0) {
        console.log(chalk.yellow("No memories found."));
        return;
      }

      for (const m of result.memories) {
        const score = (m.relevance_score * 100).toFixed(1);
        console.log(
          chalk.dim(`[${score}%]`),
          chalk.white(m.content),
          m.tags.length > 0 ? chalk.cyan(`(${m.tags.join(", ")})`) : "",
        );
        console.log(chalk.dim(`  id: ${m.id}\n`));
      }
    } catch (err) {
      spinner.fail(`Failed: ${(err as Error).message}`);
    }
  });

// Forget
program
  .command("forget <memory_id>")
  .description("Delete a memory")
  .action(async (memoryId) => {
    const spinner = ora("Deleting memory...").start();
    try {
      await apiCall(`/memories/${memoryId}`, "DELETE");
      spinner.succeed("Memory deleted.");
    } catch (err) {
      spinner.fail(`Failed: ${(err as Error).message}`);
    }
  });

// Status
program
  .command("status")
  .description("Check connection and config")
  .action(async () => {
    const config = loadConfig();
    console.log(chalk.bold("\nCentral Intelligence Status\n"));
    console.log(
      chalk.dim("API Key:"),
      config.api_key
        ? chalk.green(`${config.api_key.slice(0, 14)}...`)
        : chalk.red("Not set"),
    );
    console.log(chalk.dim("API URL:"), chalk.cyan(API_BASE));
    console.log(chalk.dim("Config:"), chalk.cyan(CONFIG_FILE));

    try {
      await fetch(`${API_BASE}/health`);
      console.log(chalk.dim("Server:"), chalk.green("Connected"));
    } catch {
      console.log(chalk.dim("Server:"), chalk.red("Unreachable"));
    }
    console.log();
  });

program.parse();

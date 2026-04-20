import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

const CONFIG_DIR = join(homedir(), ".central-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const DEFAULT_API_URL = "https://central-intelligence-api.fly.dev";

export type Mode =
  | { kind: "cloud"; apiKey: string; apiUrl: string }
  | { kind: "local" };

/**
 * Detect which mode the user is running.
 *
 * Cloud mode: `~/.central-intelligence/config.json` contains a non-empty
 * `api_key`. Optional `api_url` override (used by tests or self-hosted).
 *
 * Local mode: no config or no api_key → local SQLite at ~/.central-intelligence/memories.db.
 */
export function detectMode(): Mode {
  if (!existsSync(CONFIG_PATH)) return { kind: "local" };
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const apiKey = typeof cfg.api_key === "string" ? cfg.api_key.trim() : "";
    if (!apiKey) return { kind: "local" };
    const apiUrl = typeof cfg.api_url === "string" && cfg.api_url ? cfg.api_url : DEFAULT_API_URL;
    return { kind: "cloud", apiKey, apiUrl };
  } catch {
    return { kind: "local" };
  }
}

/**
 * Authenticated JSON call to the CI cloud API. Throws on non-2xx with the
 * server-provided error message. Returns parsed JSON.
 */
export async function apiCall(
  mode: Extract<Mode, { kind: "cloud" }>,
  path: string,
  options: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<unknown> {
  const method = options.method || "GET";
  const res = await fetch(`${mode.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${mode.apiKey}`,
      "Content-Type": "application/json",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = res.statusText;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error) msg = parsed.error;
    } catch {
      if (body) msg = body.slice(0, 200);
    }
    throw new Error(`${method} ${path} → ${res.status} ${msg}`);
  }
  return res.json();
}

export function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 12)}…`;
}

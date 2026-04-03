export interface Memory {
  id: string;
  agent_id: string;
  user_id: string | null;
  scope: "agent" | "user" | "org";
  content: string;
  tags: string[];
  created_at: string;
  deleted_at: string | null;
}

export interface MemoryWithScore extends Memory {
  relevance_score: number;
  source?: "db" | "claude_md" | "claude_memory" | "cursor_rules" | "windsurf_rules" | "codex_config" | "copilot_instructions" | "chatgpt_instructions";
  source_path?: string;
  freshness_score?: number;       // 0.0-1.0, exponential decay (half-life 90 days)
  duplicate_group?: string | null; // group ID if near-duplicates detected
}

export interface MemoryRow {
  id: string;
  agent_id: string;
  user_id: string | null;
  scope: string;
  content: string;
  tags: string;
  embedding: Buffer | null;
  created_at: string;
  deleted_at: string | null;
}

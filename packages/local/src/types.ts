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

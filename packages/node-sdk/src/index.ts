/**
 * Central Intelligence — Node.js SDK
 * Persistent memory for AI agents.
 *
 * @example
 * ```ts
 * import { CentralIntelligence } from 'central-intelligence-sdk';
 *
 * const ci = new CentralIntelligence('ci_sk_...');
 * await ci.remember('user prefers TypeScript');
 * const memories = await ci.recall('programming language preferences');
 * ```
 */

export interface Memory {
  id: string;
  content: string;
  agent_id?: string;
  user_id?: string;
  scope: "agent" | "user" | "org";
  tags: string[];
  similarity?: number;
  created_at: string;
}

export interface RememberOptions {
  agent_id?: string;
  user_id?: string;
  scope?: "agent" | "user" | "org";
  tags?: string[];
}

export interface RecallOptions {
  agent_id?: string;
  user_id?: string;
  scope?: "agent" | "user" | "org";
  top_k?: number;
}

export interface ContextOptions {
  agent_id?: string;
  user_id?: string;
  scope?: "agent" | "user" | "org";
  top_k?: number;
}

export interface ForgetOptions {
  agent_id?: string;
}

export interface ShareOptions {
  agent_id?: string;
  from_scope: "agent" | "user" | "org";
  to_scope: "agent" | "user" | "org";
}

export interface CIOptions {
  baseUrl?: string;
  timeout?: number;
}

export class CentralIntelligenceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CentralIntelligenceError";
    this.status = status;
    this.code = code;
  }
}

export class CentralIntelligence {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  /**
   * Create a new Central Intelligence client.
   *
   * @param apiKey - Your CI API key (starts with ci_sk_)
   * @param options - Optional configuration
   *
   * @example
   * ```ts
   * const ci = new CentralIntelligence('ci_sk_...');
   * ```
   *
   * @example
   * ```ts
   * // Self-hosted
   * const ci = new CentralIntelligence('ci_sk_...', {
   *   baseUrl: 'https://ci.yourcompany.com'
   * });
   * ```
   */
  constructor(apiKey?: string, options: CIOptions = {}) {
    this.apiKey = apiKey || process.env.CI_API_KEY || "";
    if (!this.apiKey) {
      throw new CentralIntelligenceError(
        "API key required. Pass it as first argument or set CI_API_KEY env var.",
        401
      );
    }
    this.baseUrl =
      options.baseUrl ||
      process.env.CI_API_URL ||
      "https://central-intelligence-api.fly.dev";
    this.timeout = options.timeout || 30000;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "central-intelligence-sdk/0.1.0",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data = (await res.json()) as T & { error?: string };

      if (!res.ok) {
        throw new CentralIntelligenceError(
          (data as any).error || `Request failed with status ${res.status}`,
          res.status
        );
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Store a memory for later recall.
   *
   * @example
   * ```ts
   * await ci.remember('Project uses Next.js 15 with App Router');
   * await ci.remember('Auth uses JWT in httpOnly cookies', {
   *   tags: ['auth', 'architecture'],
   *   scope: 'user'
   * });
   * ```
   */
  async remember(
    content: string,
    options: RememberOptions = {}
  ): Promise<{ id: string }> {
    return this.request("POST", "/memories/remember", {
      content,
      agent_id: options.agent_id,
      user_id: options.user_id,
      scope: options.scope || "agent",
      tags: options.tags || [],
    });
  }

  /**
   * Search memories by semantic similarity.
   *
   * @example
   * ```ts
   * const results = await ci.recall('what framework are we using?');
   * results.forEach(m => console.log(m.content, m.similarity));
   * ```
   */
  async recall(
    query: string,
    options: RecallOptions = {}
  ): Promise<Memory[]> {
    const res = await this.request<{ memories: Memory[] }>(
      "POST",
      "/memories/recall",
      {
        query,
        agent_id: options.agent_id,
        user_id: options.user_id,
        scope: options.scope || "agent",
        top_k: options.top_k || 10,
      }
    );
    return res.memories;
  }

  /**
   * Load relevant context for a topic (alias for recall with smart defaults).
   *
   * @example
   * ```ts
   * const context = await ci.context('authentication system');
   * ```
   */
  async context(
    topic: string,
    options: ContextOptions = {}
  ): Promise<Memory[]> {
    const res = await this.request<{ memories: Memory[] }>(
      "POST",
      "/memories/recall",
      {
        query: topic,
        agent_id: options.agent_id,
        user_id: options.user_id,
        scope: options.scope || "agent",
        top_k: options.top_k || 20,
      }
    );
    return res.memories;
  }

  /**
   * Delete a specific memory.
   *
   * @example
   * ```ts
   * await ci.forget('memory-uuid-here');
   * ```
   */
  async forget(
    memoryId: string,
    options: ForgetOptions = {}
  ): Promise<{ success: boolean }> {
    return this.request("POST", "/memories/forget", {
      memory_id: memoryId,
      agent_id: options.agent_id,
    });
  }

  /**
   * Share a memory to a broader scope.
   *
   * @example
   * ```ts
   * // Share from agent to entire user scope
   * await ci.share('memory-uuid', {
   *   from_scope: 'agent',
   *   to_scope: 'user'
   * });
   * ```
   */
  async share(
    memoryId: string,
    options: ShareOptions
  ): Promise<{ success: boolean }> {
    return this.request("POST", "/memories/share", {
      memory_id: memoryId,
      agent_id: options.agent_id,
      from_scope: options.from_scope,
      to_scope: options.to_scope,
    });
  }

  /**
   * Check API usage stats.
   *
   * @example
   * ```ts
   * const usage = await ci.usage();
   * console.log(`Used ${usage.operations} of ${usage.limit} operations`);
   * ```
   */
  async usage(): Promise<Record<string, unknown>> {
    return this.request("GET", "/usage");
  }

  /**
   * Health check — verify the API is reachable.
   *
   * @example
   * ```ts
   * const ok = await ci.ping();
   * console.log(ok ? 'Connected' : 'Unreachable');
   * ```
   */
  async ping(): Promise<boolean> {
    try {
      await this.request("GET", "/health");
      return true;
    } catch {
      return false;
    }
  }
}

// Default export for convenience
export default CentralIntelligence;

import { Hono } from "hono";
import { z } from "zod";
import { createApiKey, revokeApiKey } from "../services/auth.js";
import { authMiddleware } from "../middleware/auth.js";

type Env = {
  Variables: {
    apiKeyId: string;
    orgId: string | undefined;
    tier: string;
  };
};

const app = new Hono<Env>();

// POST /keys — create a new API key (no auth required for signup)
const createKeySchema = z.object({
  name: z.string().min(1).max(100).default("default"),
  org_id: z.string().max(200).optional(),
});

app.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { name, org_id } = parsed.data;
  const { key, id } = await createApiKey(name, org_id);

  return c.json(
    {
      id,
      key,
      message:
        "Save this key — it won't be shown again. Set it as CI_API_KEY in your environment.",
    },
    201,
  );
});

// DELETE /keys/revoke — revoke the current API key (requires auth)
app.delete("/revoke", authMiddleware, async (c) => {
  const apiKeyId = c.get("apiKeyId") as string;
  await revokeApiKey(apiKeyId);
  return c.json({ revoked: true });
});

export { app as keysRouter };

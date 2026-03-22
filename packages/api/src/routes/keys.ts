import { Hono } from "hono";
import { z } from "zod";
import { createApiKey } from "../services/auth.js";

const app = new Hono();

// POST /keys — create a new API key (no auth required for signup)
const createKeySchema = z.object({
  name: z.string().min(1).max(100).default("default"),
  org_id: z.string().optional(),
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

export { app as keysRouter };

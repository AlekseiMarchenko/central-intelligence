import { Hono } from "hono";
import { sql } from "../db/connection.js";

/**
 * Billing endpoints — auth-walled (require an api_key Bearer token).
 *
 *   POST /billing/checkout  → create a LS checkout for the requested tier
 *                              and return the hosted-checkout URL
 *   POST /billing/portal    → return a customer portal link for self-service
 *                              cancellation / payment-method update
 *   GET  /billing/status    → return the current subscription state for this key
 *
 * The checkout endpoint stamps {api_key_id} into the checkout's custom_data
 * so the webhook can link the resulting subscription back to our user without
 * email matching (which is fragile).
 */

type Env = {
  Variables: {
    apiKeyId: string;
    tier: string;
  };
};

const app = new Hono<Env>();

const LS_API = "https://api.lemonsqueezy.com/v1";

function lsHeaders() {
  const key = process.env.LEMONSQUEEZY_API_KEY || "";
  if (!key) throw new Error("LEMONSQUEEZY_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
  };
}

function variantIdFor(tier: "pro" | "team"): string {
  if (tier === "pro") {
    const v = process.env.LEMONSQUEEZY_VARIANT_PRO;
    if (!v) throw new Error("LEMONSQUEEZY_VARIANT_PRO not set");
    return v;
  }
  const v = process.env.LEMONSQUEEZY_VARIANT_TEAM;
  if (!v) throw new Error("LEMONSQUEEZY_VARIANT_TEAM not set (Team tier coming soon)");
  return v;
}

/**
 * POST /billing/checkout
 * Body: { tier: "pro" | "team" }
 * Returns: { checkout_url, expires_at }
 */
app.post("/checkout", async (c) => {
  const apiKeyId = c.get("apiKeyId");
  const body = await c.req.json().catch(() => ({}));
  const tier = body.tier as "pro" | "team";

  if (tier !== "pro" && tier !== "team") {
    return c.json({ error: "tier must be 'pro' or 'team'" }, 400);
  }

  // Fetch the user's email so LS can pre-fill the checkout form
  const [user] = await sql`
    SELECT email FROM api_keys WHERE id = ${apiKeyId} LIMIT 1
  `;
  if (!user) return c.json({ error: "API key not found" }, 404);
  const email = (user as any).email;

  // Check for an existing active subscription — reject duplicate checkout
  const [existing] = await sql`
    SELECT ls_subscription_id, tier FROM subscriptions
    WHERE api_key_id = ${apiKeyId} AND status = 'active'
    LIMIT 1
  `;
  if (existing) {
    return c.json({
      error: "already_subscribed",
      message: `Already on the ${(existing as any).tier} tier. Use the customer portal to change plans.`,
      ls_subscription_id: (existing as any).ls_subscription_id,
    }, 409);
  }

  let variantId: string;
  try {
    variantId = variantIdFor(tier);
  } catch (err: any) {
    return c.json({ error: err.message }, 503);
  }

  const storeId = process.env.LEMONSQUEEZY_STORE_ID;
  if (!storeId) {
    return c.json({ error: "LEMONSQUEEZY_STORE_ID not set" }, 503);
  }

  // Create a fresh checkout for this user
  const checkoutBody = {
    data: {
      type: "checkouts",
      attributes: {
        // Pre-fill so the user doesn't re-type their email
        checkout_data: {
          email: email || undefined,
          custom: {
            api_key_id: apiKeyId,
          },
        },
        // Where to send them after payment success
        product_options: {
          redirect_url: "https://centralintelligence.online/app?checkout=success",
        },
        checkout_options: {
          embed: false,
          dark: true,
          subscription_preview: true,
        },
      },
      relationships: {
        store: { data: { type: "stores", id: storeId } },
        variant: { data: { type: "variants", id: variantId } },
      },
    },
  };

  const res = await fetch(`${LS_API}/checkouts`, {
    method: "POST",
    headers: lsHeaders(),
    body: JSON.stringify(checkoutBody),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[billing] LS checkout creation failed (${res.status}):`, errBody);
    return c.json({ error: "Failed to create checkout", detail: errBody }, 502);
  }

  const data = await res.json() as any;
  return c.json({
    checkout_url: data.data?.attributes?.url,
    expires_at: data.data?.attributes?.expires_at,
  });
});

/**
 * POST /billing/portal
 * Returns: { portal_url } — a signed link to LS's hosted customer portal where
 * the user can update payment method, cancel, change plan, etc.
 */
app.post("/portal", async (c) => {
  const apiKeyId = c.get("apiKeyId");

  const [sub] = await sql`
    SELECT ls_subscription_id, ls_customer_id FROM subscriptions
    WHERE api_key_id = ${apiKeyId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!sub) {
    return c.json({ error: "No subscription found for this account" }, 404);
  }

  const customerId = (sub as any).ls_customer_id;

  // LS customer portal: fetch the customer record, which includes a
  // `urls.customer_portal` field — a signed URL that auto-logs them in.
  const res = await fetch(`${LS_API}/customers/${customerId}`, {
    method: "GET",
    headers: lsHeaders(),
  });
  if (!res.ok) {
    return c.json({ error: "Failed to fetch customer" }, 502);
  }

  const data = await res.json() as any;
  const portalUrl = data.data?.attributes?.urls?.customer_portal;
  if (!portalUrl) {
    return c.json({ error: "Customer portal URL not available" }, 502);
  }

  return c.json({ portal_url: portalUrl });
});

/**
 * GET /billing/status
 * Returns: { tier, subscription: {...} | null }
 * Used by the /app frontend to show the current plan + render upgrade CTAs.
 */
app.get("/status", async (c) => {
  const apiKeyId = c.get("apiKeyId");
  const [keyRow] = await sql`
    SELECT tier FROM api_keys WHERE id = ${apiKeyId} LIMIT 1
  `;
  const [sub] = await sql`
    SELECT ls_subscription_id, tier, status, current_period_end, cancelled_at, ends_at
    FROM subscriptions
    WHERE api_key_id = ${apiKeyId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return c.json({
    tier: (keyRow as any)?.tier || "free",
    subscription: sub
      ? {
          ls_subscription_id: (sub as any).ls_subscription_id,
          tier: (sub as any).tier,
          status: (sub as any).status,
          current_period_end: (sub as any).current_period_end,
          cancelled_at: (sub as any).cancelled_at,
          ends_at: (sub as any).ends_at,
        }
      : null,
  });
});

export { app as billingRouter };

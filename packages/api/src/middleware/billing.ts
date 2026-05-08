import type { Context, Next } from "hono";
import { sql } from "../db/connection.js";
import { COST_PER_OPERATION } from "../routes/payments.js";

/**
 * Billing middleware — handles two payment models:
 *   1. LemonSqueezy monthly subscriptions (Pro/Team) — flat fee, NOT charged per-op.
 *      Their entitlements (memory cap, rate limit) are enforced by other middleware.
 *   2. USDC pay-per-op via x402 — charged $0.001 per memory operation against
 *      a deposited balance.
 *
 * Free tier is unmetered (caps enforced by memoryLimitMiddleware).
 */
export async function billingMiddleware(c: Context, next: Next) {
  const apiKeyId = c.get("apiKeyId") as string;
  const tier = (c.get("tier") as string) || "free";

  // Free tier — no billing, handled by memory limits
  if (tier === "free") {
    await next();
    return;
  }

  // LemonSqueezy subscribers (Pro/Team with active subscription) — flat fee,
  // no per-operation charge. Their tier was set by the LS webhook handler.
  // We check for an active subscription row; if found, skip USDC billing.
  // past_due subscribers also skip — they're in grace period and get full
  // entitlements until ends_at, after which the webhook flips tier back to free.
  const [activeSub] = await sql`
    SELECT 1 FROM subscriptions
    WHERE api_key_id = ${apiKeyId}
      AND status IN ('active', 'past_due', 'cancelled')
      AND (ends_at IS NULL OR ends_at > now())
    LIMIT 1
  `;
  if (activeSub) {
    await next();
    return;
  }

  // Pre-authorize: insert a pending debit atomically, only if balance is sufficient.
  // This prevents TOCTOU race conditions where concurrent requests both pass
  // a balance check before either debit is recorded.
  const authorized = await sql`
    INSERT INTO payment_debits (api_key_id, event_type, amount, status)
    SELECT ${apiKeyId}, 'pending', ${COST_PER_OPERATION}, 'pending'
    WHERE (
      COALESCE((SELECT SUM(amount) FROM payment_credits WHERE api_key_id = ${apiKeyId}), 0) -
      COALESCE((SELECT SUM(amount) FROM payment_debits WHERE api_key_id = ${apiKeyId}), 0)
    ) >= ${COST_PER_OPERATION}
    RETURNING id
  `;

  if (authorized.length === 0) {
    // Balance insufficient — calculate actual balance for error message
    const result = await sql`
      SELECT COALESCE(
        (SELECT SUM(amount) FROM payment_credits WHERE api_key_id = ${apiKeyId}), 0
      ) - COALESCE(
        (SELECT SUM(amount) FROM payment_debits WHERE api_key_id = ${apiKeyId}), 0
      ) AS balance
    `;
    const balance = parseFloat(result[0].balance);

    return c.json(
      {
        error: "Insufficient balance",
        balance_usd: balance,
        cost_per_operation: COST_PER_OPERATION,
        deposit_info: "Send USDC on Base to 0x3056e50A9cAf93020544720cA186f77577982b5f — see GET /payments/info",
      },
      402,
    );
  }

  const debitId = authorized[0].id;

  // Process the request
  await next();

  if (c.res.status >= 200 && c.res.status < 300) {
    // Finalize: update the pending debit with the actual operation type
    const path = c.req.path;
    let eventType = "unknown";
    if (path.includes("/remember")) eventType = "remember";
    else if (path.includes("/recall")) eventType = "recall";
    else if (path.includes("/context")) eventType = "context";
    else if (path.includes("/forget")) eventType = "forget";
    else if (path.includes("/share")) eventType = "share";

    await sql`
      UPDATE payment_debits SET event_type = ${eventType}, status = 'completed'
      WHERE id = ${debitId}
    `;

    c.header("X-Cost-USD", String(COST_PER_OPERATION));
  } else {
    // Request failed — refund by deleting the pending debit
    await sql`
      DELETE FROM payment_debits WHERE id = ${debitId} AND status = 'pending'
    `;
  }
}

import type { Context, Next } from "hono";
import { sql } from "../db/connection.js";
import { getBalance, COST_PER_OPERATION } from "../routes/payments.js";

/**
 * Billing middleware — deducts from paid balance for pro+ users.
 * Free tier users are NOT charged (they use the free 500 ops/month).
 * Only paid users (who have deposited USDC) get charged per operation.
 */
export async function billingMiddleware(c: Context, next: Next) {
  const apiKeyId = c.get("apiKeyId") as string;
  const tier = (c.get("tier") as string) || "free";

  // Free tier — no billing, handled by memory limits
  if (tier === "free") {
    await next();
    return;
  }

  // Check balance for paid users
  const balance = await getBalance(apiKeyId);

  if (balance < COST_PER_OPERATION) {
    return c.json(
      {
        error: "Insufficient balance",
        balance_usd: balance,
        cost_per_operation: COST_PER_OPERATION,
        deposit_info: "Send USDC on Base to 0x3056e50A9cAf93020544720cA186f77577982b5f — see GET /payments/info",
      },
      402, // Payment Required
    );
  }

  // Process the request first
  await next();

  // Only charge if the request succeeded (2xx)
  if (c.res.status >= 200 && c.res.status < 300) {
    // Determine operation type from path
    const path = c.req.path;
    let eventType = "unknown";
    if (path.includes("/remember")) eventType = "remember";
    else if (path.includes("/recall")) eventType = "recall";
    else if (path.includes("/context")) eventType = "context";
    else if (path.includes("/forget")) eventType = "forget";
    else if (path.includes("/share")) eventType = "share";

    // Record the debit
    await sql`
      INSERT INTO payment_debits (api_key_id, event_type, amount)
      VALUES (${apiKeyId}, ${eventType}, ${COST_PER_OPERATION})
    `;

    // Add balance header
    const newBalance = balance - COST_PER_OPERATION;
    c.header("X-Balance-USD", String(Math.round(newBalance * 1000000) / 1000000));
    c.header("X-Cost-USD", String(COST_PER_OPERATION));
  }
}

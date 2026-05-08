import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { sql } from "../db/connection.js";

/**
 * LemonSqueezy webhook handler.
 *
 * Security model:
 *   - Webhooks are unauthenticated by user, but HMAC-signed by LemonSqueezy
 *     using the shared secret in LEMONSQUEEZY_WEBHOOK_SECRET.
 *   - We verify the X-Signature header against HMAC-SHA256(rawBody, secret).
 *     timingSafeEqual prevents response-time attacks on bad signatures.
 *   - Anything that fails sig verification → 401, no DB write.
 *   - Idempotent: re-receiving the same event_id is a no-op (we log it but
 *     don't re-apply state mutations the second time).
 *
 * State transitions we care about:
 *   subscription_created → tier flip free → pro/team
 *   subscription_updated → sync status + period_end (catches plan changes)
 *   subscription_payment_success → just log
 *   subscription_payment_failed → mark past_due (entitlements stay until ends_at)
 *   subscription_cancelled → keep tier active until current_period_end, then expire
 *   subscription_expired → flip tier back to free immediately
 *
 * Custom data: we pass {api_key_id} when creating the checkout. LS echoes it
 * in webhook payloads under attributes.first_subscription_item.custom (or in
 * the order's custom for one-shot purchases). That's how we link an LS sub
 * back to OUR api_keys row without needing email matching.
 */

const app = new Hono();

const VARIANT_TO_TIER: Record<string, "pro" | "team"> = {
  // Filled at startup from env vars; see resolveTier() below.
  // The Pro variant id is required; Team is optional (coming-soon tier).
};

function resolveTier(variantId: string | null | undefined): "pro" | "team" | null {
  if (!variantId) return null;
  if (process.env.LEMONSQUEEZY_VARIANT_PRO === variantId) return "pro";
  if (process.env.LEMONSQUEEZY_VARIANT_TEAM === variantId) return "team";
  return null;
}

function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || "";
  if (!secret) {
    console.error("[ls-webhook] LEMONSQUEEZY_WEBHOOK_SECRET not set — refusing to process");
    return false;
  }
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.trim();

  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

/**
 * Pull the api_key_id we stamped into the checkout's custom_data.
 * Webhooks have it at:
 *   meta.custom_data.api_key_id  (newer events)
 *   data.attributes.first_subscription_item.custom_data.api_key_id  (older path)
 * We check both.
 */
function extractApiKeyId(payload: any): string | null {
  return (
    payload?.meta?.custom_data?.api_key_id ??
    payload?.data?.attributes?.first_subscription_item?.custom_data?.api_key_id ??
    payload?.data?.attributes?.custom_data?.api_key_id ??
    null
  );
}

async function logEvent(eventName: string, eventId: string | null, lsSubId: string | null, payload: any) {
  await sql`
    INSERT INTO lemonsqueezy_webhook_events (event_name, event_id, ls_subscription_id, payload)
    VALUES (${eventName}, ${eventId}, ${lsSubId}, ${JSON.stringify(payload)})
  `.catch((err) => {
    // Logging failures shouldn't break the webhook handler.
    console.warn("[ls-webhook] failed to log event:", err.message);
  });
}

async function eventAlreadyProcessed(eventId: string | null): Promise<boolean> {
  if (!eventId) return false;
  const [row] = await sql`
    SELECT 1 FROM lemonsqueezy_webhook_events WHERE event_id = ${eventId} LIMIT 1
  `;
  return Boolean(row);
}

async function setApiKeyTier(apiKeyId: string, tier: "free" | "pro" | "team"): Promise<void> {
  await sql`UPDATE api_keys SET tier = ${tier} WHERE id = ${apiKeyId}`;
  console.log(`[ls-webhook] api_key ${apiKeyId.slice(0, 8)}… → tier=${tier}`);
}

/** Main webhook endpoint. */
app.post("/webhook", async (c) => {
  // Read raw body for signature verification — Hono's c.req.text() consumes once.
  const rawBody = await c.req.text();
  const signature = c.req.header("X-Signature");

  if (!verifySignature(rawBody, signature)) {
    console.warn("[ls-webhook] signature verification FAILED");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const eventName: string = payload?.meta?.event_name || "unknown";
  const eventId: string | null = payload?.meta?.webhook_id || payload?.meta?.event_id || null;
  const lsSubId: string | null = payload?.data?.id || null;
  const sub = payload?.data?.attributes;

  // Idempotency: skip if we've already processed this event_id
  if (eventId && (await eventAlreadyProcessed(eventId))) {
    console.log(`[ls-webhook] event ${eventId} already processed, skipping`);
    return c.json({ ok: true, skipped: true }, 200);
  }

  await logEvent(eventName, eventId, lsSubId, payload);

  const apiKeyId = extractApiKeyId(payload);
  if (!apiKeyId && eventName.startsWith("subscription_")) {
    console.warn(`[ls-webhook] ${eventName} for sub ${lsSubId} has no api_key_id in custom_data — cannot link`);
    // Still 200 so LS doesn't retry forever; we logged it for manual reconciliation.
    return c.json({ ok: true, warning: "no api_key_id" }, 200);
  }

  try {
    switch (eventName) {
      case "subscription_created": {
        const tier = resolveTier(sub?.variant_id?.toString());
        if (!tier) {
          console.warn(`[ls-webhook] subscription_created with unknown variant ${sub?.variant_id}`);
          return c.json({ ok: true, warning: "unknown variant" }, 200);
        }
        // Insert subscription row
        await sql`
          INSERT INTO subscriptions (
            api_key_id, ls_subscription_id, ls_customer_id, ls_variant_id,
            tier, status, current_period_end, raw
          ) VALUES (
            ${apiKeyId}, ${lsSubId}, ${sub.customer_id?.toString()}, ${sub.variant_id?.toString()},
            ${tier}, ${sub.status || "active"},
            ${sub.renews_at ? new Date(sub.renews_at) : null},
            ${JSON.stringify(payload)}
          )
          ON CONFLICT (ls_subscription_id) DO UPDATE SET
            status = EXCLUDED.status,
            current_period_end = EXCLUDED.current_period_end,
            raw = EXCLUDED.raw,
            updated_at = now()
        `;
        await setApiKeyTier(apiKeyId!, tier);
        break;
      }

      case "subscription_updated": {
        const tier = resolveTier(sub?.variant_id?.toString());
        await sql`
          UPDATE subscriptions SET
            status = ${sub.status},
            current_period_end = ${sub.renews_at ? new Date(sub.renews_at) : null},
            cancelled_at = ${sub.cancelled ? new Date(sub.updated_at || Date.now()) : null},
            ends_at = ${sub.ends_at ? new Date(sub.ends_at) : null},
            ls_variant_id = ${sub.variant_id?.toString()},
            tier = ${tier || "pro"},
            raw = ${JSON.stringify(payload)},
            updated_at = now()
          WHERE ls_subscription_id = ${lsSubId}
        `;
        // If status is active, ensure tier is set on api_key
        if (sub.status === "active" && tier) {
          await setApiKeyTier(apiKeyId!, tier);
        }
        break;
      }

      case "subscription_payment_success": {
        // Just log; sub status will arrive separately via subscription_updated
        console.log(`[ls-webhook] payment success for sub ${lsSubId}`);
        break;
      }

      case "subscription_payment_failed": {
        await sql`
          UPDATE subscriptions SET status = 'past_due', updated_at = now()
          WHERE ls_subscription_id = ${lsSubId}
        `;
        // Tier stays as-is during grace period. LS handles retries.
        console.log(`[ls-webhook] payment failed for sub ${lsSubId} — entered past_due grace`);
        break;
      }

      case "subscription_cancelled": {
        // User cancelled but still has access until current_period_end
        await sql`
          UPDATE subscriptions SET
            status = 'cancelled',
            cancelled_at = now(),
            ends_at = ${sub.ends_at ? new Date(sub.ends_at) : null},
            updated_at = now()
          WHERE ls_subscription_id = ${lsSubId}
        `;
        console.log(`[ls-webhook] sub ${lsSubId} cancelled, ends_at=${sub.ends_at}`);
        break;
      }

      case "subscription_expired": {
        // Period ended, fully revoke
        await sql`
          UPDATE subscriptions SET status = 'expired', updated_at = now()
          WHERE ls_subscription_id = ${lsSubId}
        `;
        if (apiKeyId) await setApiKeyTier(apiKeyId, "free");
        console.log(`[ls-webhook] sub ${lsSubId} expired, api_key ${apiKeyId} reverted to free`);
        break;
      }

      default:
        console.log(`[ls-webhook] event ${eventName} not handled, logged only`);
    }
  } catch (err: any) {
    console.error(`[ls-webhook] handler failed for ${eventName}:`, err.message);
    // Return 500 so LS retries — typically fixes itself when DB is back
    return c.json({ error: "Handler error", detail: err.message }, 500);
  }

  return c.json({ ok: true }, 200);
});

export { app as lemonsqueezyRouter };

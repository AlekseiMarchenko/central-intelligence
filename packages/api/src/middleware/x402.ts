import type { Context, Next } from "hono";
import { getAddress } from "viem";
import { exact } from "x402/schemes";
import {
  findMatchingPaymentRequirements,
  processPriceToAtomicAmount,
  toJsonSafe,
} from "x402/shared";
import { useFacilitator } from "x402/verify";
import { settleResponseHeader } from "x402/types";

const TREASURY_WALLET = process.env.TREASURY_WALLET || "0x3056e50A9cAf93020544720cA186f77577982b5f";
const NETWORK = "base" as const;
const X402_VERSION = 1;

// Price per operation in USD
const PRICES: Record<string, number> = {
  remember: 0.001,
  recall: 0.001,
  context: 0.001,
  forget: 0.001,
  share: 0.001,
};

if (!process.env.CDP_API_KEY_ID) {
  console.warn("[x402] CDP_API_KEY_ID not set — using unauthenticated facilitator. Payment verification may have different trust/rate-limit guarantees.");
}

const facilitatorConfig = process.env.CDP_API_KEY_ID
  ? {
      url: "https://x402.org/facilitator" as const,
      createAuthHeaders: async () => {
        const keyId = process.env.CDP_API_KEY_ID!;
        const keySecret = process.env.CDP_API_KEY_SECRET!;
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const headers = { Authorization: `Basic ${auth}` };
        return {
          verify: headers,
          settle: headers,
          supported: headers,
          list: headers,
        };
      },
    }
  : undefined;

const { verify, settle } = useFacilitator(facilitatorConfig);

/**
 * x402 payment middleware for Hono.
 * When an agent sends X-PAYMENT header, it processes the payment inline.
 * When no X-PAYMENT header, returns 402 with payment requirements.
 */
export async function x402Middleware(c: Context, next: Next) {
  // Determine the operation and price from the path
  const path = c.req.path;
  let operation = "unknown";
  let price = 0.001;

  for (const [op, p] of Object.entries(PRICES)) {
    if (path.includes(`/${op}`)) {
      operation = op;
      price = p;
      break;
    }
  }

  // Build payment requirements
  const atomicAmount = processPriceToAtomicAmount(price, NETWORK);
  if ("error" in atomicAmount) {
    return c.json({ error: "Price configuration error" }, 500);
  }

  const { maxAmountRequired, asset } = atomicAmount;
  const host = c.req.header("host") || "central-intelligence-api.fly.dev";
  const resourceUrl = `https://${host}${path}`;

  const paymentRequirements = [
    {
      scheme: "exact" as const,
      network: NETWORK,
      maxAmountRequired,
      resource: resourceUrl,
      description: `Central Intelligence: ${operation} — $${price} USDC`,
      mimeType: "application/json",
      payTo: getAddress(TREASURY_WALLET),
      maxTimeoutSeconds: 60,
      asset: getAddress(asset.address),
      outputSchema: {
        input: {
          type: "http" as const,
          method: c.req.method.toUpperCase(),
          discoverable: true,
        },
      },
      extra: "eip712" in asset ? asset.eip712 : undefined,
    },
  ];

  // Check for X-PAYMENT header
  const payment = c.req.header("X-PAYMENT");

  if (!payment) {
    // No payment — return 402 with requirements
    return c.json(
      {
        x402Version: X402_VERSION,
        error: "X-PAYMENT header is required",
        accepts: toJsonSafe(paymentRequirements),
      },
      402,
    );
  }

  // Decode and verify payment
  let decodedPayment;
  try {
    decodedPayment = exact.evm.decodePayment(payment);
    decodedPayment.x402Version = X402_VERSION;
  } catch (error) {
    return c.json(
      {
        x402Version: X402_VERSION,
        error: "Invalid or malformed payment header",
        accepts: toJsonSafe(paymentRequirements),
      },
      402,
    );
  }

  const selectedRequirements = findMatchingPaymentRequirements(
    paymentRequirements,
    decodedPayment,
  );

  if (!selectedRequirements) {
    return c.json(
      {
        x402Version: X402_VERSION,
        error: "Unable to find matching payment requirements",
        accepts: toJsonSafe(paymentRequirements),
      },
      402,
    );
  }

  // Verify payment
  try {
    const verifyResponse = await verify(decodedPayment, selectedRequirements);
    if (!verifyResponse.isValid) {
      return c.json(
        {
          x402Version: X402_VERSION,
          error: verifyResponse.invalidReason,
          accepts: toJsonSafe(paymentRequirements),
          payer: verifyResponse.payer,
        },
        402,
      );
    }
  } catch (error) {
    console.error("[x402] Verification error:", error);
    return c.json(
      {
        x402Version: X402_VERSION,
        error: "Payment verification failed",
        accepts: toJsonSafe(paymentRequirements),
      },
      402,
    );
  }

  // Payment verified — process the request
  // Set a flag so downstream handlers know this is an x402-paid request
  c.set("x402Paid", true);
  const payer = "payload" in decodedPayment && decodedPayment.payload && "authorization" in decodedPayment.payload
    ? (decodedPayment.payload as any).authorization?.from
    : "unknown";
  c.set("x402Payer", payer);

  await next();

  // Only settle if the request succeeded
  if (c.res.status >= 200 && c.res.status < 400) {
    try {
      const settleResponse = await settle(decodedPayment, selectedRequirements);
      const responseHeader = settleResponseHeader(settleResponse);
      c.header("X-PAYMENT-RESPONSE", responseHeader);

      if (!settleResponse.success) {
        console.error("[x402] Settlement failed:", settleResponse.errorReason);
      }
    } catch (error) {
      console.error("[x402] Settlement error:", error);
    }
  }
}

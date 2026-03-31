import { Hono } from "hono";
import { sql } from "../db/connection.js";

type Env = {
  Variables: {
    apiKeyId: string;
    orgId: string | undefined;
    tier: string;
  };
};

const paymentsRouter = new Hono<Env>();

// USDC on Base — 6 decimals
const USDC_BASE_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TREASURY_WALLET = process.env.TREASURY_WALLET || "0x3056e50A9cAf93020544720cA186f77577982b5f";
const BASE_RPC = "https://mainnet.base.org";

// Pricing: $0.001 per memory operation
const COST_PER_OPERATION = 0.001;

// --- Helpers ---

async function getBalance(apiKeyId: string): Promise<number> {
  const result = await sql`
    SELECT COALESCE(
      (SELECT SUM(amount) FROM payment_credits WHERE api_key_id = ${apiKeyId}),
      0
    ) - COALESCE(
      (SELECT SUM(amount) FROM payment_debits WHERE api_key_id = ${apiKeyId}),
      0
    ) AS balance
  `;
  return parseFloat(result[0].balance);
}

async function verifyBaseTransaction(
  txHash: string
): Promise<{
  valid: boolean;
  from: string;
  amount: number;
  confirmations?: number;
  error?: string;
}> {
  // Batch RPC: get receipt + current block number in one call
  const batchRes = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] },
      { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
    ]),
  });

  const batchData = (await batchRes.json()) as any[];
  const receipt = batchData.find((r: any) => r.id === 1)?.result;
  const currentBlockHex = batchData.find((r: any) => r.id === 2)?.result;

  if (!receipt) {
    return { valid: false, from: "", amount: 0, error: "Transaction not found or still pending" };
  }

  if (receipt.status !== "0x1") {
    return { valid: false, from: "", amount: 0, error: "Transaction reverted" };
  }

  // Calculate block confirmations
  let confirmations: number | undefined;
  if (currentBlockHex && receipt.blockNumber) {
    const currentBlock = parseInt(currentBlockHex, 16);
    const txBlock = parseInt(receipt.blockNumber, 16);
    confirmations = currentBlock - txBlock;
  }

  // Check for USDC Transfer event
  // Transfer(address,address,uint256) = keccak256 topic
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  const usdcLog = receipt.logs.find(
    (log: any) =>
      log.address.toLowerCase() === USDC_BASE_CONTRACT.toLowerCase() &&
      log.topics[0] === transferTopic
  );

  if (!usdcLog) {
    return { valid: false, from: "", amount: 0, error: "No USDC transfer found in transaction" };
  }

  // Decode: topics[1] = from, topics[2] = to, data = amount
  const from = "0x" + usdcLog.topics[1].slice(26);
  const to = "0x" + usdcLog.topics[2].slice(26);
  const amountRaw = BigInt(usdcLog.data);
  const amount = Number(amountRaw) / 1e6; // USDC has 6 decimals

  // Verify recipient is our treasury
  if (to.toLowerCase() !== TREASURY_WALLET.toLowerCase()) {
    return {
      valid: false,
      from,
      amount,
      error: `Transfer was to ${to}, not our treasury`,
    };
  }

  return { valid: true, from, amount, confirmations };
}

// --- Routes ---

// GET /payments/info — public pricing and deposit info
paymentsRouter.get("/info", (c) => {
  return c.json({
    pricing: {
      per_operation_usd: COST_PER_OPERATION,
      operations: ["remember", "recall", "context", "forget", "share"],
      note: "Each API call costs $0.001 USDC. Free tier includes 500 operations/month.",
    },
    deposit: {
      network: "Base (Ethereum L2)",
      token: "USDC",
      contract: USDC_BASE_CONTRACT,
      address: TREASURY_WALLET,
      instructions: [
        "1. Send USDC on Base network to the address above",
        "2. Call POST /payments/verify with the transaction hash",
        "3. Credits are added instantly after on-chain verification",
      ],
    },
    minimum_deposit_usd: 1.0,
  });
});

// GET /payments/balance — check current balance (requires auth)
paymentsRouter.get("/balance", async (c) => {
  const apiKeyId = c.get("apiKeyId");
  const balance = await getBalance(apiKeyId);

  const [usage] = await sql`
    SELECT COUNT(*)::int AS total_ops FROM payment_debits
    WHERE api_key_id = ${apiKeyId}
  `;

  const [credits] = await sql`
    SELECT
      COUNT(*)::int AS total_deposits,
      COALESCE(SUM(amount), 0)::float AS total_deposited
    FROM payment_credits
    WHERE api_key_id = ${apiKeyId}
  `;

  return c.json({
    balance_usd: Math.round(balance * 1000000) / 1000000,
    total_operations: usage.total_ops,
    total_deposits: credits.total_deposits,
    total_deposited_usd: credits.total_deposited,
    cost_per_operation: COST_PER_OPERATION,
    estimated_operations_remaining: Math.floor(balance / COST_PER_OPERATION),
  });
});

// POST /payments/verify — verify a USDC deposit and credit account
paymentsRouter.post("/verify", async (c) => {
  const apiKeyId = c.get("apiKeyId");
  const body = await c.req.json();
  const { tx_hash } = body;

  if (!tx_hash || !/^0x[a-fA-F0-9]{64}$/.test(tx_hash)) {
    return c.json({ error: "Invalid transaction hash" }, 400);
  }

  // Verify on-chain
  const result = await verifyBaseTransaction(tx_hash);

  if (!result.valid) {
    return c.json({ error: result.error }, 400);
  }

  if (result.amount < 1.0) {
    return c.json(
      { error: `Minimum deposit is $1.00 USDC. Received $${result.amount}` },
      400
    );
  }

  // Require minimum 12 block confirmations to prevent reorg attacks
  if (result.confirmations !== undefined && result.confirmations < 12) {
    return c.json(
      { error: `Transaction has ${result.confirmations} confirmations, need 12. Try again in ~30 seconds.` },
      400
    );
  }

  // Atomic insert — ON CONFLICT prevents double-credit race condition
  const inserted = await sql`
    INSERT INTO payment_credits (api_key_id, tx_hash, from_address, amount, network)
    VALUES (${apiKeyId}, ${tx_hash}, ${result.from}, ${result.amount}, 'base')
    ON CONFLICT (tx_hash) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    return c.json({ error: "Transaction already credited" }, 409);
  }

  // Auto-upgrade to 'pro' tier if still on free
  const tier = c.get("tier");
  if (tier === "free") {
    await sql`
      UPDATE api_keys SET tier = 'pro' WHERE id = ${apiKeyId}
    `;
  }

  const newBalance = await getBalance(apiKeyId);

  return c.json({
    credited: result.amount,
    balance_usd: Math.round(newBalance * 1000000) / 1000000,
    estimated_operations: Math.floor(newBalance / COST_PER_OPERATION),
    tier: tier === "free" ? "pro (auto-upgraded)" : tier,
  });
});

// GET /payments/history — transaction history (requires auth)
paymentsRouter.get("/history", async (c) => {
  const apiKeyId = c.get("apiKeyId");

  const credits = await sql`
    SELECT tx_hash, from_address, amount, network, created_at
    FROM payment_credits
    WHERE api_key_id = ${apiKeyId}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  const recentDebits = await sql`
    SELECT event_type, amount, created_at
    FROM payment_debits
    WHERE api_key_id = ${apiKeyId}
    ORDER BY created_at DESC
    LIMIT 100
  `;

  return c.json({
    deposits: credits,
    recent_charges: recentDebits,
  });
});

export { paymentsRouter, getBalance, COST_PER_OPERATION };

#!/usr/bin/env node
import "../src/env.js";
import { parseArgs } from "node:util";
import { createSolanaClient, requireMethod } from "../src/clients.js";
import { loadConfig } from "../src/config.js";
import { getSdkExport } from "../src/sdk.js";
import { createSigner } from "../src/signer/factory.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    plan: { type: "string", default: process.env.MOLPHA_PLAN ?? "Basic" },
    "max-price-usdc": { type: "string", default: process.env.MAX_PRICE_USDC },
    "dry-run": { type: "boolean", default: false }
  }
});

const command = positionals[0] ?? "subscribe";

if (command !== "subscribe" && command !== "extend") {
  throw new Error("usage: molpha-provision <subscribe|extend> [--plan Basic] [--max-price-usdc <amount>] [--dry-run]");
}

const config = loadConfig();
const signer = await createSigner(config);
const solana = createSolanaClient(config, signer);

const planName = values.plan ?? "Basic";
const plan = resolvePlanId(planName);
const maxPriceUsdc = values["max-price-usdc"];

if (!values["dry-run"] && !maxPriceUsdc) {
  throw new Error("--max-price-usdc or MAX_PRICE_USDC is required for non-dry-run bootstrap");
}

const summary = {
  command,
  owner: signer.publicKey,
  plan: planName,
  maxPriceUsdc,
  gatewayEndpoints: config.gatewayEndpoints,
  solanaRpc: config.solanaRpc,
  note: "Bootstrap only — rounds and submits run in the MCP runtime with the same OWNER_KEYPAIR. A subscription is optional: execute_agent_round self-funds a round over x402 when unsubscribed."
};

if (values["dry-run"]) {
  console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
  process.exit(0);
}

const getPlan = requireMethod<[unknown], Promise<unknown>>(solana, "getPlan");
const selectedPlan = await getPlan(plan);

if (command === "subscribe") {
  const subscribe = requireMethod<[unknown, Record<string, unknown>], Promise<unknown>>(solana, "subscribe");
  const subscription = await subscribe(plan, { maxPriceUsdc });
  console.log(stringifyJson({ ...summary, selectedPlan, subscription }));
} else {
  const extendSubscription = requireMethod<[Record<string, unknown>], Promise<unknown>>(solana, "extendSubscription");
  const subscription = await extendSubscription({ maxPriceUsdc });
  console.log(stringifyJson({ ...summary, selectedPlan, subscription }));
}

function resolvePlanId(plan: string): number {
  const normalized = plan.trim().toLowerCase();
  const byName: Record<string, number> = {
    basic: 0,
    standard: 1,
    professional: 2,
    enterprise: 3
  };
  const bySdkEnum = getSdkExport<Record<string, unknown>>("PlanType")?.[plan];
  const numeric = byName[normalized] ?? bySdkEnum ?? Number.parseInt(plan, 10);

  if (!Number.isInteger(numeric) || Number(numeric) < 0 || Number(numeric) > 3) {
    throw new Error(`unsupported plan "${plan}"; expected Basic, Standard, Professional, Enterprise, or 0-3`);
  }

  return Number(numeric);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (
    value &&
    typeof value === "object" &&
    value.constructor.name === "PublicKey" &&
    "toBase58" in value &&
    typeof value.toBase58 === "function"
  ) {
    return value.toBase58();
  }

  return value;
}

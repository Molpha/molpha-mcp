/**
 * x402 pay-per-request client for `POST /v1/agent/execute` and
 * `GET /v1/agent/status`. The SDK only covers the subscription round path, so
 * this talks to the gateway directly.
 *
 * A round is first requested without payment; the gateway answers 402 with
 * x402 `exact` Solana requirements. Those are untrusted: payTo, asset,
 * amount, network, and memo must equal what this server derives from its own
 * config and chain reads (see x402-payment.ts) before it signs anything. It then
 * signs a USDC transfer to the gateway authority, fee-sponsored by the gateway's
 * facilitator, and repeats the request with the payment in `PAYMENT-SIGNATURE`.
 * The gateway verifies the payment before dispatch and settles it before it
 * returns data.
 */
import { address, type Address } from "@solana/kit";
import type { Connection } from "@solana/web3.js";
import { canonicalizeApiConfig, deriveSourceId, type ApiConfigLike } from "./apiconfig.js";
import { getMolphaProgramId, requireMethod } from "./clients.js";
import { formatUsdcAtomic, type MolphaConfig } from "./config.js";
import { checkX402PerRoundCap, checkX402SpendCap, recordX402Spend, x402SpentToday } from "./guardrails.js";
import { normalizeSourceId } from "./hex.js";
import type { MolphaSigner } from "./signer/types.js";
import { parseSolanaPubkey } from "./solana-address.js";
import {
  buildPaymentTransaction,
  computeX402Price,
  readPaymentAccounts,
  readX402Pricing,
  signPaymentTransaction,
  verifyPaymentRequirements,
  x402RoundMemo,
  type PaymentAccounts,
  type VerifiedPayment,
  type X402Pricing
} from "./x402-payment.js";

/**
 * A 409 means the gateway already holds this round identity and settled
 * nothing, but retrying needs a new timestamp and therefore a new payment.
 */
const MAX_PAID_ATTEMPTS = 3;

export interface AgentRoundOptions {
  apiConfig: ApiConfigLike;
  signaturesRequired: number;
  /** When set, must match the sourceId derived from apiConfig. */
  sourceId?: string | undefined;
  /** Accepted for symmetry with the subscription path; x402 rounds always run fresh. */
  maxAge?: number | undefined;
}

export interface AgentRoundContext {
  config: MolphaConfig;
  connection: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getGenesisHash" | "getLatestBlockhash">;
  signer: MolphaSigner;
  solana: Record<string, unknown>;
  gateway: Record<string, unknown>;
}

export interface X402PaymentReceipt {
  endpoint: string;
  network: string;
  payer: Address;
  payTo: Address;
  asset: Address;
  amountAtomicUsdc: string;
  feePayer: Address;
  memo: string;
  /** Settlement transaction from the gateway's PAYMENT-RESPONSE, when sent. */
  transaction?: string;
}

export interface AgentRoundResult {
  /** The gateway's signed aggregate, in the shape buildRoundResult consumes. */
  result: Record<string, unknown>;
  payment: X402PaymentReceipt;
}

/** The gateway refused the payment before anything settled. */
export class X402PaymentRequiredError extends Error {
  readonly status = 402;
  readonly x402: unknown;

  constructor(message: string, x402: unknown) {
    super(message);
    this.name = "X402PaymentRequiredError";
    this.x402 = x402;
  }
}

export interface X402Reconciliation {
  endpoint: string;
  payer: Address;
  payTo: Address;
  asset: Address;
  amountAtomicUsdc: string;
  memo: string;
  sourceId: string;
  canonicalTimestamp: number;
  httpStatus?: number;
  gatewayMessage: string;
}

/** A payment was sent and the gateway's answer does not say whether it settled. */
export class X402PaymentOutcomeUnknownError extends Error {
  readonly reconciliation: X402Reconciliation;

  constructor(message: string, reconciliation: X402Reconciliation) {
    super(message);
    this.name = "X402PaymentOutcomeUnknownError";
    this.reconciliation = reconciliation;
  }
}

/** The gateway's advisory `GET /v1/agent/status`: its USDC float, not a per-payer balance. */
export interface GatewayFloatStatus {
  gateway: string;
  authority: string;
  ataAddress: string;
  ataExists: boolean;
  ataBalance: string;
  committedAmount: string;
  quotedNextPrice: string;
  unsettledRounds: number;
}

export async function fetchAgentStatus(
  config: MolphaConfig,
  signaturesRequired?: number
): Promise<{ endpoint: string; status: GatewayFloatStatus }> {
  const query = signaturesRequired === undefined ? "" : `?signatures_required=${signaturesRequired}`;
  let lastError = "no gateway endpoint configured";

  for (const endpoint of config.gatewayEndpoints) {
    let res: Response;
    try {
      res = await fetch(`${trimSlash(endpoint)}/v1/agent/status${query}`, { method: "GET" });
    } catch (error) {
      lastError = `${endpoint}: ${errorMessage(error)}`;
      continue;
    }
    if (res.ok) {
      return { endpoint, status: parseFloatStatus(await res.json()) };
    }
    const message = await readErrorMessage(res);
    if (res.status === 400) {
      throw Object.assign(new Error(`GET /v1/agent/status rejected: ${message}`), { status: 400 });
    }
    lastError = `${endpoint}: HTTP ${res.status}: ${message}`;
  }

  throw new Error(`GET /v1/agent/status failed on every gateway (${lastError})`);
}

/** Quotes and verifies a round's payment without signing or spending anything. */
export async function previewAgentRound(
  ctx: AgentRoundContext,
  opts: AgentRoundOptions
): Promise<Record<string, unknown>> {
  const plan = await planRound(ctx, opts);
  const { endpoint, verified, accounts } = await preparePayment(ctx, plan, nowSeconds());
  const shortfall = verified.amount > accounts.payerBalance ? verified.amount - accounts.payerBalance : 0n;

  return {
    dryRun: true,
    action: "x402_agent_execute",
    sourceId: plan.sourceId,
    gateway: { endpoint, authority: verified.payTo, pda: accounts.gatewayPda },
    network: plan.network,
    asset: verified.asset,
    priceAtomicUsdc: verified.amount.toString(),
    feePayer: verified.feePayer,
    memo: verified.memo,
    payer: ctx.signer.publicKey,
    payerUsdcAta: accounts.payerAta,
    payerBalanceAtomicUsdc: accounts.payerBalance.toString(),
    shortfallAtomicUsdc: shortfall.toString(),
    spentTodayAtomicUsdc: x402SpentToday().toString(),
    note:
      shortfall > 0n
        ? "The signer's USDC balance does not cover this round; a live call would refuse before signing."
        : "A live call would sign a USDC transfer of priceAtomicUsdc to the gateway authority (network fee paid by feePayer) and then request the round."
  };
}

/** Pays for and runs one round, returning the signed aggregate and its payment receipt. */
export async function executeAgentRound(ctx: AgentRoundContext, opts: AgentRoundOptions): Promise<AgentRoundResult> {
  const plan = await planRound(ctx, opts);
  let canonicalTimestamp = nowSeconds();

  for (let attempt = 1; ; attempt += 1) {
    const payment = await preparePayment(ctx, plan, canonicalTimestamp);
    const { verified, accounts } = payment;
    if (accounts.payerBalance < verified.amount) {
      throw new Error(
        `insufficient USDC for this x402 round: ${ctx.signer.publicKey} holds ${formatUsdcAtomic(accounts.payerBalance)} USDC in ${accounts.payerAta}, the round costs ${formatUsdcAtomic(verified.amount)} USDC`
      );
    }

    const paymentHeader = await signPayment(ctx, payment);
    recordX402Spend(verified.amount);
    const outcome = await postPaidExecute(payment.endpoint, executeBody(plan, canonicalTimestamp), paymentHeader);

    if (outcome.kind === "ok") {
      return completeRound(ctx, plan, payment, outcome);
    }
    if (outcome.kind === "conflict" && attempt < MAX_PAID_ATTEMPTS) {
      canonicalTimestamp = Math.max(nowSeconds(), canonicalTimestamp + 1);
      continue;
    }
    throw paidOutcomeError(ctx, plan, payment, outcome);
  }
}

interface RoundPlan {
  apiConfig: Record<string, unknown>;
  /** Bare lowercase hex. */
  sourceId: string;
  sourceIdBytes: Uint8Array;
  signaturesRequired: number;
  registryVersion: number;
  network: string;
  programId: Address;
  pricing: X402Pricing;
  priceAtomic: bigint;
}

async function planRound(ctx: AgentRoundContext, opts: AgentRoundOptions): Promise<RoundPlan> {
  const sourceId = normalizeSourceId(deriveSourceId(opts.apiConfig).sourceId);
  if (opts.sourceId !== undefined && normalizeSourceId(opts.sourceId) !== sourceId) {
    throw new Error(`sourceId does not match apiConfig: expected ${sourceId}, got ${opts.sourceId}`);
  }

  const programId = getMolphaProgramId();
  const [registry, network, pricing] = await Promise.all([
    requireMethod<[], Promise<{ registryVersion: number; redundancyBuffer: number; nodeCount: number }>>(
      ctx.solana,
      "getRegistrySelectionConfig"
    )(),
    clusterNetwork(ctx.connection),
    readX402Pricing(ctx.connection, programId)
  ]);

  const { signaturesRequired } = opts;
  if (signaturesRequired < pricing.minSigners) {
    throw new Error(`signaturesRequired ${signaturesRequired} is below the protocol min_signers ${pricing.minSigners}`);
  }
  if (signaturesRequired > registry.nodeCount) {
    throw new Error(
      `signaturesRequired ${signaturesRequired} exceeds the ${registry.nodeCount} nodes of registry version ${registry.registryVersion}`
    );
  }

  const priceAtomic = computeX402Price(pricing, signaturesRequired, registry.redundancyBuffer);
  // Refuse an over-cap round before contacting any gateway.
  checkX402PerRoundCap(priceAtomic, ctx.config.x402.maxPriceUsdcAtomic);

  return {
    apiConfig: canonicalizeApiConfig(opts.apiConfig),
    sourceId,
    sourceIdBytes: Buffer.from(sourceId, "hex"),
    signaturesRequired,
    registryVersion: registry.registryVersion,
    network,
    programId,
    pricing,
    priceAtomic
  };
}

interface PreparedPayment {
  endpoint: string;
  required: unknown;
  canonicalTimestamp: number;
  verified: VerifiedPayment;
  accounts: PaymentAccounts;
}

async function preparePayment(
  ctx: AgentRoundContext,
  plan: RoundPlan,
  canonicalTimestamp: number
): Promise<PreparedPayment> {
  const { endpoint, required } = await requestQuote(ctx.config.gatewayEndpoints, executeBody(plan, canonicalTimestamp));
  const authority = await gatewayAuthority(ctx, endpoint);
  const accounts = await readPaymentAccounts(ctx.connection, {
    programId: plan.programId,
    usdcMint: plan.pricing.usdcMint,
    payer: ctx.signer.publicKey,
    authority
  });

  const verified = verifyPaymentRequirements(required, {
    network: plan.network,
    payTo: authority,
    asset: plan.pricing.usdcMint,
    amount: plan.priceAtomic,
    payer: ctx.signer.publicKey,
    memo: x402RoundMemo({
      programId: plan.programId,
      gatewayPda: accounts.gatewayPda,
      sourceId: plan.sourceIdBytes,
      signaturesRequired: plan.signaturesRequired,
      registryVersion: plan.registryVersion,
      canonicalTimestamp
    })
  });
  checkX402SpendCap(verified.amount, ctx.config.x402.maxPriceUsdcAtomic, ctx.config.x402.maxSpendPerDayUsdcAtomic);

  return { endpoint, required, canonicalTimestamp, verified, accounts };
}

async function signPayment(ctx: AgentRoundContext, payment: PreparedPayment): Promise<string> {
  const { verified, accounts } = payment;
  const { blockhash } = await ctx.connection.getLatestBlockhash();
  const transaction = buildPaymentTransaction({
    payer: ctx.signer.publicKey,
    feePayer: verified.feePayer,
    payerAta: accounts.payerAta,
    payToAta: accounts.payToAta,
    mint: verified.asset,
    decimals: accounts.decimals,
    amount: verified.amount,
    memo: verified.memo,
    recentBlockhash: blockhash
  });
  const signed = await signPaymentTransaction(ctx.signer, transaction, verified.feePayer);
  const resource = describedResource(payment.required);

  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      ...(resource ? { resource } : {}),
      accepted: verified.accepted,
      payload: { transaction: Buffer.from(signed.serialize()).toString("base64") }
    })
  ).toString("base64");
}

type PaidOutcome =
  | { kind: "ok"; body: Record<string, unknown>; receipt: Record<string, unknown> | undefined }
  | { kind: "payment_rejected"; status: 402; message: string; required: unknown }
  | { kind: "rejected" | "conflict"; status: number; message: string }
  | { kind: "unknown"; status?: number; message: string };

/**
 * Only 400, 402, and 409 are raised before the gateway asks its facilitator to
 * settle. Any other answer, or none, can follow a settled payment.
 */
async function postPaidExecute(
  endpoint: string,
  body: Record<string, unknown>,
  paymentHeader: string
): Promise<PaidOutcome> {
  let res: Response;
  try {
    res = await postExecute(endpoint, body, paymentHeader);
  } catch (error) {
    return { kind: "unknown", message: errorMessage(error) };
  }

  if (res.status === 200) {
    try {
      return { kind: "ok", body: asRecord(await res.json()) ?? {}, receipt: decodeHeader(res.headers.get("PAYMENT-RESPONSE")) };
    } catch (error) {
      return { kind: "unknown", status: 200, message: `unreadable response: ${errorMessage(error)}` };
    }
  }
  if (res.status === 402) {
    const required = await readPaymentRequired(res);
    const reason = asRecord(required)?.error;
    return { kind: "payment_rejected", status: 402, message: typeof reason === "string" && reason ? reason : "payment rejected", required };
  }

  const message = await readErrorMessage(res);
  if (res.status === 409) {
    return { kind: "conflict", status: 409, message };
  }
  if (res.status === 400) {
    return { kind: "rejected", status: 400, message };
  }
  return { kind: "unknown", status: res.status, message };
}

function paidOutcomeError(
  ctx: AgentRoundContext,
  plan: RoundPlan,
  payment: PreparedPayment,
  outcome: Exclude<PaidOutcome, { kind: "ok" }>
): Error {
  switch (outcome.kind) {
    case "payment_rejected":
      return new X402PaymentRequiredError(`x402 payment rejected by the gateway: ${outcome.message}`, outcome.required);
    case "rejected":
      return Object.assign(new Error(`x402 agent execute rejected: ${outcome.message}`), { status: 400 });
    case "conflict":
      return Object.assign(
        new Error(`x402 round identity still reserved after ${MAX_PAID_ATTEMPTS} paid attempts: ${outcome.message}`),
        { status: 409 }
      );
    case "unknown": {
      const response = outcome.status === undefined ? "no response" : `HTTP ${outcome.status}`;
      return new X402PaymentOutcomeUnknownError(
        `x402 round failed after its payment was sent (${response}: ${outcome.message}); the payment may have settled`,
        {
          endpoint: payment.endpoint,
          payer: ctx.signer.publicKey,
          payTo: payment.verified.payTo,
          asset: payment.verified.asset,
          amountAtomicUsdc: payment.verified.amount.toString(),
          memo: payment.verified.memo,
          sourceId: plan.sourceId,
          canonicalTimestamp: payment.canonicalTimestamp,
          ...(outcome.status !== undefined ? { httpStatus: outcome.status } : {}),
          gatewayMessage: outcome.message
        }
      );
    }
  }
}

function completeRound(
  ctx: AgentRoundContext,
  plan: RoundPlan,
  payment: PreparedPayment,
  outcome: Extract<PaidOutcome, { kind: "ok" }>
): AgentRoundResult {
  const { verified } = payment;
  const transaction = outcome.receipt?.transaction;
  const receipt: X402PaymentReceipt = {
    endpoint: payment.endpoint,
    network: plan.network,
    payer: ctx.signer.publicKey,
    payTo: verified.payTo,
    asset: verified.asset,
    amountAtomicUsdc: verified.amount.toString(),
    feePayer: verified.feePayer,
    memo: verified.memo,
    ...(typeof transaction === "string" && transaction ? { transaction } : {})
  };

  const data = asRecord(outcome.body.data) ?? {};
  const sameRound =
    normalizeSourceId(String(data.sourceId ?? "")) === plan.sourceId &&
    Number(data.timestamp) === payment.canonicalTimestamp &&
    Number(data.registryVersion) === plan.registryVersion &&
    Number(data.signaturesRequired) === plan.signaturesRequired;
  if (!sameRound) {
    // Paid for by now: report the settled payment instead of returning a foreign aggregate.
    throw new Error(
      `the gateway settled x402 payment ${receipt.transaction ?? `(memo ${receipt.memo})`} but returned an aggregate for a different round (sourceId ${String(data.sourceId)}, timestamp ${String(data.timestamp)})`
    );
  }

  return {
    result: {
      sourceId: data.sourceId,
      value: data.value,
      valuePacked: data.valuePacked,
      timestamp: data.timestamp,
      registryVersion: data.registryVersion,
      signaturesRequired: data.signaturesRequired,
      configHash: data.configHash,
      signersBitmap: data.signersBitmap,
      s: data.s,
      commitmentAddr: data.commitmentAddr,
      fresh: data.fresh ?? true
    },
    payment: receipt
  };
}

/** The first endpoint that quotes the round; the paid request goes to that endpoint only. */
async function requestQuote(
  endpoints: string[],
  body: Record<string, unknown>
): Promise<{ endpoint: string; required: unknown }> {
  let lastError = "no gateway endpoint configured";

  for (const endpoint of endpoints) {
    let res: Response;
    try {
      res = await postExecute(endpoint, body);
    } catch (error) {
      lastError = `${endpoint}: ${errorMessage(error)}`;
      continue;
    }
    if (res.status === 402) {
      return { endpoint, required: await readPaymentRequired(res) };
    }
    const message = await readErrorMessage(res);
    if (res.status === 400) {
      // Stale registry version, clock skew, malformed apiConfig: every gateway agrees.
      throw Object.assign(new Error(`x402 agent execute rejected: ${message}`), { status: 400 });
    }
    lastError = `${endpoint}: HTTP ${res.status}: ${message}`;
  }

  throw new Error(`no gateway returned an x402 payment quote (${lastError})`);
}

const discoveredAuthorities = new Map<string, Promise<Address>>();

/** GATEWAY_AUTHORITIES pin for the endpoint, else its `GET /v1/info` (cached per endpoint). */
function gatewayAuthority(ctx: AgentRoundContext, endpoint: string): Promise<Address> {
  const pinned = ctx.config.gatewayAuthorities[ctx.config.gatewayEndpoints.indexOf(endpoint)];
  if (pinned) {
    return Promise.resolve(address(pinned));
  }

  let pending = discoveredAuthorities.get(endpoint);
  if (!pending) {
    pending = requireMethod<[string], Promise<{ gatewayAuthority: string }>>(ctx.gateway, "fetchGatewayInfo")(
      endpoint
    ).then((info) => parseSolanaPubkey(info.gatewayAuthority, `GET ${endpoint}/v1/info gatewayAuthority`));
    pending.catch(() => discoveredAuthorities.delete(endpoint));
    discoveredAuthorities.set(endpoint, pending);
  }
  return pending;
}

const clusterNetworks = new WeakMap<object, Promise<string>>();

/** CAIP-2 id of the SOLANA_RPC cluster: `solana:` + the first 32 chars of its genesis hash. */
function clusterNetwork(connection: Pick<Connection, "getGenesisHash">): Promise<string> {
  let pending = clusterNetworks.get(connection);
  if (!pending) {
    pending = connection.getGenesisHash().then((hash) => `solana:${hash.slice(0, 32)}`);
    pending.catch(() => clusterNetworks.delete(connection));
    clusterNetworks.set(connection, pending);
  }
  return pending;
}

function executeBody(plan: RoundPlan, canonicalTimestamp: number): Record<string, unknown> {
  return {
    canonical_timestamp: canonicalTimestamp,
    signatures_required: plan.signaturesRequired,
    registry_version: plan.registryVersion,
    apiConfig: plan.apiConfig
  };
}

function postExecute(endpoint: string, body: Record<string, unknown>, paymentHeader?: string): Promise<Response> {
  return fetch(`${trimSlash(endpoint)}/v1/agent/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(paymentHeader ? { "PAYMENT-SIGNATURE": paymentHeader } : {})
    },
    body: JSON.stringify(body)
  });
}

/** The PAYMENT-REQUIRED header is canonical; the body carries the same object. */
async function readPaymentRequired(res: Response): Promise<unknown> {
  const fromHeader = decodeHeader(res.headers.get("PAYMENT-REQUIRED"));
  if (fromHeader) {
    return fromHeader;
  }
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function decodeHeader(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

/** The 402's resource description, echoed in the payload; descriptive only. */
function describedResource(required: unknown): Record<string, string> | undefined {
  const resource = asRecord(asRecord(required)?.resource);
  if (typeof resource?.url !== "string") {
    return undefined;
  }
  const out: Record<string, string> = { url: resource.url };
  for (const field of ["description", "mimeType"]) {
    const value = resource[field];
    if (typeof value === "string") out[field] = value;
  }
  return out;
}

function parseFloatStatus(raw: unknown): GatewayFloatStatus {
  const record = asRecord(raw) ?? {};
  const amount = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      throw new Error(`GET /v1/agent/status returned a malformed ${field}`);
    }
    return value;
  };

  return {
    gateway: String(record.gateway ?? ""),
    authority: String(record.authority ?? ""),
    ataAddress: String(record.ataAddress ?? ""),
    ataExists: record.ataExists === true,
    ataBalance: amount("ataBalance"),
    committedAmount: amount("committedAmount"),
    quotedNextPrice: amount("quotedNextPrice"),
    unsettledRounds: Number(record.unsettledRounds ?? 0)
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed.error ?? parsed.message ?? parsed.detail;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {
      // fall back to raw body
    }
    return text;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimSlash(endpoint: string): string {
  return endpoint.replace(/\/$/, "");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

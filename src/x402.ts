/**
 * x402 self-funded pay-per-request client for `POST /v1/agent/execute` and
 * `GET /v1/agent/{payer}/status`. The SDK has no x402 support (it only
 * covers the subscription round path), so this talks to the gateway
 * directly, speaking the escrow-based agent protocol: an on-chain agent
 * escrow the payer funds, plus a signed AgentRequestAuth per round.
 *
 * Gateways on x402 v2 replace that protocol — payment rides in a
 * facilitator-verified `PAYMENT-SIGNATURE` header and status moves to
 * `GET /v1/agent/status` — and reject this client until it is ported.
 */
import { createHash } from "node:crypto";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address, type TransactionSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Transaction, type Connection } from "@solana/web3.js";
import { canonicalizeApiConfig, deriveSourceId } from "./apiconfig.js";
import { getMolphaProgramId, requireMethod } from "./clients.js";
import { type MolphaConfig } from "./config.js";
import {
  checkX402DailySpendCap,
  checkX402PerRoundCap,
  checkX402SpendCap,
  recordX402Spend
} from "./guardrails.js";
import { normalizeSourceId } from "./hex.js";
import { requireSdkExport } from "./sdk.js";
import { toLegacyInstruction, toLegacyPublicKey } from "./solana-compat.js";
import type { MolphaSigner } from "./signer/types.js";

const AGENT_REQAUTH_PREFIX = "MOLPHA_AGENT_REQAUTH_V1";
const MAX_ROUND_ATTEMPTS = 5;

export interface ApiConfigInput {
  url: string;
  method?: "GET" | "POST" | undefined;
  headers?: Record<string, string> | undefined;
  responseParser: string;
  valueTransform?: string | undefined;
}

export interface AgentFetchOptions {
  apiConfig: ApiConfigInput;
  signaturesRequired: number;
  /** When set, must match the sourceId derived from apiConfig. */
  sourceId?: string;
  /** Accepted for API symmetry with the subscription path; x402 rounds always run fresh (the gateway has no maxAge/cache concept for /v1/agent/execute). */
  maxAge?: number;
  dryRun?: boolean;
}

export interface X402Extra {
  agent: string;
  gateway: string;
  sourceId: string;
  canonicalTimestamp: number;
  amount: string;
  payer: string;
  currentAtaBalance: string;
  committedAmount: string;
  note: string;
}

export interface X402Accept {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: X402Extra;
}

interface X402PaymentRequiredBody {
  x402Version: number;
  error: string;
  accepts: X402Accept[];
}

export class X402PaymentRequiredError extends Error {
  readonly status = 402;
  readonly x402: X402PaymentRequiredBody;

  constructor(message: string, x402: X402PaymentRequiredBody) {
    super(message);
    this.name = "X402PaymentRequiredError";
    this.x402 = x402;
  }
}

export interface AgentStatus {
  payer?: string;
  gateway?: string;
  escrow: string;
  exists: boolean;
  authority?: string;
  status?: string;
  ataAddress: string;
  ataExists: boolean;
  ataBalance: string;
  committedAmount: string;
  quotedNextPrice: string;
  unsettledRounds: number;
}

/** In-memory cache of the settling gateway PDA per endpoint — revealed via status or a 402 body. */
const gatewayPdaCache = new Map<string, string>();

/**
 * Escrow PDA: `["molpha_agent", payer, gateway]`.
 * Escrows are per (payer, gateway); the gateway seed is the settling gateway PDA.
 */
export async function deriveAgentEscrow(
  payer: Address,
  gateway: Address,
  programId: Address
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("molpha_agent"), Buffer.from(encoder.encode(payer)), Buffer.from(encoder.encode(gateway))]
  });
  return pda;
}

/** Escrow USDC ATA (associated token account owned by the agent escrow PDA). */
export async function deriveAgentEscrowAta(escrow: Address, usdcMint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: escrow,
    mint: usdcMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  return ata;
}

export interface VerifyX402FundingContext {
  payer: Address;
  programId: Address;
  usdcMint: Address;
  /** When set, 402 `extra.gateway` must match (config pin, status, or prior discovery). */
  knownGateway?: Address | string | undefined;
  maxPriceUsdcAtomic: bigint;
  maxSpendPerDayUsdcAtomic: bigint;
}

export interface VerifiedX402Funding {
  gateway: Address;
  escrow: Address;
  escrowAta: Address;
  usdcMint: Address;
  fundAmount: bigint;
  roundPrice: bigint;
}

/**
 * Treat a 402 `accepts[0]` as untrusted: derive escrow + USDC ATA, pin the mint
 * to on-chain protocol config, and cap the transfer amount before signing.
 */
export async function verifyX402FundingAccept(
  accept: X402Accept,
  ctx: VerifyX402FundingContext
): Promise<VerifiedX402Funding> {
  if (accept.extra.payer !== String(ctx.payer)) {
    throw new Error(
      `x402 402 response payer mismatch: expected ${ctx.payer}, got ${accept.extra.payer}`
    );
  }

  const gateway = address(accept.extra.gateway);
  if (ctx.knownGateway !== undefined && String(ctx.knownGateway) !== String(gateway)) {
    throw new Error(
      `x402 402 response gateway mismatch: expected ${ctx.knownGateway}, got ${gateway}`
    );
  }

  const escrow = await deriveAgentEscrow(ctx.payer, gateway, ctx.programId);
  if (accept.extra.agent !== String(escrow)) {
    throw new Error(
      `x402 402 response agent (escrow) mismatch: expected derived ${escrow}, got ${accept.extra.agent}`
    );
  }

  if (accept.asset !== String(ctx.usdcMint)) {
    throw new Error(
      `x402 402 response asset mismatch: expected protocol USDC mint ${ctx.usdcMint}, got ${accept.asset}`
    );
  }

  const escrowAta = await deriveAgentEscrowAta(escrow, ctx.usdcMint);
  if (accept.payTo !== String(escrowAta)) {
    throw new Error(
      `x402 402 response payTo mismatch: expected derived escrow ATA ${escrowAta}, got ${accept.payTo}`
    );
  }

  const roundPrice = BigInt(accept.extra.amount);
  const fundAmount = BigInt(accept.maxAmountRequired);

  checkX402PerRoundCap(roundPrice, ctx.maxPriceUsdcAtomic);
  if (fundAmount > 0n) {
    checkX402DailySpendCap(fundAmount, ctx.maxSpendPerDayUsdcAtomic);
  }

  if (fundAmount > roundPrice) {
    throw new Error(
      `x402 402 response maxAmountRequired (${fundAmount}) exceeds round price extra.amount (${roundPrice})`
    );
  }

  return {
    gateway,
    escrow,
    escrowAta,
    usdcMint: ctx.usdcMint,
    fundAmount,
    roundPrice
  };
}

/** Advisory status for one payer at this gateway. Escrow is derived server-side. */
export async function fetchAgentStatus(
  config: MolphaConfig,
  payer: Address,
  signaturesRequired: number
): Promise<AgentStatus> {
  const path = `/v1/agent/${payer}/status?signatures_required=${signaturesRequired}`;
  return getFirstReachable<AgentStatus>(config.gatewayEndpoints, path);
}

export interface AgentFetchContext {
  config: MolphaConfig;
  connection: Connection;
  signer: MolphaSigner;
  solana: Record<string, unknown>;
}

export async function agentFetch(
  ctx: AgentFetchContext,
  opts: AgentFetchOptions
): Promise<Record<string, unknown>> {
  const { config, connection, signer, solana } = ctx;
  const payer = signer.publicKey;
  const apiConfig = canonicalizeApiConfig(opts.apiConfig);
  const expectedSourceId = normalizeSourceId(deriveSourceId(opts.apiConfig).sourceId);
  assertSourceIdMatch(expectedSourceId, opts.sourceId);

  const endpointKey = config.gatewayEndpoints[0] ?? "";
  const programId = getMolphaProgramId();
  const { usdcMint: usdcMintRaw } = await requireMethod<
    [],
    Promise<{ usdcMint: Address | string; treasury?: Address | string }>
  >(solana, "fetchProtocolTokens")();
  const usdcMint = address(String(usdcMintRaw));

  const registryVersion = await requireMethod<[], Promise<number>>(solana, "getRegistryVersion")();

  // Status is advisory, so a failure must not abort the round — but it is the
  // only source of the settling gateway PDA when nothing is pinned or cached,
  // so keep the reason around for the error message that needs it.
  let statusError: string | undefined;
  const status = await fetchAgentStatus(config, payer, opts.signaturesRequired).catch(
    (error: unknown) => {
      statusError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  );
  let gatewayPda =
    config.x402.gatewayPda ?? gatewayPdaCache.get(endpointKey) ?? status?.gateway ?? undefined;
  if (gatewayPda) cacheGatewayPda(endpointKey, gatewayPda);
  let priceAtomic = status ? BigInt(status.quotedNextPrice) : undefined;
  let availableAtomic = status
    ? bigIntMax(0n, BigInt(status.ataBalance) - BigInt(status.committedAmount))
    : 0n;
  let escrowStr =
    gatewayPda !== undefined
      ? String(await deriveAgentEscrow(payer, address(gatewayPda), programId))
      : "";

  const fundingVerifyCtx = (knownGateway: string | undefined): VerifyX402FundingContext => ({
    payer,
    programId,
    usdcMint,
    knownGateway,
    maxPriceUsdcAtomic: config.x402.maxPriceUsdcAtomic,
    maxSpendPerDayUsdcAtomic: config.x402.maxSpendPerDayUsdcAtomic
  });

  if (opts.dryRun) {
    if (priceAtomic === undefined || gatewayPda === undefined) {
      const discovery = await discover(config, {
        payer,
        apiConfig,
        signaturesRequired: opts.signaturesRequired,
        registryVersion,
        timestamp: Math.floor(Date.now() / 1000)
      });
      if (discovery.kind === "already_funded") {
        // The escrow covers the round; the 400 quote carries no addresses, so
        // report whatever the pinned/cached gateway PDA can still derive.
        const escrow = gatewayPda
          ? String(await deriveAgentEscrow(payer, address(gatewayPda), programId))
          : "unknown";
        const ata =
          escrow !== "unknown"
            ? String(await deriveAgentEscrowAta(address(escrow), usdcMint))
            : "unknown";
        checkX402PerRoundCap(discovery.roundPrice, config.x402.maxPriceUsdcAtomic);
        return dryRunPreview(expectedSourceId, escrow, ata, discovery.roundPrice, discovery.roundPrice);
      }

      const verified = await verifyX402FundingAccept(discovery.accept, fundingVerifyCtx(gatewayPda));
      assertSourceIdMatch(expectedSourceId, discovery.accept.extra.sourceId);
      cacheGatewayPda(endpointKey, String(verified.gateway));
      availableAtomic = bigIntMax(
        0n,
        BigInt(discovery.accept.extra.currentAtaBalance) -
          BigInt(discovery.accept.extra.committedAmount)
      );
      return dryRunPreview(
        expectedSourceId,
        String(verified.escrow),
        String(verified.escrowAta),
        verified.roundPrice,
        availableAtomic
      );
    }

    const escrowAta =
      escrowStr !== ""
        ? String(await deriveAgentEscrowAta(address(escrowStr), usdcMint))
        : (status?.ataAddress ?? "unknown");

    return dryRunPreview(
      expectedSourceId,
      escrowStr || "unknown",
      escrowAta,
      priceAtomic,
      availableAtomic
    );
  }

  let timestamp = Math.floor(Date.now() / 1000);
  let sourceIdHex = expectedSourceId;
  let lastPaymentRequired: X402PaymentRequiredBody | undefined;
  let walletSpendRecordedForRound = false;

  for (let attempt = 0; attempt < MAX_ROUND_ATTEMPTS; attempt++) {
    const needsQuoteOrFunding = priceAtomic === undefined || availableAtomic < priceAtomic;
    const needsGateway = gatewayPda === undefined;

    if (needsQuoteOrFunding || needsGateway) {
      // Unsigned discovery (amount: 0) only works while underfunded. If the
      // escrow already covers the quoted price but we lack the gateway PDA,
      // refresh status instead — a funded amount:0 request returns 400.
      if (!needsQuoteOrFunding && needsGateway) {
        const refreshed = await fetchAgentStatus(config, payer, opts.signaturesRequired).catch(
          () => undefined
        );
        if (!refreshed?.gateway) {
          throw new Error(gatewayPdaUnknownMessage(statusError));
        }
        gatewayPda = refreshed.gateway;
        cacheGatewayPda(endpointKey, gatewayPda);
        escrowStr = String(await deriveAgentEscrow(payer, address(gatewayPda), programId));
        priceAtomic = BigInt(refreshed.quotedNextPrice);
        availableAtomic = bigIntMax(
          0n,
          BigInt(refreshed.ataBalance) - BigInt(refreshed.committedAmount)
        );
      } else {
        timestamp = Math.floor(Date.now() / 1000);
        const discovery = await discover(config, {
          payer,
          apiConfig,
          signaturesRequired: opts.signaturesRequired,
          registryVersion,
          timestamp
        });

        if (discovery.kind === "already_funded") {
          // Status was unavailable so we assumed an empty escrow, but the
          // gateway says it is funded. Nothing to fund — take the quote and
          // sign, provided the gateway PDA is known from a pin or the cache.
          if (!gatewayPda) {
            throw new Error(gatewayPdaUnknownMessage(statusError));
          }
          priceAtomic = discovery.roundPrice;
          availableAtomic = discovery.roundPrice;
          escrowStr = String(await deriveAgentEscrow(payer, address(gatewayPda), programId));
          sourceIdHex = expectedSourceId;
        } else {
          const verified = await verifyX402FundingAccept(discovery.accept, fundingVerifyCtx(gatewayPda));
          assertSourceIdMatch(expectedSourceId, discovery.accept.extra.sourceId);
          gatewayPda = String(verified.gateway);
          cacheGatewayPda(endpointKey, gatewayPda);
          priceAtomic = verified.roundPrice;

          if (verified.fundAmount > 0n) {
            await fundEscrow(connection, signer, {
              mint: verified.usdcMint,
              escrow: verified.escrow,
              escrowAta: verified.escrowAta,
              amountAtomic: verified.fundAmount
            });
            recordX402Spend(verified.fundAmount);
            walletSpendRecordedForRound = true;
          }

          timestamp = discovery.accept.extra.canonicalTimestamp;
          sourceIdHex = expectedSourceId;
          escrowStr = String(verified.escrow);
          availableAtomic = priceAtomic;
        }
      }
    }

    if (!gatewayPda || !escrowStr || priceAtomic === undefined) {
      throw new Error("x402 agent execute missing gateway PDA, escrow, or round price after discovery");
    }

    if (walletSpendRecordedForRound) {
      checkX402PerRoundCap(priceAtomic, config.x402.maxPriceUsdcAtomic);
    } else {
      checkX402SpendCap(
        priceAtomic,
        config.x402.maxPriceUsdcAtomic,
        config.x402.maxSpendPerDayUsdcAtomic
      );
    }

    const sig = await signAgentRequestAuth(signer, {
      agent: address(escrowStr),
      gateway: address(gatewayPda),
      sourceId: hexToBytesLocal(sourceIdHex),
      canonicalTimestamp: timestamp,
      amount: priceAtomic
    });

    const outcome = await postAgentExecute(config.gatewayEndpoints, {
      payer,
      canonical_timestamp: timestamp,
      signatures_required: opts.signaturesRequired,
      amount: Number(priceAtomic),
      registry_version: registryVersion,
      agent_request_auth_sig: bytesToHex0xLocal(sig),
      apiConfig
    });

    if (outcome.kind === "ok") {
      return mapAgentResponse(outcome.body);
    }

    if (outcome.kind === "payment_required") {
      lastPaymentRequired = outcome.body;
      const accept = outcome.body.accepts[0];
      if (accept?.extra.gateway) {
        if (gatewayPda !== undefined && accept.extra.gateway !== gatewayPda) {
          throw new Error(
            `x402 402 response gateway mismatch: expected ${gatewayPda}, got ${accept.extra.gateway}`
          );
        }
        gatewayPda = accept.extra.gateway;
        cacheGatewayPda(endpointKey, gatewayPda);
        escrowStr = String(await deriveAgentEscrow(payer, address(gatewayPda), programId));
      }
      priceAtomic = undefined;
      availableAtomic = 0n;
      continue;
    }

    if (outcome.kind === "amount_mismatch") {
      // Price moved between the quote and the signed request. The rejection
      // carries the current price, so re-sign against it directly; only fall
      // back to status when the gateway did not name one.
      if (outcome.quotedPrice !== undefined) {
        priceAtomic = outcome.quotedPrice;
        availableAtomic = outcome.quotedPrice;
        timestamp = Math.floor(Date.now() / 1000);
        continue;
      }

      const refreshed = await fetchAgentStatus(config, payer, opts.signaturesRequired).catch(
        () => undefined
      );
      if (refreshed) {
        priceAtomic = BigInt(refreshed.quotedNextPrice);
        availableAtomic = bigIntMax(
          0n,
          BigInt(refreshed.ataBalance) - BigInt(refreshed.committedAmount)
        );
        if (refreshed.gateway) {
          gatewayPda = refreshed.gateway;
          cacheGatewayPda(endpointKey, gatewayPda);
        }
        if (gatewayPda) {
          escrowStr = String(await deriveAgentEscrow(payer, address(gatewayPda), programId));
        }
        timestamp = Math.floor(Date.now() / 1000);
        continue;
      }
      priceAtomic = undefined;
      availableAtomic = 0n;
      continue;
    }

    if (outcome.kind === "bad_request") {
      // Stale registry version, clock skew, malformed apiConfig — none of
      // these are fixed by retrying the same request.
      throw new Error(`x402 agent execute rejected: ${outcome.message}`);
    }

    if (outcome.kind === "conflict") {
      // canonical_timestamp already reserved — bump and re-sign.
      timestamp += 1;
      continue;
    }

    if (outcome.kind === "unavailable") {
      timestamp = Math.floor(Date.now() / 1000);
      continue;
    }

    throw new Error(`x402 agent execute failed: ${outcome.message}`);
  }

  if (lastPaymentRequired) {
    throw new X402PaymentRequiredError(
      lastPaymentRequired.error || "payment required: escrow ATA underfunded after retries",
      lastPaymentRequired
    );
  }

  throw new Error("x402 agent round failed after retries (payment/timestamp conflicts did not resolve)");
}

function dryRunPreview(
  sourceId: string,
  escrow: string,
  ata: string,
  priceAtomic: bigint,
  availableAtomic: bigint
): Record<string, unknown> {
  const shortfall = bigIntMax(0n, priceAtomic - availableAtomic);
  return {
    dryRun: true,
    action: "x402_agent_execute",
    sourceId,
    escrow,
    ata,
    priceAtomicUsdc: priceAtomic.toString(),
    availableAtomicUsdc: availableAtomic.toString(),
    shortfallAtomicUsdc: shortfall.toString(),
    note:
      shortfall > 0n
        ? "Escrow is underfunded for this round; a live call would fund the ATA before requesting data."
        : "Escrow already covers this round's price; a live call would request data immediately."
  };
}

function gatewayPdaUnknownMessage(statusError: string | undefined): string {
  return [
    "x402 escrow appears funded but the settling gateway PDA is unknown; set MOLPHA_X402_GATEWAY_PDA or ensure GET /v1/agent/{payer}/status returns gateway.",
    statusError ? ` (status lookup failed: ${statusError})` : ""
  ].join("");
}

function assertSourceIdMatch(expected: string, provided: string | undefined): void {
  if (provided === undefined) return;
  if (normalizeSourceId(provided) !== normalizeSourceId(expected)) {
    throw new Error(`sourceId does not match apiConfig: expected ${expected}, got ${provided}`);
  }
}

function hexToBytesLocal(hex: string): Uint8Array {
  return requireSdkExport<(hex: string) => Uint8Array>("hexToBytes")(hex);
}

function bytesToHex0xLocal(bytes: Uint8Array): string {
  return requireSdkExport<(bytes: Uint8Array) => string>("bytesToHex0x")(bytes);
}

function u64le(value: number | bigint): Uint8Array {
  return requireSdkExport<(value: number | bigint) => Uint8Array>("u64le")(value);
}

export interface AgentRequestAuthParams {
  agent: Address;
  gateway: Address;
  sourceId: Uint8Array;
  canonicalTimestamp: number;
  amount: bigint;
}

/**
 * `sha256("MOLPHA_AGENT_REQAUTH_V1" || agent(32) || gateway(32) || sourceId(32) || canonicalTimestamp_le(8) || amount_le(8))`
 * — the escrow protocol's per-round authorization (see the module note).
 */
export function agentRequestAuthMessage(params: AgentRequestAuthParams): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const borsh = Buffer.concat([
    Buffer.from(addressEncoder.encode(params.agent)),
    Buffer.from(addressEncoder.encode(params.gateway)),
    Buffer.from(params.sourceId),
    Buffer.from(u64le(params.canonicalTimestamp)),
    Buffer.from(u64le(params.amount))
  ]);
  return new Uint8Array(
    createHash("sha256").update(Buffer.concat([Buffer.from(AGENT_REQAUTH_PREFIX, "utf8"), borsh])).digest()
  );
}

async function signAgentRequestAuth(signer: MolphaSigner, params: AgentRequestAuthParams): Promise<Uint8Array> {
  return signer.signMessage(agentRequestAuthMessage(params));
}

function addressSigner<T extends string>(addr: Address<T>): TransactionSigner<T> {
  // Only `.address` is read when Codama builds the instruction meta — actual
  // signing goes through MolphaSigner.signTransaction, never through Kit.
  return { address: addr } as unknown as TransactionSigner<T>;
}

/**
 * Build + send the escrow ATA create/transfer. Callers must pass addresses and
 * amounts already verified by {@link verifyX402FundingAccept} — never raw 402 fields.
 */
async function fundEscrow(
  connection: Connection,
  signer: MolphaSigner,
  args: { mint: Address; escrow: Address; escrowAta: Address; amountAtomic: bigint }
): Promise<string> {
  const [payerAta] = await findAssociatedTokenPda({
    owner: signer.publicKey,
    mint: args.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });

  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    payer: addressSigner(signer.publicKey),
    ata: args.escrowAta,
    owner: args.escrow,
    mint: args.mint
  });
  const transferIx = getTransferInstruction({
    source: payerAta,
    destination: args.escrowAta,
    authority: addressSigner(signer.publicKey),
    amount: args.amountAtomic
  });

  const tx = new Transaction().add(toLegacyInstruction(createAtaIx), toLegacyInstruction(transferIx));
  tx.feePayer = toLegacyPublicKey(signer.publicKey);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const signed = await signer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

interface DiscoverArgs {
  payer: Address;
  apiConfig: Record<string, unknown>;
  signaturesRequired: number;
  registryVersion: number;
  timestamp: number;
}

/**
 * The gateway checks funding before the amount lock, so an unsigned `amount: 0`
 * probe only yields a 402 quote while the escrow is underfunded. Once it is
 * funded the same probe falls through to the amount lock and comes back as a
 * 400 that still carries the round price — which is a quote, not a failure.
 */
type DiscoveryOutcome =
  | { kind: "quote"; accept: X402Accept }
  | { kind: "already_funded"; roundPrice: bigint };

async function discover(config: MolphaConfig, args: DiscoverArgs): Promise<DiscoveryOutcome> {
  const outcome = await postAgentExecute(config.gatewayEndpoints, {
    payer: args.payer,
    canonical_timestamp: args.timestamp,
    signatures_required: args.signaturesRequired,
    amount: 0,
    registry_version: args.registryVersion,
    apiConfig: args.apiConfig
  });

  if (outcome.kind === "amount_mismatch" && outcome.quotedPrice !== undefined) {
    return { kind: "already_funded", roundPrice: outcome.quotedPrice };
  }

  if (outcome.kind !== "payment_required") {
    throw new Error(
      `unsigned discovery request failed (expected a 402 quote), got ${outcome.kind}: ${
        "message" in outcome ? outcome.message : ""
      }`
    );
  }

  const accept = outcome.body.accepts[0];
  if (!accept) {
    throw new Error("gateway 402 response is missing accepts[0]");
  }

  return { kind: "quote", accept };
}

type PostOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "payment_required"; body: X402PaymentRequiredBody }
  | { kind: "amount_mismatch"; message: string; quotedPrice?: bigint }
  | { kind: "bad_request"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

/**
 * The gateway returns 400 for several unrelated validation failures
 * (`amount`, `registry_version`, `canonical_timestamp`, …). Only the amount
 * lock is retryable by re-quoting; treating every 400 as an amount mismatch
 * hid stale-registry and clock-skew errors behind five pointless retries.
 */
function classifyBadRequest(message: string): PostOutcome {
  if (!/^amount:/.test(message)) {
    return { kind: "bad_request", message };
  }
  const quoted = /round price (\d+)/.exec(message);
  return quoted
    ? { kind: "amount_mismatch", message, quotedPrice: BigInt(quoted[1]!) }
    : { kind: "amount_mismatch", message };
}

async function postAgentExecute(endpoints: string[], body: Record<string, unknown>): Promise<PostOutcome> {
  let lastError: PostOutcome = { kind: "error", message: "no reachable gateway endpoint" };

  for (const endpoint of endpoints) {
    let res: Response;
    try {
      res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/agent/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      lastError = { kind: "unavailable", message: error instanceof Error ? error.message : String(error) };
      continue;
    }

    if (res.status === 200) {
      return { kind: "ok", body: (await res.json()) as Record<string, unknown> };
    }
    if (res.status === 402) {
      return { kind: "payment_required", body: (await res.json()) as X402PaymentRequiredBody };
    }
    if (res.status === 400) {
      return classifyBadRequest(await readErrorMessage(res));
    }
    if (res.status === 401) {
      return { kind: "unauthorized", message: await readErrorMessage(res) };
    }
    if (res.status === 409) {
      return { kind: "conflict", message: await readErrorMessage(res) };
    }
    if (res.status === 503) {
      lastError = { kind: "unavailable", message: await readErrorMessage(res) };
      continue;
    }

    return { kind: "error", message: await readErrorMessage(res) };
  }

  return lastError;
}

async function getFirstReachable<T>(endpoints: string[], path: string): Promise<T> {
  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, { method: "GET" });
      if (res.ok) {
        return (await res.json()) as T;
      }
      lastError = new Error(`GET ${path} failed (${res.status})`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
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

function mapAgentResponse(body: Record<string, unknown>): Record<string, unknown> {
  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    sourceId: data.sourceId,
    value: data.value,
    valuePacked: data.valuePacked,
    timestamp: data.timestamp,
    registryVersion: data.registryVersion,
    signaturesRequired: data.signaturesRequired,
    signersBitmap: data.signersBitmap,
    s: data.s,
    commitmentAddr: data.commitmentAddr,
    fresh: data.fresh ?? true
  };
}

function cacheGatewayPda(endpointKey: string, gatewayPda: string): void {
  gatewayPdaCache.set(endpointKey, gatewayPda);
}

function bigIntMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

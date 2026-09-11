import { BN, BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import { address, type Address } from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Keypair, PublicKey, Transaction, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaProgramId } from "../../src/clients.js";
import { type MolphaConfig } from "../../src/config.js";
import { normalizeError } from "../../src/errors.js";
import { recordX402Spend, resetGuardrailCounters, x402SpentToday } from "../../src/guardrails.js";
import { requireSdkExport } from "../../src/sdk.js";
import { type MolphaSigner } from "../../src/signer/types.js";
import {
  executeAgentRound,
  fetchAgentStatus,
  previewAgentRound,
  X402PaymentOutcomeUnknownError,
  X402PaymentRequiredError,
  type AgentRoundContext
} from "../../src/x402.js";
import {
  computeX402Price,
  deriveGatewayPda,
  verifyPaymentRequirements,
  x402RoundMemo,
  type ExpectedPayment
} from "../../src/x402-payment.js";

const programId = getMolphaProgramId();
const GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SETTLEMENT_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const apiConfig = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" };
const sourceId = requireSdkExport<(config: Record<string, unknown>) => string>("deriveSourceIdString")(apiConfig);
const accountsCoder = new BorshAccountsCoder(requireSdkExport<Idl>("MOLPHA_IDL"));
// x402RoundBase 50_000 + (2 signatures + 1 redundancy) * 5
const PRICE = 50_015n;

const randomAddress = (): Address => address(Keypair.generate().publicKey.toBase58());
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeSigner(keypair: Keypair): MolphaSigner {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };
  return {
    publicKey: address(keypair.publicKey.toBase58()),
    isAvailable: async () => true,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    signMessage: async () => new Uint8Array(64)
  };
}

async function programAccount(name: string, fields: Record<string, unknown>): Promise<AccountInfo<Buffer>> {
  const data = await accountsCoder.encode(name, fields);
  return { data, owner: new PublicKey(programId), lamports: 1, executable: false, rentEpoch: 0 };
}

function tokenProgramAccount(bytes: Uint8Array): AccountInfo<Buffer> {
  return { data: Buffer.from(bytes), owner: new PublicKey(TOKEN_PROGRAM_ADDRESS), lamports: 1, executable: false, rentEpoch: 0 };
}

function usdcAccount(mint: Address, owner: Address, amount: bigint): AccountInfo<Buffer> {
  return tokenProgramAccount(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0,
      closeAuthority: null
    }) as Uint8Array
  );
}

interface FakeGatewayOptions {
  /** Mutates the advertised `accepts[0]`, as an untrusted gateway could. */
  tamper?: (offer: Record<string, unknown>) => void;
  /** Answers the unpaid request with this instead of a 402 quote. */
  quote?: () => Response;
  /** Overrides the answer to the Nth paid request. */
  onPaid?: (attempt: number) => Response | undefined;
  /** Overrides fields of the returned aggregate. */
  data?: Record<string, unknown>;
}

interface Env {
  ctx: AgentRoundContext;
  endpoint: string;
  authority: Address;
  mint: Address;
  feePayer: Address;
  payer: Address;
  payerAta: Address;
  payToAta: Address;
  gatewayPda: Address;
  fetch: ReturnType<typeof vi.fn>;
  connection: {
    getLatestBlockhash: ReturnType<typeof vi.fn>;
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
  };
  quotes: Array<Record<string, unknown>>;
  payments: Array<{ endpoint: string; body: Record<string, unknown>; payload: Record<string, unknown>; tx: VersionedTransaction }>;
  memoFor(canonicalTimestamp: number): string;
}

let endpointCounter = 0;

async function setup(
  options: {
    pinned?: boolean;
    gatewayStatus?: "Active" | "Deactivated" | null;
    payerBalance?: bigint;
    caps?: Partial<MolphaConfig["x402"]>;
    unreachableFirst?: boolean;
    gateway?: FakeGatewayOptions;
  } = {}
): Promise<Env> {
  const { pinned = true, gatewayStatus = "Active", payerBalance = 5_000_000n } = options;
  endpointCounter += 1;
  const endpoint = `http://gateway-${endpointCounter}.test`;
  const unreachable = `http://unreachable-${endpointCounter}.test`;
  const payerKeypair = Keypair.generate();
  const signer = makeSigner(payerKeypair);
  const payer = signer.publicKey;
  const authority = randomAddress();
  const mint = randomAddress();
  const feePayer = randomAddress();
  const gatewayPda = await deriveGatewayPda(authority, programId);
  const [payerAta] = await findAssociatedTokenPda({ owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [payToAta] = await findAssociatedTokenPda({ owner: authority, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(
    requireSdkExport<(program: string) => string>("protocolConfigPda")(programId),
    await programAccount("ProtocolConfig", {
      authority: new PublicKey(randomAddress()),
      usdc_mint: new PublicKey(mint),
      reward_per_signature: new BN(5),
      max_settlement_delay_seconds: new BN(300),
      dispute_window_slots: new BN(100),
      gateway_bond_min: new BN(1),
      challenger_bounty_bps: 100,
      minimum_node_deposit: new BN(1),
      withdrawal_cooldown_slots: new BN(1),
      liveliness_freeze_threshold: 3,
      x402_round_base: new BN(50_000),
      reward_liability: new BN(0),
      min_signers: 2,
      bump: 255
    })
  );
  accounts.set(
    mint,
    tokenProgramAccount(
      getMintEncoder().encode({ mintAuthority: null, supply: 1_000_000_000n, decimals: 6, isInitialized: true, freezeAuthority: null }) as Uint8Array
    )
  );
  if (gatewayStatus) {
    accounts.set(
      gatewayPda,
      await programAccount("Gateway", {
        authority: new PublicKey(authority),
        ip: [127, 0, 0, 1],
        port: 8080,
        status: { [gatewayStatus]: {} },
        registered_at: new BN(1),
        withdrawable_slot: new BN(0),
        bump: 255
      })
    );
  }
  accounts.set(payToAta, usdcAccount(mint, authority, 1_000_000n));
  accounts.set(payerAta, usdcAccount(mint, payer, payerBalance));

  const connection = {
    getGenesisHash: vi.fn(async () => GENESIS_HASH),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
    getAccountInfo: vi.fn(async (key: PublicKey) => accounts.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null))
  };

  const memoFor = (canonicalTimestamp: number): string =>
    x402RoundMemo({
      programId,
      gatewayPda,
      sourceId: Buffer.from(sourceId, "hex"),
      signaturesRequired: 2,
      registryVersion: 3,
      canonicalTimestamp
    });

  const quotes: Env["quotes"] = [];
  const payments: Env["payments"] = [];
  const gw = options.gateway ?? {};
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith(unreachable)) throw new TypeError("fetch failed");
    expect(href).toBe(`${endpoint}/v1/agent/execute`);

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // What the gateway's service advertises for this body.
    const requirements = {
      scheme: "exact",
      network: NETWORK,
      amount: String(PRICE),
      asset: mint,
      payTo: authority,
      maxTimeoutSeconds: 60,
      extra: { feePayer, memo: memoFor(body.canonical_timestamp as number) }
    };
    const paymentHeader = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];

    if (!paymentHeader) {
      quotes.push(body);
      if (gw.quote) return gw.quote();
      const offer: Record<string, unknown> = structuredClone(requirements);
      gw.tamper?.(offer);
      const required = {
        x402Version: 2,
        resource: { url: `${endpoint}/v1/agent/execute`, description: "Molpha oracle round", mimeType: "application/json" },
        accepts: [offer]
      };
      return jsonResponse(402, required, { "PAYMENT-REQUIRED": b64(required) });
    }

    const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as Record<string, unknown>;
    const tx = VersionedTransaction.deserialize(
      Buffer.from((payload.payload as { transaction: string }).transaction, "base64")
    );
    payments.push({ endpoint, body, payload, tx });
    const override = gw.onPaid?.(payments.length);
    if (override) return override;

    // payment.Decode: the echoed requirements must equal the server's exactly.
    expect(payload.accepted).toEqual(requirements);
    return jsonResponse(
      200,
      {
        status: "completed",
        data: {
          sourceId,
          value: "42",
          valuePacked: "ab".repeat(32),
          timestamp: body.canonical_timestamp,
          registryVersion: body.registry_version,
          signaturesRequired: body.signatures_required,
          configHash: sourceId,
          signersBitmap: "3",
          s: "11".repeat(32),
          commitmentAddr: "22".repeat(20),
          fresh: true,
          ...gw.data
        }
      },
      { "PAYMENT-RESPONSE": b64({ success: true, transaction: SETTLEMENT_TX, network: NETWORK, payer }) }
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const endpoints = options.unreachableFirst ? [unreachable, endpoint] : [endpoint];
  const config: MolphaConfig = {
    gatewayEndpoints: endpoints,
    gatewayAuthorities: endpoints.map((url) => (pinned && url === endpoint ? authority : undefined)),
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: [],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: { maxPriceUsdcAtomic: 1_000_000n, maxSpendPerDayUsdcAtomic: 10_000_000n, ...options.caps }
  };

  const ctx: AgentRoundContext = {
    config,
    connection: connection as unknown as AgentRoundContext["connection"],
    signer,
    solana: { getRegistrySelectionConfig: async () => ({ registryVersion: 3, redundancyBuffer: 1, nodeCount: 3 }) },
    gateway: { fetchGatewayInfo: vi.fn(async () => ({ gatewayAuthority: authority })) }
  };

  return {
    ctx,
    endpoint,
    authority,
    mint,
    feePayer,
    payer,
    payerAta,
    payToAta,
    gatewayPda,
    fetch: fetchMock,
    connection,
    quotes,
    payments,
    memoFor
  };
}

const round = { apiConfig, signaturesRequired: 2 };

beforeEach(() => {
  resetGuardrailCounters();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("x402RoundMemo", () => {
  it("matches the memo the gateway advertises for its service-test fixture", async () => {
    // gateway internal/gateway/features/agentexec/service_test.go newFixture:
    // authority PublicKey{4}, apiConfig {url: https://example.com, method: GET},
    // quorum 2, registry version 3, canonical timestamp 1750000000.
    const fixtureSourceId = requireSdkExport<(config: Record<string, unknown>) => string>("deriveSourceIdString")({
      url: "https://example.com",
      method: "GET",
      responseParser: ""
    });
    expect(fixtureSourceId).toBe("0b3212de6506ecfabafe4ae5ab26a542b2503f41d88d599dc4cb28d08cab41a3");
    const gatewayPda = await deriveGatewayPda(address("GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeP"), programId);
    expect(gatewayPda).toBe("H6DDMmWivXh8GdBaxwsZQbwWXwKwPSx3SdmSyJV24yXd");

    expect(
      x402RoundMemo({
        programId,
        gatewayPda,
        sourceId: Buffer.from(fixtureSourceId, "hex"),
        signaturesRequired: 2,
        registryVersion: 3,
        canonicalTimestamp: 1_750_000_000
      })
    ).toBe("6346778bff94f910fb6a562731fb07a7183098b4675e7e267d46859390bcb719");
  });

  it("commits to the gateway, source, quorum, registry version, and timestamp", () => {
    const base = {
      programId,
      gatewayPda: randomAddress(),
      sourceId: Buffer.from(sourceId, "hex"),
      signaturesRequired: 2,
      registryVersion: 3,
      canonicalTimestamp: 1_750_000_000
    };
    const memos = [
      base,
      { ...base, gatewayPda: randomAddress() },
      { ...base, sourceId: Buffer.alloc(32, 1) },
      { ...base, signaturesRequired: 3 },
      { ...base, registryVersion: 4 },
      { ...base, canonicalTimestamp: 1_750_000_001 }
    ].map(x402RoundMemo);
    expect(new Set(memos).size).toBe(memos.length);
  });
});

describe("computeX402Price", () => {
  it("funds the whole selection, as settle_x402_round and the gateway quote do", () => {
    // gateway service_test.go: base 1000, reward 10, quorum 2, redundancy 1 → "1030".
    expect(computeX402Price({ x402RoundBase: 1000n, rewardPerSignature: 10n }, 2, 1)).toBe(1030n);
  });
});

describe("verifyPaymentRequirements", () => {
  const payer = randomAddress();
  const expected: ExpectedPayment = {
    network: NETWORK,
    payTo: randomAddress(),
    asset: randomAddress(),
    amount: 1030n,
    memo: "ab".repeat(32),
    payer
  };
  const feePayer = randomAddress();
  const offer = (): Record<string, unknown> => ({
    scheme: "exact",
    network: NETWORK,
    amount: "1030",
    asset: expected.asset,
    payTo: expected.payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer, memo: expected.memo }
  });
  const required = (mutate: (offer: Record<string, unknown>) => void = () => {}) => {
    const entry = offer();
    mutate(entry);
    return { x402Version: 2, resource: { url: "/v1/agent/execute" }, accepts: [entry] };
  };

  it("accepts the protocol payment and echoes the offer unchanged", () => {
    const verified = verifyPaymentRequirements(required(), expected);
    expect(verified.accepted).toEqual(offer());
    expect(verified.feePayer).toBe(feePayer);
    expect(verified.amount).toBe(1030n);
  });

  it.each<[string, (entry: Record<string, unknown>) => void, RegExp]>([
    ["another network", (entry) => (entry.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /no "exact" payment on/],
    ["another scheme", (entry) => (entry.scheme = "upto"), /no "exact" payment on/],
    ["another payTo", (entry) => (entry.payTo = randomAddress()), /payTo mismatch/],
    ["another asset", (entry) => (entry.asset = randomAddress()), /asset mismatch/],
    ["a higher amount", (entry) => (entry.amount = "1031"), /amount mismatch/],
    ["a lower amount", (entry) => (entry.amount = "1029"), /amount mismatch/],
    ["a non-decimal amount", (entry) => (entry.amount = "0x406"), /amount mismatch/],
    ["another round's memo", (entry) => (entry.extra = { feePayer, memo: "cd".repeat(32) }), /extra\.memo mismatch/],
    ["the signer as fee payer", (entry) => (entry.extra = { feePayer: payer, memo: expected.memo }), /must sponsor the fee/],
    ["no fee payer", (entry) => (entry.extra = { memo: expected.memo }), /extra\.feePayer is not a Solana address/],
    ["a non-string extra", (entry) => (entry.extra = { feePayer, memo: expected.memo, n: 1 }), /malformed extra/],
    ["no timeout", (entry) => delete entry.maxTimeoutSeconds, /malformed maxTimeoutSeconds/]
  ])("rejects %s", (_label, mutate, error) => {
    expect(() => verifyPaymentRequirements(required(mutate), expected)).toThrow(error);
  });

  it("rejects any x402Version other than 2", () => {
    expect(() => verifyPaymentRequirements({ ...required(), x402Version: 1 }, expected)).toThrow(/unsupported x402Version/);
    expect(() => verifyPaymentRequirements(undefined, expected)).toThrow(/unsupported x402Version/);
  });
});

describe("executeAgentRound", () => {
  it("pays the verified quote with an exact-SVM transfer and returns the round with its receipt", async () => {
    const env = await setup();

    const { result, payment } = await executeAgentRound(env.ctx, round);

    expect(result).toMatchObject({ sourceId, value: "42", configHash: sourceId, registryVersion: 3, signaturesRequired: 2 });
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
    const [paid] = env.payments;
    const timestamp = env.quotes[0]!.canonical_timestamp as number;
    expect(paid!.body).toEqual(env.quotes[0]);
    expect(env.quotes[0]).toMatchObject({ signatures_required: 2, registry_version: 3 });
    expect(payment).toEqual({
      endpoint: env.endpoint,
      network: NETWORK,
      payer: env.payer,
      payTo: env.authority,
      asset: env.mint,
      amountAtomicUsdc: String(PRICE),
      feePayer: env.feePayer,
      memo: env.memoFor(timestamp),
      transaction: SETTLEMENT_TX
    });
    expect(paid!.payload).toMatchObject({ x402Version: 2, resource: { url: `${env.endpoint}/v1/agent/execute` } });

    // The facilitator's exact-SVM checks: v0, it pays the fee and has not signed yet,
    // only it and the payer sign, and the layout is limit, price, TransferChecked, memo.
    const { tx } = paid!;
    const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    expect(tx.version).toBe(0);
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(keys.slice(0, 2)).toEqual([env.feePayer, env.payer]);
    expect(tx.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    expect(tx.signatures[1]!.some((byte) => byte !== 0)).toBe(true);

    const instructions = tx.message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex],
      accounts: ix.accountKeyIndexes.map((index) => keys[index]),
      data: Buffer.from(ix.data)
    }));
    expect(instructions.map((ix) => ix.program)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN_PROGRAM_ADDRESS, MEMO_PROGRAM]);
    expect(instructions[0]!.data[0]).toBe(2);
    expect(instructions[1]!.data[0]).toBe(3);
    expect(instructions[1]!.data.readBigUInt64LE(1)).toBeLessThanOrEqual(5_000_000n);
    const transfer = instructions[2]!;
    expect(transfer.data[0]).toBe(12); // TransferChecked
    expect(transfer.data.readBigUInt64LE(1)).toBe(PRICE);
    expect(transfer.data[9]).toBe(6);
    expect(transfer.accounts).toEqual([env.payerAta, env.mint, env.payToAta, env.payer]);
    expect(instructions[3]!.accounts).toEqual([]);
    expect(instructions[3]!.data.toString("utf8")).toBe(env.memoFor(timestamp));

    expect(x402SpentToday()).toBe(PRICE);
  });

  it("discovers an unpinned gateway authority and pays it once its Gateway account is Active", async () => {
    const env = await setup({ pinned: false });

    await executeAgentRound(env.ctx, round);

    expect(env.ctx.gateway.fetchGatewayInfo).toHaveBeenCalledWith(env.endpoint);
    expect(env.payments).toHaveLength(1);
  });

  it.each([
    ["unregistered", null, /no registered Molpha gateway/],
    ["deactivated", "Deactivated", /not an Active gateway/]
  ] as const)("refuses to pay an unpinned %s gateway authority", async (_label, gatewayStatus, error) => {
    const env = await setup({ pinned: false, gatewayStatus });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(error);
    expect(env.payments).toHaveLength(0);
  });

  it.each<[string, (offer: Record<string, unknown>) => void, RegExp]>([
    ["a payTo other than the pinned authority", (offer) => (offer.payTo = randomAddress()), /payTo mismatch/],
    ["another asset", (offer) => (offer.asset = randomAddress()), /asset mismatch/],
    ["a price above the protocol price", (offer) => (offer.amount = String(PRICE + 1n)), /amount mismatch/],
    ["another network", (offer) => (offer.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /no "exact" payment/],
    [
      "a memo for another round",
      (offer) => ((offer.extra as Record<string, string>).memo = "cd".repeat(32)),
      /extra\.memo mismatch/
    ]
  ])("signs nothing for a 402 with %s", async (_label, tamper, error) => {
    const env = await setup({ gateway: { tamper } });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(error);
    expect(env.payments).toHaveLength(0);
    expect(env.connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(x402SpentToday()).toBe(0n);
  });

  it("refuses a round above the per-round cap before contacting any gateway", async () => {
    const env = await setup({ caps: { maxPriceUsdcAtomic: PRICE - 1n } });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(/per-round price cap reached/);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("refuses once the daily spend cap is used up", async () => {
    recordX402Spend(10_000_000n);
    const env = await setup();

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(/daily spend cap reached/);
    expect(env.payments).toHaveLength(0);
  });

  it("refuses a quorum below the protocol min_signers before contacting any gateway", async () => {
    const env = await setup();

    await expect(executeAgentRound(env.ctx, { apiConfig, signaturesRequired: 1 })).rejects.toThrow(/min_signers 2/);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("refuses before signing when the signer's USDC does not cover the round", async () => {
    const env = await setup({ payerBalance: PRICE - 1n });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(/insufficient USDC/);
    expect(env.payments).toHaveLength(0);
    expect(x402SpentToday()).toBe(0n);
  });

  it("does not pay again when the gateway rejects the payment", async () => {
    const env = await setup({
      gateway: {
        onPaid: () => jsonResponse(402, { x402Version: 2, error: "invalid payment: facilitator rejected payment", accepts: [] })
      }
    });

    const error = await executeAgentRound(env.ctx, round).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(X402PaymentRequiredError);
    expect((error as Error).message).toMatch(/facilitator rejected payment/);
    expect(env.payments).toHaveLength(1);
    // A signed transfer is counted whether or not the round completed.
    expect(x402SpentToday()).toBe(PRICE);
  });

  it("re-quotes with a new timestamp and pays again when the round identity is taken (409)", async () => {
    const env = await setup({
      gateway: { onPaid: (attempt) => (attempt === 1 ? jsonResponse(409, { error: "round or payment already reserved" }) : undefined) }
    });

    const { payment } = await executeAgentRound(env.ctx, round);

    expect(env.quotes).toHaveLength(2);
    expect(env.payments).toHaveLength(2);
    const [first, second] = env.quotes.map((quote) => quote.canonical_timestamp as number);
    expect(second).toBeGreaterThan(first!);
    expect(payment.memo).toBe(env.memoFor(second!));
    expect(x402SpentToday()).toBe(PRICE * 2n);
  });

  it("reports an unknown payment outcome and never retries after a 503", async () => {
    const env = await setup({
      gateway: {
        onPaid: () => jsonResponse(503, { error: "payment settlement not confirmed; retain payment proof for reconciliation" })
      }
    });

    const error = await executeAgentRound(env.ctx, round).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(X402PaymentOutcomeUnknownError);
    const reconciliation = (error as X402PaymentOutcomeUnknownError).reconciliation;
    expect(reconciliation).toMatchObject({
      endpoint: env.endpoint,
      payTo: env.authority,
      amountAtomicUsdc: String(PRICE),
      memo: env.memoFor(env.quotes[0]!.canonical_timestamp as number),
      httpStatus: 503
    });
    expect(normalizeError(error)).toMatchObject({ code: "payment_outcome_unknown", details: reconciliation });
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
  });

  it("fails over to the next endpoint for the quote and pays only the endpoint that quoted", async () => {
    const env = await setup({ unreachableFirst: true });

    await executeAgentRound(env.ctx, round);

    expect(env.payments.map((paid) => paid.endpoint)).toEqual([env.endpoint]);
  });

  it("stops at a 400 from the quote without paying", async () => {
    const env = await setup({
      gateway: { quote: () => jsonResponse(400, { error: "registry_version: registry version or quorum does not match current snapshot" }) }
    });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(/x402 agent execute rejected: registry_version/);
    expect(env.payments).toHaveLength(0);
  });

  it("rejects a caller sourceId that does not match apiConfig before any network call", async () => {
    const env = await setup();

    await expect(executeAgentRound(env.ctx, { ...round, sourceId: "ff".repeat(32) })).rejects.toThrow(
      /sourceId does not match apiConfig/
    );
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("accepts a caller sourceId that matches apiConfig, with or without 0x", async () => {
    const env = await setup();

    await executeAgentRound(env.ctx, { ...round, sourceId: `0x${sourceId.toUpperCase()}` });
    expect(env.payments).toHaveLength(1);
  });

  it("refuses to return an aggregate for a different round", async () => {
    const env = await setup({ gateway: { data: { sourceId: "cd".repeat(32) } } });

    await expect(executeAgentRound(env.ctx, round)).rejects.toThrow(new RegExp(`settled x402 payment ${SETTLEMENT_TX}.*different round`));
  });
});

describe("previewAgentRound", () => {
  it("quotes and verifies the payment without signing or spending", async () => {
    const env = await setup();

    const preview = await previewAgentRound(env.ctx, round);

    expect(preview).toMatchObject({
      dryRun: true,
      sourceId,
      gateway: { endpoint: env.endpoint, authority: env.authority, pda: env.gatewayPda },
      network: NETWORK,
      asset: env.mint,
      priceAtomicUsdc: String(PRICE),
      feePayer: env.feePayer,
      memo: env.memoFor(env.quotes[0]!.canonical_timestamp as number),
      payerUsdcAta: env.payerAta,
      payerBalanceAtomicUsdc: "5000000",
      shortfallAtomicUsdc: "0"
    });
    expect(env.payments).toHaveLength(0);
    expect(env.connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(x402SpentToday()).toBe(0n);
  });

  it("reports the shortfall when the signer's USDC does not cover the round", async () => {
    const env = await setup({ payerBalance: 15n });

    const preview = await previewAgentRound(env.ctx, round);

    expect(preview.shortfallAtomicUsdc).toBe(String(PRICE - 15n));
    expect(preview.note).toMatch(/refuse before signing/);
  });

  it("applies the same verification as a live round", async () => {
    const env = await setup({ gateway: { tamper: (offer) => (offer.payTo = randomAddress()) } });

    await expect(previewAgentRound(env.ctx, round)).rejects.toThrow(/payTo mismatch/);
  });
});

describe("fetchAgentStatus", () => {
  const floatStatus = {
    gateway: randomAddress(),
    authority: randomAddress(),
    ataAddress: randomAddress(),
    ataExists: true,
    ataBalance: "1000000",
    committedAmount: "1030",
    quotedNextPrice: "1030",
    unsettledRounds: 1
  };
  const config = (endpoints: string[]): MolphaConfig => ({
    gatewayEndpoints: endpoints,
    gatewayAuthorities: endpoints.map(() => undefined),
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: [],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: { maxPriceUsdcAtomic: 1_000_000n, maxSpendPerDayUsdcAtomic: 10_000_000n }
  });

  it("reads the gateway float, quoting the protocol minimum unless a quorum is given", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return jsonResponse(200, floatStatus);
      })
    );

    expect(await fetchAgentStatus(config(["http://one.test/"]))).toEqual({ endpoint: "http://one.test/", status: floatStatus });
    await fetchAgentStatus(config(["http://one.test"]), 3);
    expect(urls).toEqual(["http://one.test/v1/agent/status", "http://one.test/v1/agent/status?signatures_required=3"]);
  });

  it("falls through unreachable gateways but surfaces a rejected quorum", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith("http://down.test")) throw new TypeError("fetch failed");
        return jsonResponse(400, { error: "signatures_required: outside current protocol quorum limits" });
      })
    );

    await expect(fetchAgentStatus(config(["http://down.test", "http://up.test"]), 9)).rejects.toThrow(
      /rejected: signatures_required: outside current protocol quorum limits/
    );
  });
});

import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { Keypair, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaProgramId } from "../../src/clients.js";
import { type MolphaConfig } from "../../src/config.js";
import { recordX402Spend, resetGuardrailCounters } from "../../src/guardrails.js";
import { requireSdkExport } from "../../src/sdk.js";
import { type MolphaSigner } from "../../src/signer/types.js";
import {
  agentFetch,
  agentRequestAuthMessage,
  deriveAgentEscrow,
  deriveAgentEscrowAta,
  verifyX402FundingAccept,
  type AgentRequestAuthParams,
  type X402Accept
} from "../../src/x402.js";

const defaultApiConfig = {
  url: "https://api.example.com/v1/finalized/rate",
  responseParser: "$.rate"
};

function deriveTestSourceId(apiConfig: { url: string; responseParser: string } = defaultApiConfig): string {
  return requireSdkExport<(cfg: Record<string, unknown>) => string>("deriveSourceIdString")(apiConfig);
}

function makeSigner(keypair: Keypair): MolphaSigner {
  return {
    publicKey: address(keypair.publicKey.toBase58()),
    async isAvailable() {
      return true;
    },
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) {
        tx.sign(keypair);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) {
        if (tx instanceof Transaction) tx.sign(keypair);
      }
      return txs;
    },
    async signMessage(): Promise<Uint8Array> {
      return new Uint8Array(64).fill(7);
    }
  };
}

// x402.ts caches the discovered gateway PDA per gateway endpoint at module
// scope; give every test its own endpoint so that cache can't leak state
// between tests sharing this file's module instance.
let gatewayEndpointCounter = 0;

function makeConfig(x402Overrides: Partial<MolphaConfig["x402"]> = {}): MolphaConfig {
  gatewayEndpointCounter += 1;
  return {
    gatewayEndpoints: [`http://gateway-${gatewayEndpointCounter}.test`],
    gatewayAuthorities: [undefined],
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: [],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: {
      maxPriceUsdcAtomic: 10_000_000n,
      maxSpendPerDayUsdcAtomic: 100_000_000n,
      gatewayPda: undefined,
      ...x402Overrides
    }
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fakeConnection = {
  getLatestBlockhash: vi.fn(async () => ({
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 1
  })),
  sendRawTransaction: vi.fn(async () => "fake-signature"),
  confirmTransaction: vi.fn(async () => ({ value: { err: null } }))
};

const usdcMint = address(Keypair.generate().publicKey.toBase58());
const programId = getMolphaProgramId();

async function derivedFundingAddresses(payer: string, gateway: string) {
  const escrow = await deriveAgentEscrow(address(payer), address(gateway), programId);
  const escrowAta = await deriveAgentEscrowAta(escrow, usdcMint);
  return { escrow: String(escrow), escrowAta: String(escrowAta) };
}

function makeAccept(overrides: {
  payer: string;
  gateway: string;
  agent: string;
  payTo: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  sourceId?: string;
}): X402Accept {
  return {
    scheme: "exact",
    network: "solana-devnet",
    maxAmountRequired: overrides.maxAmountRequired ?? "1000000",
    payTo: overrides.payTo,
    asset: overrides.asset ?? String(usdcMint),
    resource: "/v1/agent/execute",
    description: "test",
    maxTimeoutSeconds: 60,
    extra: {
      agent: overrides.agent,
      gateway: overrides.gateway,
      sourceId: overrides.sourceId ?? "ab".repeat(32),
      canonicalTimestamp: 1_700_000_000,
      amount: overrides.amount ?? "1000000",
      payer: overrides.payer,
      currentAtaBalance: "0",
      committedAmount: "0",
      note: "fund and retry"
    }
  };
}

describe("agentRequestAuthMessage", () => {
  it("matches sha256(domainPrefix || agent || gateway || sourceId || ts_le || amount_le)", () => {
    const agent = Keypair.generate().publicKey;
    const gateway = Keypair.generate().publicKey;
    const sourceId = new Uint8Array(32).fill(0xab);
    const params: AgentRequestAuthParams = {
      agent: address(agent.toBase58()),
      gateway: address(gateway.toBase58()),
      sourceId,
      canonicalTimestamp: 1_700_000_000,
      amount: 1_234_567n
    };

    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigUInt64LE(BigInt(params.canonicalTimestamp));
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(params.amount);

    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("MOLPHA_AGENT_REQAUTH_V1", "utf8"),
          agent.toBuffer(),
          gateway.toBuffer(),
          Buffer.from(sourceId),
          tsBuf,
          amountBuf
        ])
      )
      .digest();

    const actual = agentRequestAuthMessage(params);
    expect(Buffer.from(actual).equals(expected)).toBe(true);
    expect(actual.length).toBe(32);
  });
});

describe("verifyX402FundingAccept", () => {
  it("accepts a 402 whose agent/payTo/asset match derived escrow + protocol USDC mint", async () => {
    const payer = address(Keypair.generate().publicKey.toBase58());
    const gateway = address(Keypair.generate().publicKey.toBase58());
    const { escrow, escrowAta } = await derivedFundingAddresses(String(payer), String(gateway));

    const verified = await verifyX402FundingAccept(
      makeAccept({
        payer: String(payer),
        gateway: String(gateway),
        agent: escrow,
        payTo: escrowAta
      }),
      {
        payer,
        programId,
        usdcMint,
        maxPriceUsdcAtomic: 10_000_000n,
        maxSpendPerDayUsdcAtomic: 100_000_000n
      }
    );

    expect(String(verified.escrow)).toBe(escrow);
    expect(String(verified.escrowAta)).toBe(escrowAta);
    expect(verified.fundAmount).toBe(1_000_000n);
    expect(verified.roundPrice).toBe(1_000_000n);
  });

  it("rejects a mismatched payTo", async () => {
    const payer = address(Keypair.generate().publicKey.toBase58());
    const gateway = address(Keypair.generate().publicKey.toBase58());
    const { escrow } = await derivedFundingAddresses(String(payer), String(gateway));

    await expect(
      verifyX402FundingAccept(
        makeAccept({
          payer: String(payer),
          gateway: String(gateway),
          agent: escrow,
          payTo: Keypair.generate().publicKey.toBase58()
        }),
        {
          payer,
          programId,
          usdcMint,
          maxPriceUsdcAtomic: 10_000_000n,
          maxSpendPerDayUsdcAtomic: 100_000_000n
        }
      )
    ).rejects.toThrow(/payTo mismatch/);
  });
});

describe("agentFetch", () => {
  const payerKeypair = Keypair.generate();
  const signer = makeSigner(payerKeypair);
  const derivedSourceId = deriveTestSourceId();
  const solana = {
    getRegistryVersion: async () => 1,
    fetchProtocolTokens: async () => ({ usdcMint, treasury: Keypair.generate().publicKey.toBase58() })
  };

  beforeEach(() => {
    resetGuardrailCounters();
    fakeConnection.getLatestBlockhash.mockClear();
    fakeConnection.sendRawTransaction.mockClear();
    fakeConnection.confirmTransaction.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dry-runs without any funding when the escrow already covers the quoted price", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig({ gatewayPda });
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain(`/v1/agent/${signer.publicKey}/status?signatures_required=1`);
      return jsonResponse(200, {
        payer: signer.publicKey,
        gateway: gatewayPda,
        escrow,
        exists: true,
        ataAddress: escrowAta,
        ataExists: true,
        ataBalance: "5000000",
        committedAmount: "0",
        quotedNextPrice: "1000000",
        unsettledRounds: 0
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
        signaturesRequired: 1,
        dryRun: true
      }
    );

    expect(result.dryRun).toBe(true);
    expect(result.shortfallAtomicUsdc).toBe("0");
    expect(result.escrow).toBe(escrow);
    expect(result.ata).toBe(escrowAta);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("funds the escrow on 402, signs AgentRequestAuth, and returns the mapped result", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const sourceIdHex = derivedSourceId;
    const config = makeConfig();

    let executeCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        expect(href).toContain(`/v1/agent/${signer.publicKey}/status`);
        return jsonResponse(200, {
          payer: signer.publicKey,
          gateway: gatewayPubkey,
          escrow,
          exists: false,
          ataAddress: escrowAta,
          ataExists: false,
          ataBalance: "0",
          committedAmount: "0",
          quotedNextPrice: "1000000",
          unsettledRounds: 0
        });
      }

      executeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      if (executeCalls === 1) {
        expect(body.amount).toBe(0);
        expect(body.agent_request_auth_sig).toBeUndefined();
        return jsonResponse(402, {
          x402Version: 1,
          error: "payment required: escrow ATA underfunded",
          accepts: [
            makeAccept({
              payer: String(signer.publicKey),
              gateway: gatewayPubkey,
              agent: escrow,
              payTo: escrowAta,
              sourceId: sourceIdHex
            })
          ]
        });
      }

      expect(body.amount).toBe(1000000);
      expect(typeof body.agent_request_auth_sig).toBe("string");
      expect(body.canonical_timestamp).toBe(1_700_000_000);
      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: sourceIdHex,
          value: "42",
          valuePacked: "0".repeat(64),
          timestamp: 1_700_000_000,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: defaultApiConfig,
        signaturesRequired: 1
      }
    );

    expect(result.value).toBe("42");
    expect(result.sourceId).toBe(sourceIdHex);
    expect(executeCalls).toBe(2);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  // The gateway checks funding before the amount lock, so an `amount: 0`
  // discovery probe against an already-funded escrow returns 400 with the
  // round price rather than a 402 quote. That used to abort the whole round.
  it("treats the funded-escrow 400 from discovery as a quote when status is unavailable", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const config = makeConfig({ gatewayPda }); // pinned, so status is not needed

    let executeCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        return jsonResponse(503, { error: "status unavailable" });
      }

      executeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.amount === 0) {
        return jsonResponse(400, { error: "amount: must equal the computed round price 50015" });
      }

      expect(body.amount).toBe(50015);
      expect(typeof body.agent_request_auth_sig).toBe("string");
      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: "cd".repeat(32),
          value: "77",
          valuePacked: "0".repeat(64),
          timestamp: body.canonical_timestamp,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      { apiConfig: defaultApiConfig, signaturesRequired: 1 }
    );

    expect(result.value).toBe("77");
    expect(executeCalls).toBe(2); // discovery probe + the signed round
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("dry-runs a funded escrow with no shortfall when status is unavailable", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig({ gatewayPda });

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) return jsonResponse(503, { error: "status unavailable" });
      return jsonResponse(400, { error: "amount: must equal the computed round price 50015" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      { apiConfig: defaultApiConfig, signaturesRequired: 1, dryRun: true }
    );

    expect(result.priceAtomicUsdc).toBe("50015");
    expect(result.shortfallAtomicUsdc).toBe("0");
    expect(result.escrow).toBe(escrow);
    expect(result.ata).toBe(escrowAta);
  });

  it("fails with an actionable message when the escrow is funded but the gateway PDA is unknown", async () => {
    const config = makeConfig(); // no pin, no cache, status broken

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) return jsonResponse(503, { error: "status unavailable" });
      return jsonResponse(400, { error: "amount: must equal the computed round price 50015" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        { apiConfig: defaultApiConfig, signaturesRequired: 1 }
      )
    ).rejects.toThrow(/MOLPHA_X402_GATEWAY_PDA/);
  });

  it("does not retry non-amount 400s such as a stale registry version", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const config = makeConfig({ gatewayPda });

    let executeCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) return jsonResponse(503, { error: "status unavailable" });
      executeCalls += 1;
      return jsonResponse(400, { error: "registry_version: stale, current registry version is 3" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        { apiConfig: defaultApiConfig, signaturesRequired: 1 }
      )
    ).rejects.toThrow(/registry_version: stale/);
    expect(executeCalls).toBe(1);
  });

  it("uses status gateway + price when already funded (no unsigned discovery)", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig(); // no pinned gateway PDA

    let executeCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        return jsonResponse(200, {
          payer: signer.publicKey,
          gateway: gatewayPda,
          escrow,
          exists: true,
          ataAddress: "ata-placeholder",
          ataExists: true,
          ataBalance: "250075",
          committedAmount: "0",
          quotedNextPrice: "50015",
          unsettledRounds: 0
        });
      }

      executeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.amount).toBe(50015);
      expect(typeof body.agent_request_auth_sig).toBe("string");
      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: "cd".repeat(32),
          value: "99",
          valuePacked: "0".repeat(64),
          timestamp: body.canonical_timestamp,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
        signaturesRequired: 1
      }
    );

    expect(result.value).toBe("99");
    expect(executeCalls).toBe(1);
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("bumps canonical_timestamp and retries once on 409 when already funded", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig({ gatewayPda });

    const timestamps: number[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        return jsonResponse(200, {
          payer: signer.publicKey,
          gateway: gatewayPda,
          escrow,
          exists: true,
          ataAddress: escrowAta,
          ataExists: true,
          ataBalance: "5000000",
          committedAmount: "0",
          quotedNextPrice: "1000000",
          unsettledRounds: 0
        });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      timestamps.push(body.canonical_timestamp as number);

      if (timestamps.length === 1) {
        return jsonResponse(409, { error: "canonical_timestamp already reserved" });
      }

      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: "cd".repeat(32),
          value: "7",
          valuePacked: "0".repeat(64),
          timestamp: body.canonical_timestamp,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
        signaturesRequired: 1
      }
    );

    expect(result.value).toBe("7");
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]).toBe((timestamps[0] ?? 0) + 1);
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a round priced above the per-round cap without funding the escrow", async () => {
    const config = makeConfig({ maxPriceUsdcAtomic: 500_000n });
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        throw new Error("status unavailable");
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.amount).toBe(0);
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required: escrow ATA underfunded",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: escrowAta,
            amount: "1000000",
            maxAmountRequired: "1000000"
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/cap reached/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a malicious payTo / asset before signing any transfer", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: Keypair.generate().publicKey.toBase58(),
            asset: Keypair.generate().publicKey.toBase58()
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/asset mismatch|payTo mismatch/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a malicious extra.agent before signing any transfer", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: Keypair.generate().publicKey.toBase58(),
            payTo: escrowAta
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/agent \(escrow\) mismatch/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects maxAmountRequired above the per-round cap even when extra.amount is under the cap", async () => {
    const config = makeConfig({ maxPriceUsdcAtomic: 1_000_000n });
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: escrowAta,
            amount: "500000",
            maxAmountRequired: "2000000"
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/cap reached|maxAmountRequired/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects maxAmountRequired greater than extra.amount", async () => {
    const config = makeConfig();
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: escrowAta,
            amount: "1000000",
            maxAmountRequired: "1500000"
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/maxAmountRequired .* exceeds round price/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("funds and executes when the top-up equals the daily spend cap", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const sourceIdHex = derivedSourceId;
    const config = makeConfig({ maxSpendPerDayUsdcAtomic: 1_000_000n });

    let executeCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        return jsonResponse(200, {
          payer: signer.publicKey,
          gateway: gatewayPubkey,
          escrow,
          exists: false,
          ataAddress: escrowAta,
          ataExists: false,
          ataBalance: "0",
          committedAmount: "0",
          quotedNextPrice: "1000000",
          unsettledRounds: 0
        });
      }

      executeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      if (executeCalls === 1) {
        expect(body.amount).toBe(0);
        return jsonResponse(402, {
          x402Version: 1,
          error: "payment required: escrow ATA underfunded",
          accepts: [
            makeAccept({
              payer: String(signer.publicKey),
              gateway: gatewayPubkey,
              agent: escrow,
              payTo: escrowAta,
              sourceId: sourceIdHex
            })
          ]
        });
      }

      expect(body.amount).toBe(1000000);
      expect(typeof body.agent_request_auth_sig).toBe("string");
      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: sourceIdHex,
          value: "42",
          valuePacked: "0".repeat(64),
          timestamp: 1_700_000_000,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: defaultApiConfig,
        signaturesRequired: 1
      }
    );

    expect(result.value).toBe("42");
    expect(executeCalls).toBe(2);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects before funding when the daily spend cap is already exhausted", async () => {
    recordX402Spend(1_000_000n);
    const config = makeConfig({ maxSpendPerDayUsdcAtomic: 1_000_000n });
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required: escrow ATA underfunded",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: escrowAta
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" },
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/daily spend cap reached/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("funds once then retries a 409 without re-applying the daily spend cap", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const config = makeConfig({ maxSpendPerDayUsdcAtomic: 1_000_000n });

    let executeCalls = 0;
    const timestamps: number[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/status")) {
        return jsonResponse(200, {
          payer: signer.publicKey,
          gateway: gatewayPubkey,
          escrow,
          exists: false,
          ataAddress: escrowAta,
          ataExists: false,
          ataBalance: "0",
          committedAmount: "0",
          quotedNextPrice: "1000000",
          unsettledRounds: 0
        });
      }

      executeCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      if (executeCalls === 1) {
        expect(body.amount).toBe(0);
        return jsonResponse(402, {
          x402Version: 1,
          error: "payment required: escrow ATA underfunded",
          accepts: [
            makeAccept({
              payer: String(signer.publicKey),
              gateway: gatewayPubkey,
              agent: escrow,
              payTo: escrowAta,
              sourceId: derivedSourceId
            })
          ]
        });
      }

      timestamps.push(body.canonical_timestamp as number);
      expect(body.amount).toBe(1000000);

      if (timestamps.length === 1) {
        return jsonResponse(409, { error: "canonical_timestamp already reserved" });
      }

      return jsonResponse(200, {
        status: "completed",
        data: {
          sourceId: derivedSourceId,
          value: "7",
          valuePacked: "0".repeat(64),
          timestamp: body.canonical_timestamp,
          registryVersion: 1,
          signaturesRequired: 1,
          signersBitmap: "0".repeat(64),
          s: "0".repeat(64),
          commitmentAddr: "0".repeat(40),
          fresh: true
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: defaultApiConfig,
        signaturesRequired: 1
      }
    );

    expect(result.value).toBe("7");
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]).toBe((timestamps[0] ?? 0) + 1);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts a caller-provided sourceId that matches the derived id (bare hex)", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig({ gatewayPda });
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        payer: signer.publicKey,
        gateway: gatewayPda,
        escrow,
        exists: true,
        ataAddress: escrowAta,
        ataExists: true,
        ataBalance: "5000000",
        committedAmount: "0",
        quotedNextPrice: "1000000",
        unsettledRounds: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: defaultApiConfig,
        signaturesRequired: 1,
        sourceId: derivedSourceId,
        dryRun: true
      }
    );

    expect(result.dryRun).toBe(true);
    expect(result.sourceId).toBe(derivedSourceId);
  });

  it("accepts a caller-provided sourceId that matches the derived id (0x prefix)", async () => {
    const gatewayPda = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPda);
    const config = makeConfig({ gatewayPda });
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        payer: signer.publicKey,
        gateway: gatewayPda,
        escrow,
        exists: true,
        ataAddress: escrowAta,
        ataExists: true,
        ataBalance: "5000000",
        committedAmount: "0",
        quotedNextPrice: "1000000",
        unsettledRounds: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await agentFetch(
      { config, connection: fakeConnection as never, signer, solana },
      {
        apiConfig: defaultApiConfig,
        signaturesRequired: 1,
        sourceId: `0x${derivedSourceId}`,
        dryRun: true
      }
    );

    expect(result.dryRun).toBe(true);
    expect(result.sourceId).toBe(derivedSourceId);
  });

  it("rejects a mismatched caller-provided sourceId before any network call", async () => {
    const config = makeConfig();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: defaultApiConfig,
          signaturesRequired: 1,
          sourceId: "ff".repeat(32)
        }
      )
    ).rejects.toThrow(/sourceId does not match/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects discovery when extra.sourceId does not match the derived id", async () => {
    const gatewayPubkey = Keypair.generate().publicKey.toBase58();
    const { escrow, escrowAta } = await derivedFundingAddresses(String(signer.publicKey), gatewayPubkey);
    const config = makeConfig();

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/status")) {
        throw new Error("status unavailable");
      }
      return jsonResponse(402, {
        x402Version: 1,
        error: "payment required",
        accepts: [
          makeAccept({
            payer: String(signer.publicKey),
            gateway: gatewayPubkey,
            agent: escrow,
            payTo: escrowAta,
            sourceId: "cd".repeat(32)
          })
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentFetch(
        { config, connection: fakeConnection as never, signer, solana },
        {
          apiConfig: defaultApiConfig,
          signaturesRequired: 1
        }
      )
    ).rejects.toThrow(/sourceId does not match/);

    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });
});

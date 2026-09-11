import { describe, expect, it } from "vitest";
import { toDataUpdateArtifact, toSignedResult } from "../../src/artifacts.js";
import { loadConfig, type MolphaConfig } from "../../src/config.js";
import { checkApiConfigDeterminism } from "../../src/determinism.js";
import { normalizeError } from "../../src/errors.js";
import { decodeFeedValueKind, presentFeed } from "../../src/feed.js";
import { toCanonicalHex } from "../../src/hex.js";
import { checkX402PerRoundCap, checkX402SpendCap, enforceExecuteCap, resetGuardrailCounters } from "../../src/guardrails.js";
import { buildVerifierArgsForChains } from "../../src/verifiers.js";

describe("loadConfig", () => {
  it("parses endpoint, verifier networks, and guardrails", () => {
    const config = loadConfig({
      GATEWAY_ENDPOINTS: "http://one.test, http://two.test",
      SOLANA_RPC: "http://solana.test",
      OWNER_KEYPAIR: "./owner.json",
      MOLPHA_EVM_NETWORKS: "evm-sepolia,arbitrum-sepolia",
      MOLPHA_STARKNET_NETWORKS: "starknet-sepolia",
      MOLPHA_MAX_EXECUTES_PER_DAY: "20",
      MOLPHA_DRY_RUN: "true"
    });

    expect(config.gatewayEndpoints).toEqual(["http://one.test", "http://two.test"]);
    expect(config.solanaRpc).toBe("http://solana.test");
    expect(config.ownerKeypair).toBe("./owner.json");
    expect(config.evmNetworks).toEqual(["evm-sepolia", "arbitrum-sepolia"]);
    expect(config.starknetNetworks).toEqual(["starknet-sepolia"]);
    expect(config.guardrails).toEqual({
      maxExecutesPerDay: 20,
      dryRunDefault: true
    });
  });

  it("accepts AGENT_KEYPAIR as deprecated alias for OWNER_KEYPAIR", () => {
    const config = loadConfig({ AGENT_KEYPAIR: "./legacy.json" });
    expect(config.ownerKeypair).toBe("./legacy.json");
  });

  it("parses x402 caps as decimal USDC and defaults GATEWAY_ENDPOINTS when blank", () => {
    const config = loadConfig({
      GATEWAY_ENDPOINTS: "",
      MOLPHA_X402_MAX_PRICE_USDC: "2.5",
      MOLPHA_X402_MAX_SPEND_PER_DAY_USDC: "20"
    });

    expect(config.gatewayEndpoints.length).toBeGreaterThan(0);
    expect(config.x402.maxPriceUsdcAtomic).toBe(2_500_000n);
    expect(config.x402.maxSpendPerDayUsdcAtomic).toBe(20_000_000n);
  });
});

describe("toCanonicalHex", () => {
  it("left-pads the gateway's minimal hex to the fixed width", () => {
    expect(toCanonicalHex("4", 32, "signersBitmap")).toBe(`0x${"0".repeat(63)}4`);
    expect(toCanonicalHex("0x04", 32, "signersBitmap")).toBe(`0x${"0".repeat(63)}4`);
    expect(toCanonicalHex("0XAB", 20, "commitmentAddr")).toBe(`0x${"0".repeat(38)}ab`);
  });

  it("passes an already-canonical value through unchanged", () => {
    const full = `0x${"a".repeat(64)}`;
    expect(toCanonicalHex(full, 32, "s")).toBe(full);
  });

  it("rejects over-width and non-hex input", () => {
    expect(() => toCanonicalHex("0x" + "a".repeat(66), 32, "s")).toThrow(/at most 32 bytes/);
    expect(() => toCanonicalHex("0xnothex", 32, "s")).toThrow(/expected hex/);
    expect(() => toCanonicalHex("", 32, "s")).toThrow(/empty/);
  });
});

describe("toDataUpdateArtifact", () => {
  it("shapes gateway result into spec-friendly signed artifact", () => {
    const artifact = toDataUpdateArtifact({
      sourceId: "0xabc",
      value: "123",
      fresh: true,
      registryVersion: 42,
      signaturesRequired: 3,
      timestamp: 1714300000,
      s: "0x5165",
      commitmentAddr: "0xc0b",
      signersBitmap: "4"
    });

    expect(artifact).toEqual({
      value: "123",
      fresh: true,
      dataUpdate: {
        sourceId: `0x${"0".repeat(61)}abc`,
        registryVersion: 42,
        signaturesRequired: 3,
        value: "123",
        canonicalTimestamp: 1714300000
      },
      signature: {
        signature: `0x${"0".repeat(60)}5165`,
        commitment: `0x${"0".repeat(37)}c0b`,
        signersBitmap: `0x${"0".repeat(63)}4`
      }
    });
  });
});

describe("toSignedResult", () => {
  const flat = {
    sourceId: `0x${"1".repeat(64)}`,
    value: "66285",
    valuePacked: `0x${"2".repeat(64)}`,
    timestamp: 1714300000,
    registryVersion: 7,
    signaturesRequired: 1,
    signersBitmap: "4",
    s: `0x${"3".repeat(64)}`,
    commitmentAddr: `0x${"4".repeat(40)}`,
    fresh: true
  };

  it("accepts the round artifact and the flat shape interchangeably", () => {
    const artifact = toDataUpdateArtifact(flat);

    expect(toSignedResult(artifact as unknown as Record<string, unknown>)).toEqual(
      toSignedResult(flat)
    );
  });

  it("canonicalizes the bitmap on both paths", () => {
    expect(toSignedResult(flat).signersBitmap).toBe(`0x${"0".repeat(63)}4`);
  });

  it("ignores extra keys carried along from a pasted round response", () => {
    const pasted = {
      ...(toDataUpdateArtifact(flat) as unknown as Record<string, unknown>),
      payment: "x402",
      trustAnchor: "…",
      verifierArgs: { evm: {} }
    };

    expect(toSignedResult(pasted).s).toBe(flat.s);
  });
});

describe("decodeFeedValueKind", () => {
  it("flattens the Anchor enum variant object", () => {
    expect(decodeFeedValueKind({ valueKind: { value: {} } })).toBe("value");
    expect(decodeFeedValueKind({ valueKind: { hash: {} } })).toBe("hash");
    expect(decodeFeedValueKind({ value_kind: { hash: {} } })).toBe("hash");
    expect(decodeFeedValueKind(null)).toBeNull();
  });

  it("annotates the feed without dropping other fields", () => {
    const feed = presentFeed({ valueKind: { value: {} }, registryVersion: 7 });
    expect(feed).toMatchObject({ valueKind: "value", registryVersion: 7 });
    expect(String(feed?.valueKindMeaning)).toContain("raw oracle payload");
  });

  it("renders the feed's byte arrays as 0x hex so they compare against sourceIds", () => {
    const feed = presentFeed({
      sourceId: [0xab, ...new Array<number>(31).fill(0)],
      value: new Uint8Array([0, 42]),
      signersBitmap: [0, 7],
      valueKind: { value: {} }
    });

    expect(feed?.sourceId).toBe(`0xab${"00".repeat(31)}`);
    expect(feed?.value).toBe("0x002a");
    expect(feed?.signersBitmap).toBe("0x0007");
  });
});

describe("checkApiConfigDeterminism", () => {
  it("warns on live-drifting URLs", () => {
    const result = checkApiConfigDeterminism({
      url: "https://api.example.com/ticker/BTC",
      responseParser: "$.price"
    });

    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("passes settled sources", () => {
    const result = checkApiConfigDeterminism({
      url: "https://api.example.com/v1/finalized/rate",
      responseParser: "$.rate"
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("guardrails", () => {
  it("enforces the daily execute cap", () => {
    resetGuardrailCounters();
    const guardrails = { maxExecutesPerDay: 1, dryRunDefault: false };

    enforceExecuteCap(guardrails);
    expect(() => enforceExecuteCap(guardrails)).toThrow(/cap reached/);
  });

  it("enforces the x402 per-round price cap", () => {
    resetGuardrailCounters();
    expect(() => checkX402SpendCap(2_000_000n, 1_000_000n, 10_000_000n)).toThrow(/cap reached/);
  });

  it("enforces the x402 daily spend cap across calls without recording spend on check alone", () => {
    resetGuardrailCounters();
    // checkX402SpendCap never records spend itself — repeated checks at the same
    // price never accumulate.
    checkX402SpendCap(1_000_000n, 1_000_000n, 1_000_000n);
    expect(() => checkX402SpendCap(1_000_000n, 1_000_000n, 1_000_000n)).not.toThrow();
  });

  it("enforces the x402 per-round cap independently of daily spend", () => {
    resetGuardrailCounters();
    expect(() => checkX402PerRoundCap(2_000_000n, 1_000_000n)).toThrow(/cap reached/);
    expect(() => checkX402PerRoundCap(1_000_000n, 1_000_000n)).not.toThrow();
  });
});

describe("normalizeError", () => {
  it("maps subscription, payment, and config errors with remediation", () => {
    expect(normalizeError(new Error("OWNER_KEYPAIR is required")).code).toBe("missing_config");
    expect(normalizeError(new Error("Subscription expired")).remediation).toContain("execute_agent_round");
    expect(normalizeError(new Error("execute cap reached (10 per day)")).code).toBe("guardrail_exceeded");
    expect(
      normalizeError(new Error("x402 per-round price cap reached: round price (2 USDC) exceeds MOLPHA_X402_MAX_PRICE_USDC (1 USDC).")).code
    ).toBe("guardrail_exceeded");
  });

  it("maps a 402 status to payment_required with remediation", () => {
    const error = Object.assign(new Error("x402 payment rejected by the gateway: invalid payment"), { status: 402 });
    const normalized = normalizeError(error);
    expect(normalized.code).toBe("payment_required");
    expect(normalized.remediation).toContain("x402");
  });

  it("maps a gateway 403 to forbidden, pointing at the self-funded round", () => {
    const error = Object.assign(new Error("Gateway rejected request (403): subscription expired"), { status: 403 });
    const normalized = normalizeError(error);
    expect(normalized.code).toBe("forbidden");
    expect(normalized.remediation).toContain("execute_agent_round");
  });

  it("maps a gateway without GET /v1/info to a GATEWAY_AUTHORITIES fix", () => {
    const error = Object.assign(new Error("GET /v1/info failed (404)"), { status: 404 });
    const normalized = normalizeError(error);
    expect(normalized.code).toBe("invalid_config");
    expect(normalized.remediation).toContain("GATEWAY_AUTHORITIES");
  });
});

describe("buildVerifierArgsForChains", () => {
  const baseConfig: MolphaConfig = {
    gatewayEndpoints: ["http://gateway.test"],
    gatewayAuthorities: [undefined],
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: ["evm-sepolia"],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: {
      maxPriceUsdcAtomic: 1_000_000n,
      maxSpendPerDayUsdcAtomic: 10_000_000n
    }
  };

  it("includes evm verifier metadata when requested", () => {
    const result = {
      sourceId: "0".repeat(64),
      value: "1",
      valuePacked: "0".repeat(64),
      timestamp: 1,
      registryVersion: 1,
      signaturesRequired: 1,
      signersBitmap: "0".repeat(64),
      s: "0".repeat(64),
      commitmentAddr: "0".repeat(40),
      fresh: true
    };

    const args = buildVerifierArgsForChains(result, ["evm"], baseConfig);

    expect(args.evm).toBeDefined();
    expect((args.evm as { chainIds: number[] }).chainIds).toContain(11155111);
  });

  // The gateway emits a one-signer bitmap as "4"; the SDK's verifier-arg
  // builders require exactly 32 bytes. Normalizing at the boundary is what
  // keeps callers from having to zero-pad it themselves.
  it("builds args from a gateway result whose signersBitmap is unpadded", () => {
    const raw = {
      sourceId: "0".repeat(64),
      value: "66285",
      valuePacked: "0".repeat(64),
      timestamp: 1,
      registryVersion: 1,
      signaturesRequired: 1,
      signersBitmap: "4",
      s: "0".repeat(64),
      commitmentAddr: "0".repeat(40),
      fresh: true
    };

    const args = buildVerifierArgsForChains(toSignedResult(raw), ["evm"], baseConfig);

    expect(args.errors).toBeUndefined();
    expect(args.evm).toBeDefined();
  });
});

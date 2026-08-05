import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deriveFeedId } from "../../src/apiconfig.js";
import { resolveFetchFeedId, validateFetchVerifiedInput } from "../../src/tools/fetch_verified.js";

const OWNER = address("9K9FknHzW7j8a88yKTrzxKfDrxnV2QLqSR58ETAVdc8P");

const apiConfig = { url: "https://api.example.com/v1/price", responseParser: "$.price" };
const providerSource = {
  providerId: "tickerlayer",
  requiredPluginVersion: "^1.0.0",
  operation: "crypto.trade.last",
  symbol: "BTCUSD",
  response: { valueParser: "$.price" }
};

describe("validateFetchVerifiedInput", () => {
  it("rejects when both apiConfig and providerSource are set", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig,
        providerSource,
        encryptSecrets: undefined,
        resolvedPayment: "subscription"
      })
    ).toThrow("Provide exactly one of apiConfig or providerSource, not both.");
  });

  it("rejects when neither apiConfig nor providerSource is set", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig: undefined,
        providerSource: undefined,
        encryptSecrets: undefined,
        resolvedPayment: "subscription"
      })
    ).toThrow("apiConfig or providerSource is required.");
  });

  it("rejects encryptSecrets on the x402 path", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig,
        providerSource: undefined,
        encryptSecrets: { token: "x" },
        resolvedPayment: "x402"
      })
    ).toThrow(/encryptSecrets is not yet supported on the x402 payment path/);
  });

  it("allows a valid x402 + providerSource combination", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig: undefined,
        providerSource,
        encryptSecrets: undefined,
        resolvedPayment: "x402"
      })
    ).not.toThrow();
  });

  it("allows a valid subscription + apiConfig combination", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig,
        providerSource: undefined,
        encryptSecrets: undefined,
        resolvedPayment: "subscription"
      })
    ).not.toThrow();
  });

  it("allows a valid subscription + providerSource combination", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig: undefined,
        providerSource,
        encryptSecrets: undefined,
        resolvedPayment: "subscription"
      })
    ).not.toThrow();
  });

  it("allows a valid x402 + apiConfig combination", () => {
    expect(() =>
      validateFetchVerifiedInput({
        apiConfig,
        providerSource: undefined,
        encryptSecrets: undefined,
        resolvedPayment: "x402"
      })
    ).not.toThrow();
  });
});

describe("resolveFetchFeedId", () => {
  it("passes feedId through unchanged (undefined) when providerSource is set and feedId is omitted", () => {
    const result = resolveFetchFeedId({
      feedId: undefined,
      apiConfig: undefined,
      providerSource,
      signaturesRequired: 1,
      owner: OWNER
    });
    expect(result).toBeUndefined();
  });

  it("passes an explicit feedId through unchanged alongside providerSource, without deriving", () => {
    const explicit = "ab".repeat(32);
    const result = resolveFetchFeedId({
      feedId: explicit,
      apiConfig: undefined,
      providerSource,
      signaturesRequired: 1,
      owner: OWNER
    });
    expect(result).toBe(explicit);
  });

  it("derives feedId from apiConfig when providerSource is not set", () => {
    const derived = deriveFeedId(apiConfig, 1, OWNER).feedId;
    const result = resolveFetchFeedId({
      feedId: undefined,
      apiConfig,
      providerSource: undefined,
      signaturesRequired: 1,
      owner: OWNER
    });
    expect(result).toBe(derived);
  });

  it("throws when a supplied feedId does not match the derived apiConfig feedId", () => {
    expect(() =>
      resolveFetchFeedId({
        feedId: "ab".repeat(32),
        apiConfig,
        providerSource: undefined,
        signaturesRequired: 1,
        owner: OWNER
      })
    ).toThrow(/feedId does not match apiConfig/);
  });
});

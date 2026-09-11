import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("ignores unresolved MCP bundle gateway_endpoints placeholders", () => {
    const config = loadConfig({
      GATEWAY_ENDPOINTS: "${user_config.gateway_endpoints}"
    });

    expect(config.gatewayEndpoints.length).toBeGreaterThan(0);
    expect(config.gatewayEndpoints[0]).not.toContain("user_config");
  });

  it("parses endpoint and verifier network csv values", () => {
    const config = loadConfig({
      GATEWAY_ENDPOINTS: "http://one.test, http://two.test",
      SOLANA_RPC: "http://solana.test",
      MOLPHA_EVM_NETWORKS: "evm-sepolia,arbitrum-sepolia",
      MOLPHA_STARKNET_NETWORKS: "starknet-sepolia"
    });

    expect(config.gatewayEndpoints).toEqual(["http://one.test", "http://two.test"]);
    expect(config.solanaRpc).toBe("http://solana.test");
    expect(config.evmNetworks).toEqual(["evm-sepolia", "arbitrum-sepolia"]);
    expect(config.starknetNetworks).toEqual(["starknet-sepolia"]);
    expect(config.guardrails.maxExecutesPerDay).toBe(100);
  });

  it("pairs GATEWAY_AUTHORITIES with GATEWAY_ENDPOINTS by position", () => {
    const authority = "11111111111111111111111111111111";
    const config = loadConfig({
      GATEWAY_ENDPOINTS: "http://one.test,http://two.test",
      GATEWAY_AUTHORITIES: `${authority},`
    });

    expect(config.gatewayAuthorities).toEqual([authority, undefined]);
  });

  it("leaves every gateway authority to /v1/info discovery when GATEWAY_AUTHORITIES is unset", () => {
    const config = loadConfig({ GATEWAY_ENDPOINTS: "http://one.test,http://two.test" });

    expect(config.gatewayAuthorities).toEqual([undefined, undefined]);
  });

  it("rejects a GATEWAY_AUTHORITIES list that does not line up with GATEWAY_ENDPOINTS", () => {
    expect(() =>
      loadConfig({
        GATEWAY_ENDPOINTS: "http://one.test,http://two.test",
        GATEWAY_AUTHORITIES: "11111111111111111111111111111111"
      })
    ).toThrow(/one authority per endpoint/);
  });

  it("rejects a malformed gateway authority", () => {
    expect(() =>
      loadConfig({ GATEWAY_ENDPOINTS: "http://one.test", GATEWAY_AUTHORITIES: "not-a-key" })
    ).toThrow(/GATEWAY_AUTHORITIES\[0\]/);
  });
});

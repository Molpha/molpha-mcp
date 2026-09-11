import { getMolphaContext } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { agentFetch } from "../x402.js";
import { buildRoundResult, prepareRound, roundInputSchema, type RoundArgs } from "./round.js";
import { type ToolServer } from "./types.js";

export function registerExecuteAgentRoundTool(server: ToolServer): void {
  server.registerTool(
    "execute_agent_round",
    {
      title: "Execute x402-paid Molpha agent round",
      description:
        "Run a threshold-signing round paid per request over x402 — no subscription needed — and return the self-contained signed attestation PLUS prebuilt verifier arguments for each requested chain. If the signer's agent escrow is underfunded the server tops it up from the signer's own USDC, refusing above the MOLPHA_X402_MAX_PRICE_USDC per-round and MOLPHA_X402_MAX_SPEND_PER_DAY_USDC daily caps; call get_agent_status first to see the quoted price. The round is keyed by sourceId, derived here from apiConfig (see derive_source_id). The signed payload is the trust anchor — do not consume `value` alone. Only the `solana` leg can be settled from this server (via `autoSubmit`, or submit_attestation); `evm` and `starknet` return calldata only (see verify_attestation). Private API secrets are not supported on this path — use execute_subscription_round.",
      inputSchema: roundInputSchema
    },
    toolHandler(async (args: RoundArgs) => {
      const { apiConfig, signaturesRequired, maxAge, chains, autoSubmit = false, dryRun } = args;
      const { config, solana, signer, connection } = await getMolphaContext();
      const isDryRun = dryRun ?? config.guardrails.dryRunDefault;
      const sourceId = prepareRound(args);

      const result = await agentFetch(
        { config, connection, signer, solana },
        {
          apiConfig,
          signaturesRequired,
          sourceId,
          ...(maxAge !== undefined ? { maxAge } : {}),
          ...(isDryRun ? { dryRun: true } : {})
        }
      );

      if (isDryRun) {
        return {
          payment: "x402",
          ...result,
          ...(autoSubmit ? { autoSubmit: "would submit the signed attestation to Solana" } : {})
        };
      }

      return buildRoundResult(result, chains, config, "x402", autoSubmit);
    })
  );
}

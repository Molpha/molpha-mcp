import { getMolphaContext } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { executeAgentRound, previewAgentRound } from "../x402.js";
import { buildRoundResult, prepareRound, roundInputSchema, type RoundArgs } from "./round.js";
import { type ToolServer } from "./types.js";

export function registerExecuteAgentRoundTool(server: ToolServer): void {
  server.registerTool(
    "execute_agent_round",
    {
      title: "Execute x402-paid Molpha agent round",
      description:
        "Run a threshold-signing round paid per request with an x402 USDC payment — no subscription needed — and return the self-contained signed attestation PLUS prebuilt verifier arguments for each requested chain, and the payment receipt. Before signing, the server checks the gateway's payment requirements against its own chain reads (payTo is the gateway authority, asset the protocol USDC mint, amount the protocol round price, network the SOLANA_RPC cluster, memo this round's commitment); it then signs a USDC transfer from the signer's own token account, refusing above the MOLPHA_X402_MAX_PRICE_USDC per-round and MOLPHA_X402_MAX_SPEND_PER_DAY_USDC daily caps. The gateway's facilitator pays the network fee. Call get_agent_status first to see the quoted price. The round is keyed by sourceId, derived here from apiConfig (see derive_source_id). The signed payload is the trust anchor — do not consume `value` alone. Only the `solana` leg can be settled from this server (via `autoSubmit`, or submit_attestation); `evm` and `starknet` return calldata only (see verify_attestation). Private API secrets are not supported on this path — use execute_subscription_round.",
      inputSchema: roundInputSchema
    },
    toolHandler(async (args: RoundArgs) => {
      const { apiConfig, signaturesRequired, maxAge, chains, autoSubmit = false, dryRun } = args;
      const context = await getMolphaContext();
      const isDryRun = dryRun ?? context.config.guardrails.dryRunDefault;
      const round = {
        apiConfig,
        signaturesRequired,
        sourceId: prepareRound(args),
        ...(maxAge !== undefined ? { maxAge } : {})
      };

      if (isDryRun) {
        return {
          payment: "x402",
          ...(await previewAgentRound(context, round)),
          ...(autoSubmit ? { autoSubmit: "would submit the signed attestation to Solana" } : {})
        };
      }

      const { result, payment } = await executeAgentRound(context, round);
      return {
        ...(await buildRoundResult(result, chains, context.config, "x402", autoSubmit)),
        paymentReceipt: payment
      };
    })
  );
}

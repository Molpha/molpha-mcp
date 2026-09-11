import { getMolphaContext } from "../clients.js";
import { settle } from "../errors.js";
import { x402SpentToday } from "../guardrails.js";
import { toolHandler } from "../mcp.js";
import { fetchAgentStatus } from "../x402.js";
import { readPayerUsdc } from "../x402-payment.js";
import { signaturesRequiredSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

export function registerGetAgentStatusTool(server: ToolServer): void {
  server.registerTool(
    "get_agent_status",
    {
      title: "Get x402 gateway status",
      description:
        "Advisory read before execute_agent_round: the next x402 round's quoted price for a quorum; the gateway's USDC float (its authority's token balance minus what unsettled rounds have committed — the gateway's working capital for protocol settlement, not a per-payer balance; a round is refused while the float cannot cover it); the signer's own USDC balance, which pays each round; and the remaining MOLPHA_X402_MAX_SPEND_PER_DAY_USDC budget.",
      inputSchema: {
        signaturesRequired: signaturesRequiredSchema
          .optional()
          .describe("Quorum to quote. Omit for the protocol minimum (min_signers).")
      }
    },
    toolHandler(async ({ signaturesRequired }: { signaturesRequired?: number }) => {
      const { config, signer, connection } = await getMolphaContext();
      const [{ endpoint, status }, payerUsdc] = await Promise.all([
        fetchAgentStatus(config, signaturesRequired),
        settle("solana.readPayerUsdc", () => readPayerUsdc(connection, signer.publicKey))
      ]);

      const price = BigInt(status.quotedNextPrice);
      const floatAvailable = BigInt(status.ataBalance) - BigInt(status.committedAmount);
      const { maxPriceUsdcAtomic, maxSpendPerDayUsdcAtomic } = config.x402;
      const spentToday = x402SpentToday();
      const pinnedAuthority = config.gatewayAuthorities[config.gatewayEndpoints.indexOf(endpoint)];

      return {
        endpoint,
        signaturesRequired: signaturesRequired ?? "protocol minimum",
        quotedNextPriceAtomicUsdc: status.quotedNextPrice,
        withinPerRoundCap: price <= maxPriceUsdcAtomic,
        gatewayFloat: {
          gateway: status.gateway,
          authority: status.authority,
          ataAddress: status.ataAddress,
          ataExists: status.ataExists,
          ataBalance: status.ataBalance,
          committedAmount: status.committedAmount,
          availableAtomicUsdc: (floatAvailable > 0n ? floatAvailable : 0n).toString(),
          coversNextRound: floatAvailable >= price,
          unsettledRounds: status.unsettledRounds
        },
        payer: signer.publicKey,
        payerUsdc: payerUsdc.ok ? payerUsdc.value : payerUsdc,
        caps: {
          maxPriceUsdcAtomic: maxPriceUsdcAtomic.toString(),
          maxSpendPerDayUsdcAtomic: maxSpendPerDayUsdcAtomic.toString(),
          spentTodayUsdcAtomic: spentToday.toString(),
          remainingTodayUsdcAtomic: (spentToday < maxSpendPerDayUsdcAtomic
            ? maxSpendPerDayUsdcAtomic - spentToday
            : 0n
          ).toString()
        },
        ...(pinnedAuthority && pinnedAuthority !== status.authority
          ? {
              warning: `the gateway reports authority ${status.authority}, but GATEWAY_AUTHORITIES pins ${pinnedAuthority}; execute_agent_round will refuse to pay it`
            }
          : {})
      };
    })
  );
}

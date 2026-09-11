import { z } from "zod";
import { toSignedResult } from "../artifacts.js";
import { getMolphaContext } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { buildVerifierArgsForChains, getVerifierMetadata, type ChainTarget } from "../verifiers.js";
import { type ToolServer } from "./types.js";

const chainSchema = z.enum(["evm", "starknet"]);

export function registerVerifyAttestationTool(server: ToolServer): void {
  server.registerTool(
    "verify_attestation",
    {
      title: "Build Molpha verifier calldata",
      description:
        "Build the verifier address and call args for a signed attestation on EVM or Starknet. This tool stops at calldata by design, not by omission: the Molpha verifier is stateless, so the agent (or its contract) executes verify() itself and the server never submits an EVM/Starknet transaction or vouches for a result it did not verify on-chain. There is no EVM/Starknet execution path anywhere in this MCP server. For Solana, submit the attestation via submit_attestation (or a round tool's autoSubmit) and read it back with get_latest_value — there is no separate simulate-verify path. Accepts the dataUpdate/signature objects from execute_subscription_round / execute_agent_round verbatim; short hex fields are zero-padded to their canonical widths server-side.",
      inputSchema: {
        dataUpdate: z.record(z.unknown()),
        signature: z.record(z.unknown()),
        chain: chainSchema,
        includeAbi: z.boolean().optional()
      }
    },
    toolHandler(async (
      {
        dataUpdate,
        signature,
        chain,
        includeAbi = false
      }: {
        dataUpdate: Record<string, unknown>;
        signature: Record<string, unknown>;
        chain: ChainTarget;
        includeAbi?: boolean;
      }
    ) => {
      const { config } = await getMolphaContext();
      const result = toSignedResult({ dataUpdate, signature });

      return {
        chain,
        verifierArgs: buildVerifierArgsForChains(result, [chain], config),
        note: "Execute verify() on-chain with the returned args; the MCP server does not assert validity.",
        verifiers: getVerifierMetadata(config, includeAbi)
      };
    })
  );
}

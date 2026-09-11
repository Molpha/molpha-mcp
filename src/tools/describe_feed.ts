import { z } from "zod";
import { resolveSourceId } from "../apiconfig.js";
import { getMolphaContext, requireMethod } from "../clients.js";
import { settle } from "../errors.js";
import { describeValueEncoding, presentFeed } from "../feed.js";
import { toolHandler } from "../mcp.js";
import { readSubscriptionStatus } from "../subscription.js";
import { apiConfigSchema, signaturesRequiredSchema, sourceIdSchema, submitterSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

export function registerDescribeFeedTool(server: ToolServer): void {
  server.registerTool(
    "describe_feed",
    {
      title: "Describe Molpha feed",
      description:
        "Read the Solana feed account for (sourceId, signaturesRequired, submitter) — last committed value, canonicalTimestamp, registryVersion, signersBitmap — and this signer's subscription status. Pass sourceId, or apiConfig to derive it (see derive_source_id). Feeds are keyed per submitter: submitter defaults to this server's signer, so pass another wallet's address to read the feed it maintains. A null feed is normal before that submitter's first submit_attestation. `feed.valueKind` is the attested encoding of the stored bytes (\"value\" = raw payload, \"hash\" = keccak digest), NOT a scale hint: Molpha attests no decimals on-chain. When apiConfig is supplied, `valueEncoding` reports the off-chain valueTransform that produced the number, explicitly flagged as unattested.",
      inputSchema: {
        sourceId: sourceIdSchema.optional(),
        apiConfig: apiConfigSchema.optional(),
        signaturesRequired: signaturesRequiredSchema,
        submitter: submitterSchema
      }
    },
    toolHandler(async (
      {
        sourceId,
        apiConfig,
        signaturesRequired,
        submitter
      }: {
        sourceId?: string;
        apiConfig?: z.infer<typeof apiConfigSchema>;
        signaturesRequired: number;
        submitter?: string;
      }
    ) => {
      const { config, solana, signer } = await getMolphaContext();
      const resolvedSourceId = resolveSourceId(sourceId, apiConfig);
      const feedSubmitter = submitter ?? String(signer.publicKey);

      const [onChainFeed, subscription] = await Promise.all([
        settle("solana.readFeed", async () =>
          requireMethod<[string, number, string], Promise<Record<string, unknown> | null>>(solana, "readFeed")(
            resolvedSourceId,
            signaturesRequired,
            feedSubmitter
          )
        ),
        readSubscriptionStatus(solana)
      ]);

      return {
        sourceId: resolvedSourceId,
        signaturesRequired,
        submitter: feedSubmitter,
        feed: onChainFeed.ok ? presentFeed(onChainFeed.value) : onChainFeed,
        ...(apiConfig ? { valueEncoding: describeValueEncoding(apiConfig.valueTransform) } : {}),
        subscription,
        chains: {
          solana: "devnet (canonical state)",
          evm: config.evmNetworks,
          starknet: config.starknetNetworks
        }
      };
    })
  );
}

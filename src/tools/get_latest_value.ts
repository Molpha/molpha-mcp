import { getMolphaContext, requireMethod } from "../clients.js";
import { presentFeed } from "../feed.js";
import { toCanonicalHex } from "../hex.js";
import { toolHandler } from "../mcp.js";
import { signaturesRequiredSchema, sourceIdSchema, submitterSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

export function registerGetLatestValueTool(server: ToolServer): void {
  server.registerTool(
    "get_latest_value",
    {
      title: "Get latest Molpha feed value",
      description:
        "Read the latest attested value stored on Solana for (sourceId, signaturesRequired, submitter). submitter defaults to this server's signer — feeds are keyed per submitter, so pass another wallet's address to read the feed it maintains; null means that submitter has not submitted this source at this quorum yet. `valueKind` is the attested encoding of the stored bytes (\"value\" = raw payload, \"hash\" = keccak digest) — it is not a scale hint. Molpha does not attest decimals on-chain; see describe_feed's valueEncoding for the (unsigned) apiConfig provenance.",
      inputSchema: {
        sourceId: sourceIdSchema,
        signaturesRequired: signaturesRequiredSchema,
        submitter: submitterSchema
      }
    },
    toolHandler(async (
      {
        sourceId,
        signaturesRequired,
        submitter
      }: {
        sourceId: string;
        signaturesRequired: number;
        submitter?: string;
      }
    ) => {
      const { solana, signer } = await getMolphaContext();
      const readFeed = requireMethod<[string, number, string], Promise<Record<string, unknown> | null>>(
        solana,
        "readFeed"
      );
      const canonicalSourceId = toCanonicalHex(sourceId, 32, "sourceId");
      const feedSubmitter = submitter ?? String(signer.publicKey);

      return {
        sourceId: canonicalSourceId,
        signaturesRequired,
        submitter: feedSubmitter,
        feed: presentFeed(await readFeed(canonicalSourceId, signaturesRequired, feedSubmitter))
      };
    })
  );
}

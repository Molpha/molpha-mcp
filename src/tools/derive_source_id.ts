import { z } from "zod";
import { deriveSourceId } from "../apiconfig.js";
import { checkApiConfigDeterminism } from "../determinism.js";
import { toolHandler } from "../mcp.js";
import { apiConfigSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

export function registerDeriveSourceIdTool(server: ToolServer): void {
  server.registerTool(
    "derive_source_id",
    {
      title: "Derive Molpha sourceId",
      description:
        "Derive the sourceId for an apiConfig locally: no transaction, no wallet, no subscription. sourceId = keccak256(canonicalJson), where canonicalJson is the apiConfig with defaults filled in (method \"GET\", headers {}, valueTransform \"\") and header names sorted, serialized as compact JSON with keys in the fixed order url, method, headers, responseParser, valueTransform — the derivation the SDK, gateway, and every node share. It is not RFC 8785 (JCS): JCS sorts the top-level keys and yields a different id. Call this tool instead of hashing client-side: one differing byte (key order, whitespace, a missing default, header order) gives a different sourceId, which silently points at the wrong feed and fails verification. sourceId depends on apiConfig alone — not on signaturesRequired or the signer — and identifies the source on Solana, EVM, and Starknet. canonicalJson is returned so the preimage can be audited. Prefer settled/finalized data: independent nodes must converge on a byte-identical value to co-sign.",
      inputSchema: {
        apiConfig: apiConfigSchema,
        rejectNonDeterministic: z.boolean().optional()
      }
    },
    toolHandler((
      {
        apiConfig,
        rejectNonDeterministic = false
      }: {
        apiConfig: z.infer<typeof apiConfigSchema>;
        rejectNonDeterministic?: boolean;
      }
    ) => {
      const determinism = checkApiConfigDeterminism(apiConfig);

      if (!determinism.ok && determinism.warnings.some((w) => w.includes("required"))) {
        throw new Error(determinism.warnings.join("; "));
      }

      if (rejectNonDeterministic && determinism.warnings.length > 0) {
        throw new Error(`Non-deterministic source rejected: ${determinism.warnings.join("; ")}`);
      }

      const { sourceId, canonicalApiConfig, canonicalJson } = deriveSourceId(apiConfig);

      return {
        sourceId,
        canonicalApiConfig,
        canonicalJson,
        determinismWarnings: determinism.warnings.length > 0 ? determinism.warnings : undefined,
        note:
          "No transaction was sent. A Solana feed account for (sourceId, signaturesRequired, submitter) is created by that submitter's first submit_attestation."
      };
    })
  );
}

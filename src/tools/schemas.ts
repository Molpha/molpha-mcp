import { z } from "zod";

/** Shared apiConfig input shape for tools that accept a declarative source. */
export const apiConfigSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string()).optional(),
  responseParser: z.string().min(1),
  valueTransform: z.string().optional()
});

export type ApiConfigSchema = z.infer<typeof apiConfigSchema>;

/** A full-width sourceId; tools echo it back `0x`-prefixed. */
export const sourceIdSchema = z
  .string()
  .regex(/^(0[xX])?[0-9a-fA-F]{64}$/, "expected a 32-byte sourceId as 64 hex chars (0x optional)")
  .describe("32-byte sourceId as hex (0x optional), from derive_source_id or a round's dataUpdate.");

export const signaturesRequiredSchema = z.number().int().positive().max(255);

/** Solana feeds are keyed per submitter, so feed reads name whose feed they mean. */
export const submitterSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address")
  .optional()
  .describe("Base58 wallet whose feed to read. Defaults to this server's signer.");

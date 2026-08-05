import { z } from "zod";

/** Shared apiConfig input shape for tools that accept a declarative feed source. */
export const apiConfigSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string()).optional(),
  responseParser: z.string().min(1),
  valueTransform: z.string().optional()
});

export type ApiConfigSchema = z.infer<typeof apiConfigSchema>;

/** A gateway-side provider-plugin source (e.g. TickerLayer), sent as an alternative to apiConfig. */
export const providerSourceSchema = z.object({
  providerId: z.string().min(1),
  requiredPluginVersion: z.string().min(1),
  operation: z.string().min(1),
  symbol: z.string().min(1),
  response: z.object({
    valueParser: z.string().min(1),
    valueTransform: z.string().optional()
  }),
  cachePolicy: z
    .object({
      visibility: z.string().min(1),
      ttlSeconds: z.number().int().nonnegative()
    })
    .optional()
});

export type ProviderSourceSchema = z.infer<typeof providerSourceSchema>;

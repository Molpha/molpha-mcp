---
"@molpha/mcp": minor
---

Move to the current `@molpha/sdk` protocol (`sourceId` replaces `feedId`) and name every tool verb-first, without the `molpha_` prefix.

**Breaking**

- Tools renamed: `molpha_get_capabilities` → `get_capabilities`, `molpha_derive_feed` → `derive_source_id`, `molpha_describe_feed` → `describe_feed`, `molpha_get_latest` → `get_latest_value`, `molpha_agent_status` → `get_agent_status`, `molpha_verify` → `verify_attestation`, `molpha_execute` → `submit_attestation`.
- `molpha_fetch_verified` is split by payment path into `execute_subscription_round` and `execute_agent_round`; the `payment` argument and its `"auto"` fallback are gone.
- `feedId` is replaced by `sourceId` in every input and output. `sourceId` depends on `apiConfig` alone, so `derive_source_id` no longer takes `signaturesRequired` and needs no wallet.
- `describe_feed` and `get_latest_value` take `sourceId` + `signaturesRequired` and an optional `submitter`, because Solana feeds are keyed per submitter.

**Added**

- `GATEWAY_AUTHORITIES`: the base58 authority of each gateway endpoint, bound into request signatures. Required for gateways that do not serve `GET /v1/info`.

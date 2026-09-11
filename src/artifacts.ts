/** Shape a gateway DataUpdateResult into the spec-friendly signed artifact. */

import { toCanonicalHex } from "./hex.js";

export interface SignedDataUpdate {
  sourceId: string;
  registryVersion: number;
  signaturesRequired: number;
  value: string;
  valuePacked?: string;
  canonicalTimestamp: number;
}

export interface SignedSignature {
  signature: string;
  commitment: string;
  signersBitmap: string;
}

export interface DataUpdateArtifact {
  value: string;
  fresh: boolean;
  dataUpdate: SignedDataUpdate;
  signature: SignedSignature;
}

/** Fixed byte widths the SDK and the Solana program enforce on the flat result. */
const HEX_WIDTHS: Record<string, number> = {
  sourceId: 32,
  valuePacked: 32,
  s: 32,
  commitmentAddr: 20,
  signersBitmap: 32
};

/**
 * Canonicalize every fixed-width hex field on a flat signed result. `value` is a
 * decimal string, not hex, and the numeric fields are left alone.
 */
export function normalizeSignedResult(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  for (const [field, bytes] of Object.entries(HEX_WIDTHS)) {
    const value = raw[field];
    if (value !== undefined && value !== null && value !== "") {
      out[field] = toCanonicalHex(String(value), bytes, field);
    }
  }

  return out;
}

/**
 * Accept either shape a caller can plausibly hold: the artifact this server
 * emits from `execute_subscription_round` / `execute_agent_round`
 * (`{ dataUpdate, signature }`) or the flat SDK/gateway shape
 * (`{ s, commitmentAddr, timestamp }`). Returns the flat shape with hex fields
 * canonicalized, so no tool needs a hand-written remap.
 */
export function toSignedResult(input: Record<string, unknown>): Record<string, unknown> {
  const dataUpdate = asRecord(input.dataUpdate);
  const signature = asRecord(input.signature);

  if (!dataUpdate && !signature) {
    return normalizeSignedResult(input);
  }

  const du = dataUpdate ?? {};
  const sig = signature ?? {};

  return normalizeSignedResult({
    sourceId: du.sourceId ?? input.sourceId,
    value: du.value ?? input.value,
    valuePacked: du.valuePacked ?? input.valuePacked,
    timestamp: du.canonicalTimestamp ?? du.timestamp ?? input.timestamp,
    registryVersion: du.registryVersion ?? input.registryVersion,
    signaturesRequired: du.signaturesRequired ?? input.signaturesRequired,
    signersBitmap: sig.signersBitmap ?? input.signersBitmap,
    s: sig.signature ?? sig.s ?? input.s,
    commitmentAddr: sig.commitment ?? sig.commitmentAddr ?? input.commitmentAddr,
    fresh: input.fresh ?? true
  });
}

export function toDataUpdateArtifact(result: Record<string, unknown>): DataUpdateArtifact {
  // Normalize on the way out so the artifact this server emits is byte-for-byte
  // acceptable to submit_attestation / verify_attestation without caller-side padding.
  const normalized = normalizeSignedResult(result);

  return {
    value: String(normalized.value ?? ""),
    fresh: Boolean(normalized.fresh ?? true),
    dataUpdate: {
      sourceId: String(normalized.sourceId ?? ""),
      registryVersion: Number(normalized.registryVersion ?? 0),
      signaturesRequired: Number(normalized.signaturesRequired ?? 0),
      value: String(normalized.value ?? ""),
      ...(normalized.valuePacked !== undefined
        ? { valuePacked: String(normalized.valuePacked) }
        : {}),
      canonicalTimestamp: Number(normalized.timestamp ?? 0)
    },
    signature: {
      signature: String(normalized.s ?? ""),
      commitment: String(normalized.commitmentAddr ?? ""),
      signersBitmap: String(normalized.signersBitmap ?? "")
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The single Solana settle path, shared by `submit_attestation` and the round
 * tools' `autoSubmit` leg — one guardrail check, one shape normalization, one
 * place that knows what the program's `submit_attestation` requires.
 */

import { toSignedResult } from "./artifacts.js";
import { getMolphaContext, requireMethod } from "./clients.js";
import { enforceExecuteCap, previewWrite } from "./guardrails.js";

export interface SubmitOutcome {
  chain: "solana";
  action: "submit_attestation";
  sourceId: string;
  signaturesRequired: number;
  /** Wallet that paid for the write; Solana feeds are keyed per submitter. */
  submitter: string;
  /** Feed PDA `["molpha_feed", sourceId, [signaturesRequired], submitter]`. */
  feed: string;
  signature: string;
}

/**
 * Accepts a round tool's artifact or the flat signed result, and returns the
 * flat shape `submitAttestation` expects.
 */
export function prepareSignedResult(input: Record<string, unknown>): Record<string, unknown> {
  const result = toSignedResult(input);

  if (!result.sourceId) {
    throw new Error("signed result is missing `sourceId`");
  }

  // The program stores `valuePacked` as the on-chain value; `value` is the
  // decimal rendering and is not interchangeable with it.
  if (!result.valuePacked) {
    throw new Error(
      "signed result is missing `valuePacked` (the on-chain encoding of `value`); re-run the round and pass its output through unmodified"
    );
  }

  return result;
}

export function previewSubmit(
  action: string,
  result: Record<string, unknown>,
  submitter: string
): ReturnType<typeof previewWrite> {
  return previewWrite(action, {
    chain: "solana",
    action: "submit_attestation",
    sourceId: result.sourceId,
    signaturesRequired: result.signaturesRequired,
    registryVersion: result.registryVersion,
    submitter
  });
}

/** Enforces the daily execute cap, then submits. Callers must pass a prepared result. */
export async function submitSignedResult(result: Record<string, unknown>): Promise<SubmitOutcome> {
  const { config, solana, signer } = await getMolphaContext();
  enforceExecuteCap(config.guardrails);

  const submitAttestation = requireMethod<
    [Record<string, unknown>],
    Promise<{ signature: string; feed: unknown }>
  >(solana, "submitAttestation");

  const tx = await submitAttestation(result);

  return {
    chain: "solana",
    action: "submit_attestation",
    sourceId: String(result.sourceId),
    signaturesRequired: Number(result.signaturesRequired),
    submitter: String(signer.publicKey),
    feed: String(tx.feed),
    signature: tx.signature
  };
}

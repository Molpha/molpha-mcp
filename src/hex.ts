/**
 * sourceIds cross the tool boundary in both forms — the SDK and gateway use
 * bare hex, this server's artifacts carry a `0x` prefix — so compare them
 * through this rather than as raw strings.
 */
export function normalizeSourceId(sourceId: string): string {
  const bare = sourceId.startsWith("0x") || sourceId.startsWith("0X") ? sourceId.slice(2) : sourceId;
  return bare.toLowerCase();
}

/**
 * The gateway emits fixed-width fields as minimal hex — a one-signer bitmap
 * comes back as `"4"`, not 32 zero-padded bytes. Every consumer downstream is
 * strict: the SDK's `toFixedHex`/`toFixedBytes` reject anything whose hex
 * length is not exactly `bytes * 2` (`signersBitmap: expected 32 bytes, got
 * 0.5`), and the Solana program reads the bitmap as a fixed 32-byte array
 * indexed from the end (`bitmap[31 - (bit >> 3)]`).
 *
 * Both readings are big-endian, so left-zero-padding is the canonical widening.
 * Do it at the server boundary — on everything emitted and everything ingested —
 * rather than making callers memorize a width the server already knows.
 */
export function toCanonicalHex(value: string, bytes: number, label: string): string {
  const clean = stripQuotes(String(value))
    .replace(/^0[xX]/, "")
    .toLowerCase();

  if (clean.length === 0) {
    throw new Error(`${label}: expected ${bytes} bytes of hex, got an empty value`);
  }

  if (!/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`${label}: expected hex, got "${value}"`);
  }

  // Over-width is corruption (wrong field, wrong encoding), not a format nit.
  if (clean.length > bytes * 2) {
    throw new Error(
      `${label}: expected at most ${bytes} bytes (${bytes * 2} hex chars), got ${clean.length / 2}`
    );
  }

  return `0x${clean.padStart(bytes * 2, "0")}`;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

import { formatUsdcAtomic, type GuardrailConfig } from "./config.js";

interface DailyCounter {
  day: string;
  count: number;
}

interface DailySpend {
  day: string;
  spentAtomic: bigint;
}

const executes: DailyCounter = { day: "", count: 0 };
const x402Spend: DailySpend = { day: "", spentAtomic: 0n };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(counter: DailyCounter, max: number, label: string): void {
  const day = todayKey();
  if (counter.day !== day) {
    counter.day = day;
    counter.count = 0;
  }

  if (counter.count >= max) {
    throw new Error(`${label} cap reached (${max} per day). Adjust MOLPHA_MAX_${label.toUpperCase().replace(/ /g, "_")}_PER_DAY or wait until tomorrow.`);
  }

  counter.count += 1;
}

/** Reset counters — exposed for tests. */
export function resetGuardrailCounters(): void {
  executes.day = "";
  executes.count = 0;
  x402Spend.day = "";
  x402Spend.spentAtomic = 0n;
}

export function enforceExecuteCap(config: GuardrailConfig): void {
  bump(executes, config.maxExecutesPerDay, "execute");
}

/** Checks a proposed round price against the per-round cap only. */
export function checkX402PerRoundCap(priceAtomic: bigint, maxPriceUsdcAtomic: bigint): void {
  if (priceAtomic > maxPriceUsdcAtomic) {
    throw new Error(
      `x402 per-round price cap reached: round price (${formatUsdcAtomic(priceAtomic)} USDC) exceeds MOLPHA_X402_MAX_PRICE_USDC (${formatUsdcAtomic(maxPriceUsdcAtomic)} USDC).`
    );
  }
}

/** x402 USDC signed away today, in base units. */
export function x402SpentToday(): bigint {
  return x402Spend.day === todayKey() ? x402Spend.spentAtomic : 0n;
}

/** Checks a proposed wallet outflow against the daily spend cap only. */
export function checkX402DailySpendCap(amountAtomic: bigint, maxSpendPerDayUsdcAtomic: bigint): void {
  const spentToday = x402SpentToday();
  if (spentToday + amountAtomic > maxSpendPerDayUsdcAtomic) {
    throw new Error(
      `x402 daily spend cap reached (${formatUsdcAtomic(maxSpendPerDayUsdcAtomic)} USDC per day, ${formatUsdcAtomic(spentToday)} USDC already spent). Adjust MOLPHA_X402_MAX_SPEND_PER_DAY_USDC or wait until tomorrow.`
    );
  }
}

/**
 * Checks a proposed x402 round's price against the per-round and daily
 * spend caps, without recording the spend (call {@link recordX402Spend}
 * once a payment is signed).
 */
export function checkX402SpendCap(
  priceAtomic: bigint,
  maxPriceUsdcAtomic: bigint,
  maxSpendPerDayUsdcAtomic: bigint
): void {
  checkX402PerRoundCap(priceAtomic, maxPriceUsdcAtomic);
  checkX402DailySpendCap(priceAtomic, maxSpendPerDayUsdcAtomic);
}

/**
 * Records an x402 payment against the daily cap as soon as it is signed and
 * handed to a gateway. A signed transfer can settle whether or not the round
 * completes, so counting it only on success would let the cap be exceeded.
 */
export function recordX402Spend(priceAtomic: bigint): void {
  const day = todayKey();
  if (x402Spend.day !== day) {
    x402Spend.day = day;
    x402Spend.spentAtomic = 0n;
  }

  x402Spend.spentAtomic += priceAtomic;
}

export interface WritePreview {
  dryRun: true;
  action: string;
  summary: Record<string, unknown>;
}

export function previewWrite(action: string, summary: Record<string, unknown>): WritePreview {
  return { dryRun: true, action, summary };
}

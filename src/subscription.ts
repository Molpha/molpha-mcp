import { requireMethod } from "./clients.js";

export interface SubscriptionStatus {
  active: boolean;
  owner?: string;
  planType?: unknown;
  validUntil?: string;
  usedRounds?: number;
  maxRounds?: number;
  message?: string;
}

export async function readSubscriptionStatus(
  solana: Record<string, unknown>
): Promise<SubscriptionStatus> {
  const readSubscription = requireMethod<[], Promise<Record<string, unknown> | null>>(solana, "readSubscription");

  try {
    const subscription = await readSubscription();

    if (!subscription) {
      return {
        active: false,
        message:
          "No active subscription found. Run `npm run provision -- subscribe` (or molpha-provision bootstrap) with OWNER_KEYPAIR, or use execute_agent_round for a self-funded pay-per-request round."
      };
    }

    const validUntil = BigInt(String(subscription.validUntil ?? 0));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const usedRounds = BigInt(String(subscription.usedRounds ?? 0));
    const maxRounds = BigInt(String(subscription.maxRounds ?? 0));
    const active = validUntil > now && (maxRounds === 0n || usedRounds < maxRounds);

    return {
      active,
      owner: subscription.owner?.toString?.() ?? String(subscription.owner ?? ""),
      planType: subscription.planType,
      validUntil: validUntil.toString(),
      usedRounds: Number(usedRounds),
      maxRounds: Number(maxRounds),
      ...(active
        ? {}
        : {
            message:
              validUntil <= now
                ? "Subscription expired. Extend via the bootstrap CLI before requesting data."
                : "Subscription round quota exhausted for this period. Extend via the bootstrap CLI, or use execute_agent_round."
          })
    };
  } catch (error) {
    return {
      active: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

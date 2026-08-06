import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getSdkExport } from "./sdk.js";

const DEFAULT_SOLANA_RPC = "https://api.devnet.solana.com";
const FALLBACK_GATEWAY_ENDPOINT = "http://188.166.249.79:8080";

export interface GuardrailConfig {
  maxExecutesPerDay: number;
  dryRunDefault: boolean;
}

export interface X402Config {
  /** Per-round cap in USDC base units (6 decimals). Refuse funding above this. */
  maxPriceUsdcAtomic: bigint;
  /** Daily cumulative spend cap in USDC base units. */
  maxSpendPerDayUsdcAtomic: bigint;
  /** Optional override for the settling gateway PDA (base58), when known out-of-band. */
  gatewayPda: string | undefined;
}

export interface MolphaConfig {
  gatewayEndpoints: string[];
  solanaRpc: string;
  ownerKeypair: string | undefined;
  evmNetworks: string[];
  starknetNetworks: string[];
  guardrails: GuardrailConfig;
  x402: X402Config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MolphaConfig {
  const sdkDefaultGateway = getSdkExport<string>("DEFAULT_GATEWAY_ENDPOINT");

  return {
    gatewayEndpoints: parseCsv(
      // mcp's own default takes precedence over the SDK's — the SDK export
      // is only a fallback-of-a-fallback for when mcp has no opinion.
      resolveEnvString(env.GATEWAY_ENDPOINTS) ?? FALLBACK_GATEWAY_ENDPOINT ?? sdkDefaultGateway
    ),
    solanaRpc: resolveEnvString(env.SOLANA_RPC) ?? DEFAULT_SOLANA_RPC,
    ownerKeypair: resolveEnvString(env.OWNER_KEYPAIR ?? env.AGENT_KEYPAIR),
    evmNetworks: parseCsv(resolveEnvString(env.MOLPHA_EVM_NETWORKS) ?? "evm-sepolia"),
    starknetNetworks: parseCsv(resolveEnvString(env.MOLPHA_STARKNET_NETWORKS) ?? "starknet-sepolia"),
    guardrails: {
      maxExecutesPerDay: parsePositiveInt(resolveEnvString(env.MOLPHA_MAX_EXECUTES_PER_DAY), 100),
      dryRunDefault: (() => {
        const dryRun = resolveEnvString(env.MOLPHA_DRY_RUN);
        return dryRun === "1" || dryRun === "true";
      })()
    },
    x402: {
      maxPriceUsdcAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_X402_MAX_PRICE_USDC), 1_000_000n),
      maxSpendPerDayUsdcAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_X402_MAX_SPEND_PER_DAY_USDC), 10_000_000n),
      gatewayPda: resolveEnvString(env.MOLPHA_X402_GATEWAY_PDA)
    }
  };
}

export function loadOwnerKeypair(config: MolphaConfig): Uint8Array {
  if (!config.ownerKeypair) {
    throw new Error("OWNER_KEYPAIR is required for the Molpha MCP runtime (Model A owner key)");
  }

  return loadKeypair(config.ownerKeypair);
}

/** @deprecated Use loadOwnerKeypair — AGENT_KEYPAIR alias retained for compatibility. */
export function loadAgentKeypair(config: MolphaConfig): Uint8Array {
  return loadOwnerKeypair(config);
}

export function loadKeypair(pathOrJson: string): Uint8Array {
  const raw = isInlineKeypair(pathOrJson) ? pathOrJson : readFileSync(resolvePath(pathOrJson), "utf8");
  const secretKey = JSON.parse(raw) as number[];

  if (!Array.isArray(secretKey) || secretKey.length !== 64) {
    throw new Error("keypair must be a JSON array of 64 secret-key bytes");
  }

  return Uint8Array.from(secretKey);
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Parses a decimal USDC amount (e.g. "1.5") into base units (6 decimals). */
function parseUsdcAtomic(value: string | undefined, fallback: bigint): bigint {
  if (!value?.trim()) {
    return fallback;
  }

  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`expected a decimal USDC amount, got "${value}"`);
  }

  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }

  return parsed;
}

const UNRESOLVED_MCP_USER_CONFIG = /^\$\{user_config\.[a-z0-9_]+\}$/i;

/** Treats empty strings and unresolved MCP bundle `${user_config.*}` placeholders as unset. */
export function resolveEnvString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || UNRESOLVED_MCP_USER_CONFIG.test(trimmed)) {
    return undefined;
  }

  return value;
}

export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** An OWNER_KEYPAIR value can be a file path or an inline JSON secret-key array. */
export function isInlineKeypair(pathOrJson: string): boolean {
  return pathOrJson.trim().startsWith("[");
}

/** Formats a USDC atomic (6-decimal) amount as a decimal string, e.g. 1_500_000n -> "1.5". */
export function formatUsdcAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = atomic % 1_000_000n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

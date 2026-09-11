import { type MolphaConfig } from "./config.js";
import { getSdkExport } from "./sdk.js";

export type ChainTarget = "evm" | "starknet" | "solana";

export interface VerifierMetadata {
  evm: Array<{ network: string; address?: string; error?: string }>;
  starknet: Array<{ network: string; address?: string; error?: string }>;
  evmAbi?: unknown;
}

const EVM_NETWORK_CHAIN_IDS: Record<string, number[]> = {
  "evm-sepolia": [11155111],
  "arbitrum-sepolia": [421614],
  "avalanche-fuji": [43113],
  "bsc-testnet": [97]
};

export function getVerifierMetadata(config: MolphaConfig, includeAbi = false): VerifierMetadata {
  return {
    evm: config.evmNetworks.map((network) => resolveEvmVerifierAddress(network)),
    starknet: config.starknetNetworks.map((network) =>
      resolveVerifierAddress("getMolphaStarknetVerifierAddress", network)
    ),
    ...(includeAbi ? { evmAbi: getSdkExport("MOLPHA_VERIFIER_ABI") ?? null } : {})
  };
}

export function buildVerifierArgs(result: unknown): {
  evm?: unknown;
  starknet?: unknown;
  errors: Array<{ target: string; message: string }>;
} {
  const errors: Array<{ target: string; message: string }> = [];
  const evm = callBuilder("buildEvmVerifierArgs", result, errors);
  const starknet = callBuilder("buildStarknetVerifierArgs", result, errors);

  return {
    ...(evm !== undefined ? { evm } : {}),
    ...(starknet !== undefined ? { starknet } : {}),
    errors
  };
}

export function buildVerifierArgsForChains(
  result: unknown,
  chains: ChainTarget[],
  config: MolphaConfig
): Record<string, unknown> {
  const built = buildVerifierArgs(result);
  const out: Record<string, unknown> = {};

  if (chains.includes("evm") && built.evm !== undefined) {
    out.evm = {
      verifier: config.evmNetworks.map((network) => ({
        network,
        address: resolveEvmVerifierAddress(network).address
      })),
      chainIds: config.evmNetworks.flatMap((network) => EVM_NETWORK_CHAIN_IDS[network] ?? []),
      args: built.evm
    };
  }

  if (chains.includes("starknet") && built.starknet !== undefined) {
    const starknetMeta = config.starknetNetworks.map((network) =>
      resolveVerifierAddress("getMolphaStarknetVerifierAddress", network)
    );
    out.starknet = {
      verifier: starknetMeta[0]?.address,
      args: built.starknet
    };
  }

  if (built.errors.length > 0) {
    out.errors = built.errors;
  }

  return out;
}

/**
 * The EVM verifier is deployed via CREATE2 — the same address on every
 * supported chain — so this is a single SDK constant rather than a
 * per-network lookup.
 */
function resolveEvmVerifierAddress(network: string): { network: string; address?: string; error?: string } {
  const address = getSdkExport<string>("MOLPHA_VERIFIER_ADDRESS");
  if (!address) {
    return { network, error: "MOLPHA_VERIFIER_ADDRESS is not exported by @molpha/sdk" };
  }

  return { network, address };
}

function resolveVerifierAddress(exportName: string, network: string): { network: string; address?: string; error?: string } {
  const resolver = getSdkExport<(...args: string[]) => string | undefined>(exportName);
  if (typeof resolver !== "function") {
    return { network, error: `${exportName} is not exported by @molpha/sdk` };
  }

  try {
    const address = resolver(network);
    return address ? { network, address } : { network, error: "no verifier address returned" };
  } catch (error) {
    return {
      network,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function callBuilder(
  exportName: string,
  result: unknown,
  errors: Array<{ target: string; message: string }>
): unknown | undefined {
  const builder = getSdkExport<(result: unknown) => unknown>(exportName);
  if (typeof builder !== "function") {
    errors.push({ target: exportName, message: `${exportName} is not exported by @molpha/sdk` });
    return undefined;
  }

  try {
    return builder(result);
  } catch (error) {
    errors.push({
      target: exportName,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

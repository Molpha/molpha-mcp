import type { Address } from "@solana/kit";
import { Connection, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { loadConfig, type MolphaConfig } from "./config.js";
import { parseSolanaPubkey } from "./solana-address.js";
import { toLegacyPublicKey } from "./solana-compat.js";
import { getSdkExport, requireSdkExport } from "./sdk.js";
import { createSigner } from "./signer/factory.js";
import type { MolphaSigner } from "./signer/types.js";

export interface MolphaContext {
  config: MolphaConfig;
  gateway: Record<string, unknown>;
  solana: Record<string, unknown>;
  signer: MolphaSigner;
  connection: Connection;
}

let cachedContextPromise: Promise<MolphaContext> | undefined;

export function getMolphaContext(): Promise<MolphaContext> {
  cachedContextPromise ??= createMolphaContext(loadConfig());
  return cachedContextPromise;
}

export async function createMolphaContext(config: MolphaConfig): Promise<MolphaContext> {
  const signer = await createSigner(config);
  const connection = new Connection(config.solanaRpc, "confirmed");
  const solana = createSolanaClient(config, signer, connection);

  return {
    config,
    gateway: createGateway(config, solana, signer),
    solana,
    signer,
    connection
  };
}

export function createGateway(
  config: MolphaConfig,
  solana: Record<string, unknown>,
  signer: MolphaSigner
): Record<string, unknown> {
  const Gateway = requireSdkExport<new (...args: unknown[]) => Record<string, unknown>>("MolphaGateway");
  // SDK Signer type = (message: Uint8Array) => Promise<Uint8Array>
  const defaultSigner = (msg: Uint8Array) => signer.signMessage(msg);
  // Request auth binds each gateway's PDA; without a configured authority the SDK
  // looks it up via GET /v1/info, which not every gateway serves.
  const endpoints = config.gatewayEndpoints.map((url, index) => {
    const gatewayAuthority = config.gatewayAuthorities[index];
    return gatewayAuthority ? { url, gatewayAuthority } : url;
  });

  return new Gateway(
    endpoints,
    () => requireMethod<[], Promise<Record<string, unknown>>>(solana, "getRegistrySelectionConfig")(),
    defaultSigner,
    {
      defaultSubscriptionOwner: signer.publicKey,
      // Private API secrets are only encrypted to node keys that match the on-chain registry.
      verifyNodeKeys: (args: unknown) =>
        requireMethod<[unknown], Promise<void>>(solana, "verifyNodeKeysForPrivateApi")(args)
    }
  );
}

export function createSolanaClient(
  config: MolphaConfig,
  signer: MolphaSigner,
  connection: Connection = new Connection(config.solanaRpc, "confirmed")
): Record<string, unknown> {
  const SolanaClient = requireSdkExport<{
    create: (opts: Record<string, unknown>) => Record<string, unknown>;
  }>("MolphaSolanaClient");
  const wallet = {
    publicKey: toLegacyPublicKey(signer.publicKey),
    signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => signer.signTransaction(tx),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => signer.signAllTransactions(txs),
  };

  return SolanaClient.create({
    connection,
    wallet
  });
}

export function getMolphaProgramId(): Address {
  return parseSolanaPubkey(requireSdkExport<string>("MOLPHA_PROGRAM_ADDRESS"), "MOLPHA_PROGRAM_ADDRESS");
}

export function requireMethod<TArgs extends unknown[], TResult>(
  target: Record<string, unknown>,
  methodName: string
): (...args: TArgs) => TResult {
  const method = target[methodName];
  if (typeof method !== "function") {
    throw new Error(`Molpha SDK client is missing ${methodName}()`);
  }

  return method.bind(target) as (...args: TArgs) => TResult;
}

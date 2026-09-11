import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSolanaRpc } from "@solana/kit";
import {
  formatUsdcAtomic,
  isInlineKeypair,
  loadConfig,
  loadKeypair,
  resolveEnvString,
  resolvePath
} from "./config.js";
import { createSigner } from "./signer/factory.js";
import { validateSolanaPubkey } from "./solana-address.js";

export interface SetupCheck {
  name: string;
  ok: boolean;
  message: string;
}

export function validateSignerEnv(env: NodeJS.ProcessEnv = process.env): SetupCheck[] {
  const backend = resolveEnvString(env.SIGNER_BACKEND) ?? "memory";
  const checks: SetupCheck[] = [
    {
      name: "signer_backend",
      ok: backend === "memory" || backend === "keychain",
      message:
        backend === "memory" || backend === "keychain"
          ? `SIGNER_BACKEND=${backend}`
          : `unsupported SIGNER_BACKEND="${backend}" (expected memory or keychain)`
    }
  ];

  if (backend === "memory") {
    const ownerKeypair = resolveEnvString(env.OWNER_KEYPAIR ?? env.AGENT_KEYPAIR);
    if (!ownerKeypair?.trim()) {
      checks.push({
        name: "owner_keypair",
        ok: false,
        message: "OWNER_KEYPAIR is required for SIGNER_BACKEND=memory"
      });
      return appendOptionalPubkeyChecks(checks, env);
    }

    if (isInlineKeypair(ownerKeypair)) {
      try {
        loadKeypair(ownerKeypair);
        checks.push({
          name: "owner_keypair",
          ok: true,
          message: "OWNER_KEYPAIR=<inline-json-keypair>"
        });
      } catch (error) {
        checks.push({
          name: "owner_keypair",
          ok: false,
          message:
            error instanceof Error
              ? `OWNER_KEYPAIR inline JSON is invalid: ${error.message}`
              : "OWNER_KEYPAIR inline JSON is invalid"
        });
      }
      return appendOptionalPubkeyChecks(checks, env);
    }

    const resolved = resolveKeypairPath(ownerKeypair);
    if (!existsSync(resolved)) {
      checks.push({
        name: "owner_keypair",
        ok: false,
        message: `OWNER_KEYPAIR file not found: ${resolved}`
      });
      return appendOptionalPubkeyChecks(checks, env);
    }

    checks.push({
      name: "owner_keypair",
      ok: true,
      message: `OWNER_KEYPAIR=${resolved}`
    });
    return appendOptionalPubkeyChecks(checks, env);
  }

  const provider = resolveEnvString(env.KEYCHAIN_BACKEND);
  if (provider !== "privy" && provider !== "turnkey") {
    checks.push({
      name: "keychain_backend",
      ok: false,
      message: `KEYCHAIN_BACKEND must be privy or turnkey for SIGNER_BACKEND=keychain (got "${provider ?? ""}")`
    });
    return checks;
  }

  checks.push({
    name: "keychain_backend",
    ok: true,
    message: `KEYCHAIN_BACKEND=${provider}`
  });

  const required =
    provider === "privy"
      ? ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID", "PRIVY_WALLET_ADDRESS"]
      : [
          "TURNKEY_API_PUBLIC_KEY",
          "TURNKEY_API_PRIVATE_KEY",
          "TURNKEY_ORGANIZATION_ID",
          "TURNKEY_WALLET_ADDRESS"
        ];

  const walletAddressVar = provider === "privy" ? "PRIVY_WALLET_ADDRESS" : "TURNKEY_WALLET_ADDRESS";

  for (const name of required) {
    const value = resolveEnvString(env[name]);
    if (name === walletAddressVar) {
      if (!value?.trim()) {
        checks.push({
          name: name.toLowerCase(),
          ok: false,
          message: `${name} is required for ${provider}`
        });
        continue;
      }

      const validation = validateSolanaPubkey(value, name);
      checks.push({
        name: name.toLowerCase(),
        ok: validation.ok,
        message: validation.ok ? `${name} is a valid Solana address` : validation.message
      });
      continue;
    }

    checks.push({
      name: name.toLowerCase(),
      ok: Boolean(value && value.trim().length > 0),
      message: value && value.trim().length > 0 ? `${name} is set` : `${name} is required for ${provider}`
    });
  }

  for (const [name, value] of [["MOLPHA_X402_GATEWAY_PDA", resolveEnvString(env.MOLPHA_X402_GATEWAY_PDA)]] as const) {
    if (!value?.trim()) {
      continue;
    }

    const validation = validateSolanaPubkey(value, name);
    checks.push({
      name: name.toLowerCase(),
      ok: validation.ok,
      message: validation.ok ? `${name} is a valid Solana address` : validation.message
    });
  }

  return checks;
}

export async function checkSignerAvailability(): Promise<SetupCheck> {
  try {
    const signer = await createSigner(loadConfig());
    const available = await signer.isAvailable();
    return {
      name: "signer",
      ok: available,
      message: available
        ? `signer ready for ${signer.publicKey}`
        : "signer backend is not available"
    };
  } catch (error) {
    return {
      name: "signer",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function looksLikeSolanaRpc(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return (
      host.includes("helius") ||
      host.includes("quicknode") ||
      host.includes("alchemy") ||
      host === "solana.com" ||
      host.endsWith(".solana.com") ||
      host.includes("rpc.")
    );
  } catch {
    return false;
  }
}

export async function checkGatewayEndpoints(endpoints: string[]): Promise<SetupCheck> {
  if (endpoints.length === 0) {
    return {
      name: "gateway_endpoints",
      ok: false,
      message: "no gateway endpoints configured"
    };
  }

  const solanaRpcEndpoint = endpoints.find(looksLikeSolanaRpc);
  if (solanaRpcEndpoint) {
    return {
      name: "gateway_endpoints",
      ok: false,
      message:
        `${solanaRpcEndpoint} looks like a Solana RPC URL — set GATEWAY_ENDPOINTS to a Molpha gateway (not SOLANA_RPC)`
    };
  }

  let lastError = "no reachable gateway";
  for (const endpoint of endpoints) {
    const base = endpoint.replace(/\/$/, "");
    try {
      const nodesRes = await fetch(`${base}/v1/nodes`, { method: "GET", signal: AbortSignal.timeout(8_000) });
      if (!nodesRes.ok) {
        lastError = `GET /v1/nodes failed (${nodesRes.status}) at ${base}`;
        continue;
      }

      const probeRes = await fetch(`${base}/v1/agent/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(8_000)
      });
      const probeText = (await probeRes.text()).trim();
      if (probeText.includes('"jsonrpc"') && probeText.includes("Method not found")) {
        lastError = `${base} returned a Solana JSON-RPC error for POST /v1/agent/execute — this is not a Molpha gateway`;
        continue;
      }
      if (probeRes.status === 404 && probeText.includes("page not found")) {
        lastError = `${base} serves /v1/nodes but not /v1/agent/execute (signing routes missing — use https://dev-gateway.molpha.io)`;
        continue;
      }
      if (probeRes.status === 400 || probeRes.status === 401 || probeRes.status === 402) {
        return {
          name: "gateway_endpoints",
          ok: true,
          message: `${base} reachable (nodes + signing routes)`
        };
      }

      lastError = `${base} unexpected POST /v1/agent/execute response (${probeRes.status})`;
    } catch (error) {
      lastError = error instanceof Error ? `${base}: ${error.message}` : `${base}: unreachable`;
    }
  }

  return {
    name: "gateway_endpoints",
    ok: false,
    message: lastError
  };
}

export async function checkSolanaRpc(rpc: string): Promise<SetupCheck> {
  try {
    const version = await createSolanaRpc(rpc).getVersion().send();
    return {
      name: "solana_rpc",
      ok: true,
      message: `reachable (${version["solana-core"] ?? "ok"})`
    };
  } catch (error) {
    return {
      name: "solana_rpc",
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function checkBuildArtifact(repoRoot = process.cwd()): SetupCheck {
  const built = resolve(repoRoot, "dist/src/server.js");
  return {
    name: "build",
    ok: existsSync(built),
    message: existsSync(built)
      ? `server entry found at ${built}`
      : `missing ${built} — run npm run build`
  };
}

export function resolveServerEntry(repoRoot = process.cwd()): string {
  return resolve(repoRoot, "dist/src/server.js");
}

export function buildMcpEnvBlock(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = loadConfig(env);
  const out: Record<string, string> = {
    SOLANA_RPC: config.solanaRpc,
    GATEWAY_ENDPOINTS: config.gatewayEndpoints.join(","),
    ...(config.gatewayAuthorities.some(Boolean)
      ? { GATEWAY_AUTHORITIES: config.gatewayAuthorities.map((authority) => authority ?? "").join(",") }
      : {}),
    MOLPHA_EVM_NETWORKS: config.evmNetworks.join(","),
    MOLPHA_STARKNET_NETWORKS: config.starknetNetworks.join(","),
    MOLPHA_MAX_EXECUTES_PER_DAY: String(config.guardrails.maxExecutesPerDay),
    MOLPHA_X402_MAX_PRICE_USDC: formatUsdcAtomic(config.x402.maxPriceUsdcAtomic),
    MOLPHA_X402_MAX_SPEND_PER_DAY_USDC: formatUsdcAtomic(config.x402.maxSpendPerDayUsdcAtomic)
  };

  if (config.x402.gatewayPda) {
    out.MOLPHA_X402_GATEWAY_PDA = config.x402.gatewayPda;
  }

  const backend = resolveEnvString(env.SIGNER_BACKEND) ?? "memory";
  if (backend === "memory") {
    out.SIGNER_BACKEND = "memory";
    const ownerKeypair = resolveEnvString(env.OWNER_KEYPAIR ?? env.AGENT_KEYPAIR);
    if (ownerKeypair) {
      out.OWNER_KEYPAIR = resolveKeypairPath(ownerKeypair);
    }
  } else {
    out.SIGNER_BACKEND = "keychain";
    const provider = resolveEnvString(env.KEYCHAIN_BACKEND);
    if (provider) {
      out.KEYCHAIN_BACKEND = provider;
    }

    const passthrough =
      provider === "privy"
        ? ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID", "PRIVY_WALLET_ADDRESS"]
        : provider === "turnkey"
          ? [
              "TURNKEY_API_PUBLIC_KEY",
              "TURNKEY_API_PRIVATE_KEY",
              "TURNKEY_ORGANIZATION_ID",
              "TURNKEY_WALLET_ADDRESS"
            ]
          : [];

    for (const name of passthrough) {
      const value = resolveEnvString(env[name]);
      if (value) {
        out[name] = value;
      }
    }
  }

  if (config.guardrails.dryRunDefault) {
    out.MOLPHA_DRY_RUN = "true";
  }

  return out;
}

export function buildMcpJsonSnippet(repoRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const serverPath = resolveServerEntry(repoRoot);
  return JSON.stringify(
    {
      mcpServers: {
        molpha: {
          command: "node",
          args: [serverPath],
          env: buildMcpEnvBlock(env)
        }
      }
    },
    null,
    2
  );
}

export function buildCodexTomlSnippet(repoRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const serverPath = resolveServerEntry(repoRoot);
  const envBlock = buildMcpEnvBlock(env);
  const lines = [
    "[mcp_servers.molpha]",
    `command = "node"`,
    `args = ["${serverPath}"]`,
    "",
    "[mcp_servers.molpha.env]"
  ];

  for (const [key, value] of Object.entries(envBlock)) {
    lines.push(`${key} = "${value.replaceAll('"', '\\"')}"`);
  }

  return `${lines.join("\n")}\n`;
}

function appendOptionalPubkeyChecks(checks: SetupCheck[], env: NodeJS.ProcessEnv): SetupCheck[] {
  for (const [name, value] of [["MOLPHA_X402_GATEWAY_PDA", resolveEnvString(env.MOLPHA_X402_GATEWAY_PDA)]] as const) {
    if (!value?.trim()) {
      continue;
    }

    const validation = validateSolanaPubkey(value, name);
    checks.push({
      name: name.toLowerCase(),
      ok: validation.ok,
      message: validation.ok ? `${name} is a valid Solana address` : validation.message
    });
  }

  return checks;
}

function resolveKeypairPath(path: string): string {
  return isInlineKeypair(path) ? "<inline-json-keypair>" : resolvePath(path);
}

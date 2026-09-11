#!/usr/bin/env node
import "../src/env.js";
import {
  buildCodexTomlSnippet,
  buildMcpJsonSnippet,
  checkBuildArtifact,
  checkGatewayEndpoints,
  checkSignerAvailability,
  checkSolanaRpc,
  validateSignerEnv,
  type SetupCheck
} from "../src/setup-validation.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const checks: SetupCheck[] = [
  checkBuildArtifact(),
  ...validateSignerEnv(),
  await checkSignerAvailability(),
  await checkSolanaRpc(config.solanaRpc),
  await checkGatewayEndpoints(config.gatewayEndpoints)
];

const failed = checks.filter((check) => !check.ok);

console.log("Molpha MCP setup check\n");
for (const check of checks) {
  const status = check.ok ? "ok" : "FAIL";
  console.log(`[${status}] ${check.name}: ${check.message}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) failed. Fix env vars or key material, then re-run npm run doctor.`);
  process.exit(1);
}

console.log("\nSuggested MCP JSON (Cursor / Claude Desktop):\n");
console.log(buildMcpJsonSnippet());

console.log("Suggested Codex config.toml snippet:\n");
console.log(buildCodexTomlSnippet());

console.log(
  "Next: add the JSON to ~/.cursor/mcp.json or Claude Desktop config, restart the client, and call get_capabilities."
);

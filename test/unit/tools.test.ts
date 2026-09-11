import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/tools/index.js";

interface RegisteredTool {
  name: string;
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function collectTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerTools({
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) => {
      tools.push({ name, config, handler });
    }
  });
  return tools;
}

describe("tool surface", () => {
  const tools = collectTools();

  it("names every tool verb-first, without the molpha_ prefix", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "derive_source_id",
      "describe_feed",
      "execute_agent_round",
      "execute_subscription_round",
      "get_agent_status",
      "get_capabilities",
      "get_latest_value",
      "submit_attestation",
      "verify_attestation"
    ]);
  });

  it("speaks sourceId, never feedId or molpha_-prefixed tool names", () => {
    for (const tool of tools) {
      expect(Object.keys(tool.config.inputSchema)).not.toContain("feedId");
      expect(tool.config.description).not.toMatch(/feedId|molpha_[a-z]/);
    }
  });
});

describe("derive_source_id", () => {
  const derive = collectTools().find((tool) => tool.name === "derive_source_id")!;

  async function call(apiConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await derive.handler({ apiConfig });
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  it("matches the SDK/node sourceId vector without any wallet configured", async () => {
    const out = await call({ url: "https://api.example.com/price", responseParser: "$.price" });

    expect(out.sourceId).toBe("0x2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582");
    expect(out.canonicalJson).toBe(
      '{"url":"https://api.example.com/price","method":"GET","headers":{},"responseParser":"$.price","valueTransform":""}'
    );
  });

  it("is independent of header insertion order", async () => {
    const base = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" };
    const a = await call({ ...base, headers: { "Z-Header": "z", "A-Header": "a" } });
    const b = await call({ ...base, headers: { "A-Header": "a", "Z-Header": "z" } });

    expect(a.sourceId).toBe(b.sourceId);
    expect(a.canonicalJson).toContain('"headers":{"A-Header":"a","Z-Header":"z"}');
  });

  it("states the derivation, and that it is not JCS, in its description", () => {
    expect(derive.config.description).toContain("keccak256");
    expect(derive.config.description).toContain("url, method, headers, responseParser, valueTransform");
    expect(derive.config.description).toContain("not RFC 8785 (JCS)");
  });
});

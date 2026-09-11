import { registerDeriveSourceIdTool } from "./derive_source_id.js";
import { registerDescribeFeedTool } from "./describe_feed.js";
import { registerExecuteAgentRoundTool } from "./execute_agent_round.js";
import { registerExecuteSubscriptionRoundTool } from "./execute_subscription_round.js";
import { registerGetAgentStatusTool } from "./get_agent_status.js";
import { registerGetCapabilitiesTool } from "./get_capabilities.js";
import { registerGetLatestValueTool } from "./get_latest_value.js";
import { registerSubmitAttestationTool } from "./submit_attestation.js";
import { registerVerifyAttestationTool } from "./verify_attestation.js";
import { type ToolServer } from "./types.js";

export function registerTools(server: ToolServer): void {
  registerGetCapabilitiesTool(server);
  registerDeriveSourceIdTool(server);
  registerDescribeFeedTool(server);
  registerGetLatestValueTool(server);
  registerGetAgentStatusTool(server);
  registerExecuteSubscriptionRoundTool(server);
  registerExecuteAgentRoundTool(server);
  registerVerifyAttestationTool(server);
  registerSubmitAttestationTool(server);
}

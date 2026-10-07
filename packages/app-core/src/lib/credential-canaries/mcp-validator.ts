import {
  type ControlledMcpRequest,
  controlledMcpResponse,
  validateControlledMcpRequest,
} from "./mcp-protocol.js";
/** Registry-bound MCP adapter; the portable wire validator is independent of vault storage. */
import { observeControlledIdentifier } from "./observe.js";
import type { CanaryArtifact } from "./protocol.js";
export {
  parseControlledMcpRequest,
  validateControlledMcpRequest,
  controlledMcpResponse,
} from "./mcp-protocol.js";
export type { ControlledMcpRequest } from "./mcp-protocol.js";
export async function handleControlledMcpRequest(
  binding: { tomb: string; artifact: CanaryArtifact },
  request: ControlledMcpRequest,
) {
  if (new TextEncoder().encode(JSON.stringify(request)).length > 4096)
    throw new Error("Canary request exceeds limit.");
  if (binding.artifact.context.kind !== "mcp_configuration")
    throw new Error("A controlled MCP artifact is required.");
  const message = validateControlledMcpRequest(request);
  const phase = message.method === "tools/call" ? "invoked" : "connected";
  const decision = await observeControlledIdentifier({
    ...binding.artifact,
    tomb: binding.tomb,
    phase,
  });
  if (
    decision.kind !== "canary" ||
    decision.response !== "synthetic_readonly" ||
    decision.artifactId !== binding.artifact.id
  )
    throw new Error("Controlled MCP binding unavailable.");
  return controlledMcpResponse(message);
}

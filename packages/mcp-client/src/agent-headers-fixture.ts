import { randomBytes, randomUUID } from "node:crypto";
import { AgentClient, type AgentHeaders } from "@opensesame/agent-client";
import { vi } from "vitest";

/** Handler fixtures use the full transport projection for this MCP audience. */
export function mockAgentHeaders(): void {
  const headers: AgentHeaders = {
    authorization: `Bearer agent-capability:${randomBytes(32).toString("hex")}`,
    "x-opensesame-agent-client": randomUUID(),
    "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-client",
  };
  vi.spyOn(AgentClient.prototype, "headers").mockResolvedValue(headers);
}

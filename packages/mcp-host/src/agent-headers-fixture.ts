import { randomBytes, randomUUID } from "node:crypto";
import { AgentClient, type AgentHeaders } from "@opensesame/agent-client";
import { vi } from "vitest";

/** Only handler fixtures mock acquisition; UDS/launch tests exercise the real client. */
export function mockAgentHeaders(
  token = `agent-capability:${randomBytes(32).toString("hex")}`,
): void {
  const headers: AgentHeaders = {
    authorization: `Bearer ${token}`,
    "x-opensesame-agent-client": randomUUID(),
    "x-opensesame-agent-audience": "urn:opensesame:agent:mcp-host",
  };
  vi.spyOn(AgentClient.prototype, "headers").mockResolvedValue(headers);
}

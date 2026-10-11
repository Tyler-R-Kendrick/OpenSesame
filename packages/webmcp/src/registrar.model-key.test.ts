import { describe, expect, it } from "vitest";
import type { WebMcpToolDescriptor } from "./detect.js";
import { createWebMcpRegistrar } from "./registrar.js";

describe("createWebMcpRegistrar and a model key (ADR 0188)", () => {
  it("refuses a result that carries a model key and never echoes it", async () => {
    const registered: WebMcpToolDescriptor[] = [];
    const api = {
      registerTool: (tool: WebMcpToolDescriptor) => void registered.push(tool),
    };
    const modelKey = `osk_${"A".repeat(43)}`;
    createWebMcpRegistrar(api, { appId: "pages" }).register([
      {
        name: "opensesame_status",
        description: "status",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ note: `issued ${modelKey}` }),
      },
    ]);
    const tool = registered[0];
    if (!tool) throw new Error("registration missing");
    const result = await tool.execute({});
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "secret_in_agent_payload" }],
    });
    expect(JSON.stringify(result)).not.toContain(modelKey);
  });
});

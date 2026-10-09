import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { PASSWORD_WORKFLOW_RESOURCE } from "./password-workflow-resource.js";
import { buildServer } from "./server.js";

it("discovers real human workflow handoffs over MCP without a secret tool or Host request", async () => {
  const server = buildServer({ hostUrl: "http://127.0.0.1:8787" });
  const client = new Client({ name: "workflow-guide-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      PASSWORD_WORKFLOW_RESOURCE,
    );
    const resource = await client.readResource({
      uri: PASSWORD_WORKFLOW_RESOURCE,
    });
    const content = resource.contents[0];
    const text = content && "text" in content ? content.text : undefined;
    const guide = z
      .object({
        actions: z.array(z.object({ action: z.string() })),
        custody: z.string(),
        discovery: z.string(),
      })
      .parse(JSON.parse(z.string().parse(text)));
    expect(guide.actions.map((action) => action.action)).toEqual([
      "create",
      "compare",
      "update",
      "read",
      "env-resolve",
    ]);
    expect(guide.custody).toContain("cannot read or approve");
    expect(guide.discovery).toContain("selected sign-in method");
    expect(guide.discovery).toContain("not downgraded into stored passwords");
    expect(
      (await client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain("read_password");
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

import { describe, expect, it } from "vitest";
import type { ModelContextApi } from "./detect.js";
import * as webmcp from "./index.js";
import { createWebMcpRegistrar, listRegisteredTools } from "./registrar.js";

/**
 * The package's exported surface is a security boundary: a caller that can
 * discover WebMCP tools must not, by that fact, be able to run one. These
 * assertions fail the moment an execution pass-through is added, which is the
 * only enforcement an in-page tutorial agent can rely on — it consumes this
 * barrel and nothing else.
 */
describe("package surface", () => {
  const exported = Object.keys(webmcp).sort();

  it("exports exactly the detection, fence, registration and discovery entry points", () => {
    expect(exported).toEqual([
      "AgentPayloadRefused",
      "REDACTED",
      "createWebMcpRegistrar",
      "detectModelContext",
      "fenceForAgent",
      "forAgent",
      "listRegisteredTools",
      "looksLikeCredential",
      "scrubLocalSecrets",
      "toolDisposition",
    ]);
  });

  it("exports no generic tool-execution function", () => {
    expect(exported).not.toContain("executeTool");
    expect(
      exported.filter((name) => /execute|invoke|call|run/i.test(name)),
    ).toEqual([]);
  });

  it("keeps executeTool unreachable when the browser implements it", () => {
    const executed: string[] = [];
    const api: ModelContextApi = {
      source: "document",
      getTools: () => [{ name: "opensesame_status", description: "status" }],
      executeTool: (name) => {
        executed.push(name);
        return null;
      },
    };
    const summaries = listRegisteredTools(api);
    expect(summaries.map((summary) => summary.name)).toEqual([
      "opensesame_status",
    ]);
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
      ]);
    }
    expect(executed).toEqual([]);
  });

  it("gives the registrar no surface beyond register", () => {
    const registrar = createWebMcpRegistrar(null, { appId: "pages" });
    expect(Object.keys(registrar)).toEqual(["register"]);
  });
});

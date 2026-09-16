/** @vitest-environment jsdom */

import { fakeSupportPageContext } from "@opensesame/support-agent";
import { describe, expect, it, vi } from "vitest";
import { modelProviderRecord } from "../../../lib/model-provider.js";
import {
  createProviderSupportAgent,
  readLocalSupportProvider,
} from "./provider-agent.js";

describe("readLocalSupportProvider", () => {
  it("accepts loopback local providers only", () => {
    expect(
      readLocalSupportProvider(
        modelProviderRecord({
          kind: "local",
          provider: "ollama",
          endpoint: "http://127.0.0.1:11434",
          model: "llama3.2",
        }),
      ),
    ).not.toBeNull();
    expect(
      readLocalSupportProvider(
        modelProviderRecord({
          kind: "hosted",
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o",
        }),
      ),
    ).toBeNull();
    expect(
      readLocalSupportProvider(
        modelProviderRecord({
          kind: "local",
          provider: "ollama",
          endpoint: "https://evil.example",
          model: "llama3.2",
        }),
      ),
    ).toBeNull();
  });
});

describe("createProviderSupportAgent", () => {
  it("reports ready and answers through the OpenAI-shaped chat route", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Lock is in the sidebar." } }],
      }),
    );
    const agent = createProviderSupportAgent({
      record: modelProviderRecord({
        kind: "local",
        provider: "lmstudio",
        endpoint: "http://127.0.0.1:1234/v1",
        model: "qwen",
      }),
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(agent).not.toBeNull();
    expect(await agent?.availability()).toEqual({ kind: "ready" });
    const turn = await agent?.run(
      {
        question: "where is lock",
        history: [],
        context: fakeSupportPageContext(),
      },
      { signal: new AbortController().signal },
    );
    expect(turn).toBeDefined();
    expect(turn?.answer).toContain("Lock is in the sidebar");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/chat/completions",
      expect.anything(),
    );
  });
});

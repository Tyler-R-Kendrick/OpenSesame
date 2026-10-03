/** @vitest-environment jsdom */

import { overlapCast } from "@opensesame/os-domain";
import type { SupportRequest } from "@opensesame/support-agent";
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
      fetch: overlapCast(fetchImpl),
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

  it("refuses redirects so the loopback endpoint cannot relay the chat off-machine", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: { content: "Lock is in the sidebar." } }),
    );
    const agent = createProviderSupportAgent({
      record: modelProviderRecord({
        kind: "local",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "llama3.2",
      }),
      fetch: overlapCast(fetchImpl),
    });
    if (agent === null) throw new Error("expected a provider agent");
    await agent.run(
      {
        question: "where is lock",
        history: [],
        context: fakeSupportPageContext(),
      },
      { signal: new AbortController().signal },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
  });

  it("destroy() aborts every in-flight run, not just the most recent", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    const agent = createProviderSupportAgent({
      record: modelProviderRecord({
        kind: "local",
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "llama3.2",
      }),
      fetch: overlapCast(fetchImpl),
    });
    if (agent === null) throw new Error("expected a provider agent");
    const request: SupportRequest = {
      question: "where is lock",
      history: [],
      context: fakeSupportPageContext(),
    };

    const first = agent.run(request, {
      signal: new AbortController().signal,
    });
    const second = agent.run(request, {
      signal: new AbortController().signal,
    });
    agent.destroy();

    await expect(first).rejects.toMatchObject({ code: "AGENT_ABORTED" });
    await expect(second).rejects.toMatchObject({ code: "AGENT_ABORTED" });
  });
});

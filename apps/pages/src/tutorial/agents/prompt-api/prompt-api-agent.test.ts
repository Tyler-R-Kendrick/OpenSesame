/** @vitest-environment jsdom */

import { isNumber, isString } from "@opensesame/os-domain";
import type {
  SupportPageContext,
  SupportRequest,
  SupportTurn,
} from "@opensesame/support-agent";
import {
  SupportError,
  buildSupportInstructions,
} from "@opensesame/support-agent";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  LocalLanguageModelApi,
  LocalModelAvailabilityState,
  LocalModelCreateOptions,
} from "./detect.js";
import {
  acquireLocalModel,
  acquirePromptApiModel,
  createPromptApiAgent,
  createPromptApiSupportAgent,
  resetLocalModelDownloadProgressForTest,
} from "./prompt-api-agent.js";

type PromptHandler = (input: string, signal: AbortSignal) => Promise<string>;

/** Holds the resolver of a prompt that answers after the caller gave up. */
type LateAnswerGate = { release: ((answer: string) => void) | null };

type FakeModelState = {
  state: LocalModelAvailabilityState;
  /** Availability the model reports once a session has been created. */
  stateAfterCreate: LocalModelAvailabilityState | null;
  downloads: number[];
  createFailure: Error | null;
  onPrompt: PromptHandler;
  creates: LocalModelCreateOptions[];
  prompts: string[];
  destroys: number;
};

type FakeModel = FakeModelState & { api: LocalLanguageModelApi };

function createFakeModel(overrides: Partial<FakeModelState> = {}): FakeModel {
  const model: FakeModelState = {
    state: "available",
    stateAfterCreate: null,
    downloads: [],
    createFailure: null,
    onPrompt: () => Promise.resolve("An answer."),
    creates: [],
    prompts: [],
    destroys: 0,
    ...overrides,
  };
  const api: LocalLanguageModelApi = {
    availability: () => Promise.resolve(model.state),
    create: (options) => {
      model.creates.push(options);
      const monitor = options.monitor;
      if (monitor !== null) {
        for (const fraction of model.downloads) monitor(fraction);
      }
      if (model.createFailure !== null) {
        return Promise.reject(model.createFailure);
      }
      if (model.stateAfterCreate !== null) model.state = model.stateAfterCreate;
      return Promise.resolve({
        prompt: (
          input: string,
          promptOptions: { readonly signal: AbortSignal },
        ) => {
          model.prompts.push(input);
          return model.onPrompt(input, promptOptions.signal);
        },
        destroy: () => {
          model.destroys += 1;
        },
      });
    },
  };
  return Object.assign(model, { api });
}

const pageContext: SupportPageContext = {
  version: 1,
  pageId: "pages",
  route: "route.connections",
  targets: [
    {
      id: "nav.connections",
      description: "Opens the Connections screen.",
      role: "navigation",
      mounted: true,
    },
  ],
  routes: [{ id: "route.connections", title: "Connections" }],
  state: [{ id: "state.vault-unlocked", value: true }],
  capabilities: [
    { id: "connection.create", title: "Create a connection", available: true },
  ],
  goals: [{ id: "connection.create", title: "Add a connection" }],
};

function makeRequest(question = "How do I add a connection?"): SupportRequest {
  return {
    question,
    history: [
      { role: "user", text: "Where am I?" },
      { role: "assistant", text: "On the Connections screen." },
    ],
    context: pageContext,
  };
}

function live(): AbortSignal {
  return new AbortController().signal;
}

async function failureCode(promise: Promise<SupportTurn>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (cause) {
    return cause instanceof SupportError ? cause.code : "not-a-support-error";
  }
}

function outboundText(model: FakeModel): string {
  const instructions = model.creates
    .flatMap((options) => options.initialPrompts.map((entry) => entry.content))
    .join("\n");
  return `${instructions}\n${model.prompts.join("\n")}`;
}

beforeEach(() => {
  resetLocalModelDownloadProgressForTest();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("createPromptApiSupportAgent without a platform model", () => {
  it("reports no_local_model when the browser has no LanguageModel", async () => {
    const agent = createPromptApiSupportAgent();
    expect(await agent.availability()).toEqual({
      kind: "unavailable",
      reason: "no_local_model",
    });
  });

  it("refuses to run, and cannot touch a platform that is not there", async () => {
    const agent = createPromptApiSupportAgent({ api: null });
    expect(
      await failureCode(agent.run(makeRequest(), { signal: live() })),
    ).toBe("AGENT_UNAVAILABLE");
  });
});

describe("availability mapping", () => {
  it("maps every platform state onto the support contract", async () => {
    const model = createFakeModel({ state: "unavailable" });
    const agent = createPromptApiSupportAgent({ api: model.api });
    expect(await agent.availability()).toEqual({
      kind: "unavailable",
      reason: "platform_unsupported",
    });

    model.state = "downloadable";
    expect(await agent.availability()).toEqual({ kind: "downloadable" });

    model.state = "available";
    expect(await agent.availability()).toEqual({ kind: "ready" });
  });

  it("reports downloading with the fraction the platform last emitted", async () => {
    const model = createFakeModel({
      state: "downloading",
      downloads: [0.1, 0.42],
    });
    const agent = createPromptApiSupportAgent({ api: model.api });
    const before = await agent.availability();
    expect(before.kind).toBe("downloading");
    expect(before.kind === "downloading" && isNumber(before.progress)).toBe(
      true,
    );

    await acquireLocalModel({ api: model.api });
    expect(await agent.availability()).toEqual({
      kind: "downloading",
      progress: 0.42,
    });
  });
});

describe("the user gesture that acquires the model", () => {
  it("refuses to run while the model is only downloadable, then runs once acquired", async () => {
    const model = createFakeModel({
      state: "downloadable",
      stateAfterCreate: "available",
      downloads: [0.5, 1],
    });
    const agent = createPromptApiSupportAgent({ api: model.api });

    expect(
      await failureCode(agent.run(makeRequest(), { signal: live() })),
    ).toBe("AGENT_UNAVAILABLE");
    expect(model.creates).toHaveLength(0);

    const seen: number[] = [];
    const acquired = await acquireLocalModel({
      api: model.api,
      onDownloadProgress: (progress) => seen.push(progress),
    });
    expect(acquired).toEqual({ kind: "ready" });
    expect(seen).toEqual([0.5, 1]);

    const turn = await agent.run(makeRequest(), { signal: live() });
    expect(isString(turn.answer)).toBe(true);
  });

  it("reports an acquisition that fails as a model that is not downloaded", async () => {
    const model = createFakeModel({
      state: "downloadable",
      createFailure: new Error("download refused"),
    });
    expect(await acquireLocalModel({ api: model.api })).toEqual({
      kind: "unavailable",
      reason: "model_not_downloaded",
    });
  });

  it("does not download when the platform cannot run a model at all", async () => {
    const model = createFakeModel({ state: "unavailable" });
    expect(await acquireLocalModel({ api: model.api })).toEqual({
      kind: "unavailable",
      reason: "platform_unsupported",
    });
    expect(model.creates).toHaveLength(0);
  });
});

describe("aborting a run", () => {
  it("rejects with AGENT_ABORTED and discards the late platform answer", async () => {
    const gate: LateAnswerGate = { release: null };
    const pending = new Promise<string>((resolve) => {
      gate.release = resolve;
    });
    const model = createFakeModel({ onPrompt: () => pending });
    const agent = createPromptApiSupportAgent({ api: model.api });
    const controller = new AbortController();

    const running = agent.run(makeRequest(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    expect(await failureCode(running)).toBe("AGENT_ABORTED");

    gate.release?.("A stale answer that arrived after the person gave up.");
    await pending;

    // The abort cancelled the request, not the session.
    expect(model.destroys).toBe(0);

    model.onPrompt = () => Promise.resolve("A fresh answer.");
    const turn = await agent.run(makeRequest(), { signal: live() });
    expect(turn.answer).toContain("fresh");
    expect(turn.answer).not.toContain("stale");
    expect(model.creates).toHaveLength(1);
  });

  it("rejects before prompting when the signal is already aborted", async () => {
    const model = createFakeModel();
    const agent = createPromptApiSupportAgent({ api: model.api });
    const controller = new AbortController();
    controller.abort();
    expect(
      await failureCode(
        agent.run(makeRequest(), { signal: controller.signal }),
      ),
    ).toBe("AGENT_ABORTED");
    expect(model.prompts).toHaveLength(0);
  });
});

describe("a session that runs out of context", () => {
  function quotaError(): Error {
    const error = new Error("The session is full.");
    error.name = "QuotaExceededError";
    return error;
  }

  it("recreates the session exactly once and answers from the fresh one", async () => {
    let calls = 0;
    const model = createFakeModel({
      onPrompt: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(quotaError())
          : Promise.resolve("An answer from the fresh session.");
      },
    });
    const agent = createPromptApiSupportAgent({ api: model.api });
    const turn = await agent.run(makeRequest(), { signal: live() });
    expect(turn.answer).toContain("fresh session");
    expect(model.creates).toHaveLength(2);
    expect(model.destroys).toBe(1);
  });

  it("gives up with AGENT_PROTOCOL_ERROR when the fresh session fails too", async () => {
    const model = createFakeModel({
      onPrompt: () => Promise.reject(quotaError()),
    });
    const agent = createPromptApiSupportAgent({ api: model.api });
    expect(
      await failureCode(agent.run(makeRequest(), { signal: live() })),
    ).toBe("AGENT_PROTOCOL_ERROR");
    expect(model.creates).toHaveLength(2);
  });

  it("does not recreate the session for an unrelated failure", async () => {
    const model = createFakeModel({
      onPrompt: () => Promise.reject(new Error("the model crashed")),
    });
    const agent = createPromptApiSupportAgent({ api: model.api });
    expect(
      await failureCode(agent.run(makeRequest(), { signal: live() })),
    ).toBe("AGENT_PROTOCOL_ERROR");
    expect(model.creates).toHaveLength(1);
  });
});

describe("model output that is not what we asked for", () => {
  const malformed: readonly string[] = [
    "Open Connections from the sidebar. There is no program here.",
    'Here you go:\n\n```guide\nguide/1\nclick "nav.connections"\n```',
    "",
  ];

  it("returns a support turn for prose, a broken guide and an empty answer", async () => {
    for (const raw of malformed) {
      const model = createFakeModel({ onPrompt: () => Promise.resolve(raw) });
      const agent = createPromptApiSupportAgent({ api: model.api });
      const turn = await agent.run(makeRequest(), { signal: live() });
      expect(isString(turn.answer)).toBe(true);
      expect(Array.isArray(turn.suggestedQuestions)).toBe(true);
    }
  });
});

describe("the session lifecycle", () => {
  it("destroys the platform session and recreates cleanly on the next run", async () => {
    const model = createFakeModel();
    const agent = createPromptApiSupportAgent({ api: model.api });

    await agent.run(makeRequest(), { signal: live() });
    expect(model.creates).toHaveLength(1);

    agent.destroy();
    expect(model.destroys).toBe(1);

    await agent.run(makeRequest(), { signal: live() });
    expect(model.creates).toHaveLength(2);
    expect(model.destroys).toBe(1);
  });

  it("reuses one session across turns on the same page", async () => {
    const model = createFakeModel();
    const agent = createPromptApiSupportAgent({ api: model.api });
    await agent.run(makeRequest(), { signal: live() });
    await agent.run(makeRequest("And how do I remove one?"), {
      signal: live(),
    });
    expect(model.creates).toHaveLength(1);
    expect(model.prompts).toHaveLength(2);
  });
});

describe("what actually leaves the device", () => {
  it("sends the policy instructions and the authored page context", async () => {
    const model = createFakeModel();
    const agent = createPromptApiSupportAgent({ api: model.api });
    await agent.run(makeRequest(), { signal: live() });

    const outbound = outboundText(model);
    expect(outbound).toContain(buildSupportInstructions(pageContext));
    expect(outbound).toContain("nav.connections");
    expect(outbound).toContain("route.connections");
    expect(outbound).toContain("How do I add a connection?");
    expect(outbound).toContain("On the Connections screen.");
    expect(model.prompts.every((entry) => isString(entry))).toBe(true);
  });

  it("never carries page text or stored values the context did not authorize", async () => {
    document.body.innerHTML =
      "<p>correct-horse-battery-staple</p><input value='4111111111111111'>";
    localStorage.setItem("os.vault", "stored-secret-value");

    const model = createFakeModel();
    const agent = createPromptApiSupportAgent({ api: model.api });
    await agent.run(makeRequest(), { signal: live() });

    const outbound = outboundText(model);
    expect(outbound).not.toContain("correct-horse-battery-staple");
    expect(outbound).not.toContain("4111111111111111");
    expect(outbound).not.toContain("stored-secret-value");
    expect(outbound).not.toContain("os.vault");
  });
});

describe("the surface the support session binds to", () => {
  it("answers null when the browser has no built-in model", () => {
    expect(createPromptApiAgent({ api: null })).toBeNull();
  });

  it("answers an agent when a model is present but not yet downloaded", async () => {
    const model = createFakeModel({ state: "downloadable" });
    const agent = createPromptApiAgent({ api: model.api });
    expect(agent).not.toBeNull();
    expect(await agent?.availability()).toEqual({ kind: "downloadable" });
  });

  it("acquires the model, reporting progress, and throws when it cannot", async () => {
    const ready = createFakeModel({
      state: "downloadable",
      stateAfterCreate: "available",
      downloads: [0.75],
    });
    const seen: number[] = [];
    await acquirePromptApiModel((progress) => seen.push(progress), {
      api: ready.api,
    });
    expect(seen).toEqual([0.75]);

    const refused = createFakeModel({ state: "unavailable" });
    await expect(
      acquirePromptApiModel(() => {}, { api: refused.api }),
    ).rejects.toBeInstanceOf(SupportError);
  });
});

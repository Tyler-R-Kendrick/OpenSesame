import { describe, expect, it } from "vitest";
import {
  SupportError,
  type SupportRequest,
  type SupportRunOptions,
} from "./contract.js";
import {
  createFakeSupportAgent,
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentDownloadable,
  fakeAgentDownloading,
  fakeAgentFailing,
  fakeAgentHanging,
  fakeAgentReplanning,
  fakeSupportPageContext,
} from "./fake.js";

function ask(question: string): SupportRequest {
  return { question, history: [], context: fakeSupportPageContext() };
}

const OPEN: SupportRunOptions = { signal: new AbortController().signal };

describe("createFakeSupportAgent", () => {
  it("matches a rule by substring, case-insensitively", async () => {
    const agent = createFakeSupportAgent({
      rules: [{ match: "connection", answer: "Open Connections." }],
      fallback: { match: /.*/, answer: "I do not know." },
    });
    expect((await agent.run(ask("Add a CONNECTION?"), OPEN)).answer).toBe(
      "Open Connections.",
    );
  });

  it("matches a rule by pattern", async () => {
    const agent = createFakeSupportAgent({
      rules: [{ match: /^unlock/i, answer: "Use the vault key." }],
      fallback: { match: /.*/, answer: "I do not know." },
    });
    expect((await agent.run(ask("Unlock this"), OPEN)).answer).toBe(
      "Use the vault key.",
    );
    expect((await agent.run(ask("Something else"), OPEN)).answer).toBe(
      "I do not know.",
    );
  });

  it("falls back to a built-in refusal when the script has no default", async () => {
    const agent = createFakeSupportAgent({});
    expect((await agent.run(ask("anything"), OPEN)).answer).toContain(
      "not have enough of this page's context",
    );
  });

  it("records every request it was handed", async () => {
    const agent = createFakeSupportAgent({});
    await agent.run(ask("first"), OPEN);
    await agent.run(ask("second"), OPEN);
    expect(agent.calls().map((call) => call.question)).toEqual([
      "first",
      "second",
    ]);
  });

  it("returns the guide the script attached, valid or not", async () => {
    const agent = fakeAgentAnswering("Answer.", 'click "#x"');
    const turn = await agent.run(ask("anything"), OPEN);
    expect(turn.guide).toBe('click "#x"');
    expect(turn.answer).toBe("Answer.");
  });

  it("reports an unavailable model", async () => {
    const agent = fakeAgentAlwaysUnavailable("model_not_downloaded");
    expect(await agent.availability()).toEqual({
      kind: "unavailable",
      reason: "model_not_downloaded",
    });
  });

  it("reports downloadable and downloading", async () => {
    expect(await fakeAgentDownloadable().availability()).toEqual({
      kind: "downloadable",
    });
    expect(await fakeAgentDownloading(0.4).availability()).toEqual({
      kind: "downloading",
      progress: 0.4,
    });
  });

  it("lets a rule change availability as a side effect of a run", async () => {
    const agent = createFakeSupportAgent({
      rules: [
        {
          match: "download",
          answer: "Starting.",
          availability: { kind: "downloading", progress: 0.1 },
        },
      ],
    });
    expect(await agent.availability()).toEqual({ kind: "ready" });
    await agent.run(ask("download the model"), OPEN);
    expect(await agent.availability()).toEqual({
      kind: "downloading",
      progress: 0.1,
    });
  });

  it("rejects with a scripted protocol error", async () => {
    const agent = fakeAgentFailing("AGENT_PROTOCOL_ERROR");
    await expect(agent.run(ask("anything"), OPEN)).rejects.toBeInstanceOf(
      SupportError,
    );
  });

  it("hangs until the caller aborts, then rejects as aborted", async () => {
    const agent = fakeAgentHanging();
    const controller = new AbortController();
    const pending = agent.run(ask("anything"), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "AGENT_ABORTED" });
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = createFakeSupportAgent({});
    await expect(
      agent.run(ask("anything"), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "AGENT_ABORTED" });
  });

  it("walks a replan sequence and repeats its last step", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Step one.", guide: "guide/1" },
      { answer: "Step two." },
    ]);
    expect((await agent.run(ask("go"), OPEN)).answer).toBe("Step one.");
    expect((await agent.run(ask("go"), OPEN)).answer).toBe("Step two.");
    expect((await agent.run(ask("go"), OPEN)).answer).toBe("Step two.");
  });

  it("stops answering once destroyed", async () => {
    const agent = createFakeSupportAgent({});
    expect(agent.destroyed()).toBe(false);
    agent.destroy();
    expect(agent.destroyed()).toBe(true);
    expect(await agent.availability()).toEqual({
      kind: "unavailable",
      reason: "no_local_model",
    });
    await expect(agent.run(ask("anything"), OPEN)).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
  });

  it("takes an availability override after construction", async () => {
    const agent = createFakeSupportAgent({});
    agent.setAvailability({ kind: "unavailable", reason: "vault_locked" });
    expect(await agent.availability()).toEqual({
      kind: "unavailable",
      reason: "vault_locked",
    });
  });
});

describe("fakeSupportPageContext", () => {
  it("is a fresh, registry-flavoured context every time", () => {
    const first = fakeSupportPageContext();
    const second = fakeSupportPageContext();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(first.targets.map((target) => target.id)).toContain(
      "nav.connections",
    );
    expect(first.state.map((fact) => fact.id)).toContain("vault.unlocked");
  });
});

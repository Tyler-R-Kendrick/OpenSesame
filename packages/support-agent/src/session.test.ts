import { describe, expect, it } from "vitest";
import type {
  SupportAgentAvailability,
  SupportAgentPort,
  SupportPageContext,
  SupportTurn,
} from "./contract.js";
import {
  createFakeSupportAgent,
  fakeAgentAlwaysUnavailable,
  fakeAgentFailing,
  fakeSupportPageContext,
} from "./fake.js";
import {
  type SupportSessionSnapshot,
  createSupportSession,
} from "./session.js";
import { supportVocabulary } from "./turn.js";

const CONTEXT: SupportPageContext = fakeSupportPageContext();
const VOCABULARY = supportVocabulary(CONTEXT);

function readContext(): SupportPageContext {
  return CONTEXT;
}

/** Drains the microtask queue so a pending `ask` reaches the port. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

type Deferred = (turn: SupportTurn) => void;

/** A port whose answers the test releases by hand, one at a time. */
function gatedPort(gate: Deferred[]): SupportAgentPort {
  return {
    availability(): Promise<SupportAgentAvailability> {
      return Promise.resolve({ kind: "ready" });
    },
    run(): Promise<SupportTurn> {
      return new Promise<SupportTurn>((resolve) => {
        gate.push(resolve);
      });
    },
    destroy(): void {},
  };
}

describe("createSupportSession", () => {
  it("records the question and the answer in order", async () => {
    const session = createSupportSession({
      port: createFakeSupportAgent({
        fallback: { match: /.*/, answer: "Open Connections from the sidebar." },
      }),
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.messages()).toEqual([
      { role: "user", text: "How do I add a connection?" },
      { role: "assistant", text: "Open Connections from the sidebar." },
    ]);
    expect(session.snapshot().status).toBe("idle");
    expect(session.snapshot().error).toBeNull();
  });

  it("ignores an empty question", async () => {
    const agent = createFakeSupportAgent({});
    const session = createSupportSession({
      port: agent,
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("   ");
    expect(session.messages()).toEqual([]);
    expect(agent.calls()).toHaveLength(0);
  });

  it("discards a superseded answer that arrives late", async () => {
    const gate: Deferred[] = [];
    const session = createSupportSession({
      port: gatedPort(gate),
      vocabulary: VOCABULARY,
      readContext,
    });

    const first = session.ask("one");
    await settle();
    expect(gate).toHaveLength(1);

    const second = session.ask("two");
    await settle();
    expect(gate).toHaveLength(2);

    gate[1]?.({ answer: "second answer", guide: null, suggestedQuestions: [] });
    await second;
    gate[0]?.({ answer: "first answer", guide: null, suggestedQuestions: [] });
    await first;

    expect(session.messages().map((message) => message.text)).toEqual([
      "one",
      "two",
      "second answer",
    ]);
    expect(session.snapshot().status).toBe("idle");
  });

  it("drops the answer to a cancelled ask", async () => {
    const gate: Deferred[] = [];
    const session = createSupportSession({
      port: gatedPort(gate),
      vocabulary: VOCABULARY,
      readContext,
    });
    const pending = session.ask("one");
    await settle();
    session.cancel();
    gate[0]?.({ answer: "too late", guide: null, suggestedQuestions: [] });
    await pending;
    expect(session.messages().map((message) => message.text)).toEqual(["one"]);
    expect(session.snapshot().status).toBe("idle");
  });

  it("reports an unavailable agent without inventing an answer", async () => {
    const session = createSupportSession({
      port: fakeAgentAlwaysUnavailable("model_not_downloaded"),
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.snapshot().status).toBe("error");
    expect(session.snapshot().error).toBe("AGENT_UNAVAILABLE");
    expect(session.messages()).toHaveLength(1);
  });

  it("surfaces a transport failure as a code, not as prose", async () => {
    const session = createSupportSession({
      port: fakeAgentFailing("AGENT_PROTOCOL_ERROR"),
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.snapshot().status).toBe("error");
    expect(session.snapshot().error).toBe("AGENT_PROTOCOL_ERROR");
  });

  it("clears the transcript without dropping the provider session", async () => {
    const agent = createFakeSupportAgent({
      fallback: { match: /.*/, answer: "Open Connections." },
    });
    const session = createSupportSession({
      port: agent,
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    session.clear();
    expect(session.messages()).toEqual([]);
    expect(agent.destroyed()).toBe(false);
    expect(session.snapshot().status).toBe("idle");
  });

  it("empties the transcript and destroys the port on destroy", async () => {
    const agent = createFakeSupportAgent({
      fallback: { match: /.*/, answer: "Open Connections." },
    });
    const session = createSupportSession({
      port: agent,
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.messages()).toHaveLength(2);

    session.destroy();
    expect(session.messages()).toEqual([]);
    expect(agent.destroyed()).toBe(true);
    expect(session.snapshot().status).toBe("destroyed");

    await session.ask("still there?");
    expect(session.messages()).toEqual([]);
    expect(session.snapshot().error).toBe("AGENT_UNAVAILABLE");
  });

  it("publishes snapshots until the subscriber unsubscribes", async () => {
    const seen: SupportSessionSnapshot[] = [];
    const session = createSupportSession({
      port: createFakeSupportAgent({
        fallback: { match: /.*/, answer: "Open Connections." },
      }),
      vocabulary: VOCABULARY,
      readContext,
    });
    const unsubscribe = session.subscribe((snapshot) => {
      seen.push(snapshot);
    });
    await session.ask("How do I add a connection?");
    const afterFirst = seen.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(seen.some((snapshot) => snapshot.status === "asking")).toBe(true);

    unsubscribe();
    await session.ask("And how do I remove one?");
    expect(seen).toHaveLength(afterFirst);
  });

  it("carries a compiled program through to the snapshot", async () => {
    const guide = [
      "guide/1",
      'goal "connection.create"',
      'focus "nav.connections" "Open Connections to begin." side=right',
    ].join("\n");
    const session = createSupportSession({
      port: createFakeSupportAgent({
        fallback: { match: /.*/, answer: "Open Connections.", guide },
      }),
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.snapshot().program?.goal).toBe("connection.create");
    expect(session.snapshot().guideError).toBeNull();
  });

  it("keeps the answer when the guide fails to compile", async () => {
    const session = createSupportSession({
      port: createFakeSupportAgent({
        fallback: {
          match: /.*/,
          answer: "Open Connections.",
          guide: ["guide/1", 'goal "connection.create"', 'click "#x"'].join(
            "\n",
          ),
        },
      }),
      vocabulary: VOCABULARY,
      readContext,
    });
    await session.ask("How do I add a connection?");
    expect(session.messages().at(-1)?.text).toBe("Open Connections.");
    expect(session.snapshot().program).toBeNull();
    expect(session.snapshot().guideError?.codes).toContain(
      "unknown_instruction",
    );
  });
});

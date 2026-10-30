import type { JsonValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
/** @vitest-environment-options { "url": "https://support.example.com/app/" } */
import { fakeSupportPageContext } from "@opensesame/support-agent";
import { expect, it } from "vitest";
import { createAgUiSupportAgent } from "./ag-ui-agent.js";
import { readAgUiEndpointUrl } from "./endpoint.js";

async function run(events: readonly JsonValue[]) {
  const endpoint = readAgUiEndpointUrl("https://support.example.com/agui");
  if (!endpoint) throw new Error("fixture endpoint not accepted");
  const agent = createAgUiSupportAgent({
    endpoint,
    approve: async () => true,
    online: () => true,
    transport: async function* () {
      for (const event of events) yield event;
    },
  });
  return agent.run(
    { question: "help", history: [], context: fakeSupportPageContext() },
    { signal: new AbortController().signal },
  );
}

const valid: readonly JsonValue[] = [
  { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "valid" },
  { type: "RUN_FINISHED" },
];

it.each([
  { type: "TEXT_MESSAGE_START", messageId: "m", role: 7 },
  { type: "TEXT_MESSAGE_START", messageId: "m", role: null },
  { type: "TEXT_MESSAGE_START", messageId: "m", role: "tool" },
  { type: "TEXT_MESSAGE_START", messageId: 7, role: "system" },
  { type: "TEXT_MESSAGE_START", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: 7, delta: "bad" },
  { type: "TEXT_MESSAGE_CONTENT", delta: "bad" },
  { type: "TEXT_MESSAGE_CHUNK", messageId: null, delta: "bad" },
])("rejects malformed text identity and role: %o", async (event) => {
  await expect(run([event, ...valid])).rejects.toMatchObject({
    code: "AGENT_PROTOCOL_ERROR",
  });
});

it("preserves assistant, non-assistant and ID-less chunk behavior", async () => {
  const turn = await run([
    { type: "TEXT_MESSAGE_START", messageId: "sys", role: "system" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "sys", delta: "hidden" },
    { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "visible" },
    { type: "TEXT_MESSAGE_CHUNK", delta: " chunk" },
    { type: "RUN_FINISHED" },
  ]);
  expect(turn.answer).toBe("visible chunk");
});

it("does not accept an untracked system message after the role map fills", async () => {
  const starts: JsonValue[] = Array.from({ length: 256 }, (_, i) => ({
    type: "TEXT_MESSAGE_START",
    messageId: `a${i}`,
    role: "assistant",
  }));
  const turn = await run([
    ...starts,
    { type: "TEXT_MESSAGE_START", messageId: "sys", role: "system" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "sys", delta: "hidden" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a0", delta: "visible" },
    { type: "RUN_FINISHED" },
  ]);
  expect(turn.answer).toBe("visible");
});

it("does not reclassify a non-assistant message as assistant on a repeated ID", async () => {
  const turn = await run([
    { type: "TEXT_MESSAGE_START", messageId: "sys", role: "system" },
    { type: "TEXT_MESSAGE_START", messageId: "sys", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "sys", delta: "hidden" },
    ...valid,
  ]);
  expect(turn.answer).toBe("valid");
});

it("retains a non-assistant role declared on a content event", async () => {
  const turn = await run([
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "sys",
      role: "system",
      delta: "hidden1",
    },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "sys", delta: "hidden2" },
    ...valid,
  ]);
  expect(turn.answer).toBe("valid");
});

import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  forAgent,
  registerAgentSecret,
  scrubLocalSecrets,
} from "../agent-payload.js";

it("refuses scoped credentials and launch handles in model payloads", () => {
  for (const payload of [
    "agent-capability:abc",
    '{"launch_handle":"hidden"}',
    '{"launchHandle":"hidden"}',
  ])
    expect(() => forAgent(payload, {})).toThrow("secret_in_agent_payload");
  const handle = randomBytes(32).toString("hex");
  expect(
    scrubLocalSecrets(`echo ${handle}`, {
      OPENSESAME_AGENT_LAUNCH_HANDLE: handle,
    }),
  ).not.toContain(handle);
});

it("bounds known transient secrets and drops expired redaction entries", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
  const value = randomBytes(32).toString("hex");
  registerAgentSecret(value, Date.now() + 1000);
  expect(forAgent(`echo ${value}`, {})).not.toContain(value);
  for (let index = 1; index < 64; index++)
    registerAgentSecret(randomBytes(32).toString("hex"), Date.now() + 1000);
  expect(() =>
    registerAgentSecret(randomBytes(32).toString("hex"), Date.now() + 1000),
  ).toThrow("budget exceeded");
  vi.advanceTimersByTime(1001);
  expect(forAgent(`echo ${value}`, {})).toContain(value);
  expect(() => registerAgentSecret(value, Date.now() + 300_001)).toThrow(
    "budget exceeded",
  );
  vi.useRealTimers();
});

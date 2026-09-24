import { isFunction } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  forAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./agent-payload.js";

/**
 * agent-payload.ts is a barrel re-exporting the shared observability guards so
 * tools.ts has a single local import surface. These tests pin the wiring: the
 * names tools.ts relies on must keep resolving to the real guards.
 */
describe("agent-payload barrel", () => {
  it("re-exports the working payload guards", () => {
    expect(REDACTED).toBe("[REDACTED]");
    expect(isFunction(forAgent)).toBe(true);
    expect(isFunction(looksLikeCredential)).toBe(true);
    expect(isFunction(scrubLocalSecrets)).toBe(true);
    expect(isFunction(AgentPayloadRefused)).toBe(true);

    expect(looksLikeCredential('{"access_token":"x"}')).toBe(true);
    expect(() => forAgent('{"access_token":"x"}', {})).toThrow(
      AgentPayloadRefused,
    );
    expect(forAgent('{"task_run_id":"t-1"}', {})).toBe('{"task_run_id":"t-1"}');
  });
});

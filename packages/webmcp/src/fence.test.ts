import { describe, expect, it, vi } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  fenceForAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./fence.js";

describe("scrubLocalSecrets", () => {
  it("replaces every occurrence of a configured secret", () => {
    const env = { OPENSESAME_OPERATOR_TOKEN: "tok-abcdef123" };
    expect(scrubLocalSecrets("a tok-abcdef123 b tok-abcdef123", env)).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
  });

  it("ignores secrets shorter than eight characters", () => {
    expect(
      scrubLocalSecrets("short", { OPENSESAME_ACCESS_TOKEN: "short" }),
    ).toBe("short");
  });

  it("scrubs the bare tail of an opaque-session token", () => {
    const env = { OPENSESAME_IDENTITY_TOKEN: "opaque-session:tail-value-1" };
    expect(scrubLocalSecrets("saw tail-value-1", env)).toBe(`saw ${REDACTED}`);
  });

  it("does not throw in a runtime without a process global", () => {
    vi.stubGlobal("process", undefined);
    try {
      expect(scrubLocalSecrets("anything")).toBe("anything");
      expect(fenceForAgent({ ok: true })).toBe('{"ok":true}');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("fenceForAgent", () => {
  it("serializes structured payloads to JSON", () => {
    expect(fenceForAgent({ a: 1 }, {})).toBe('{"a":1}');
    expect(fenceForAgent(undefined, {})).toBe("null");
  });

  it("passes strings through untouched when clean", () => {
    expect(fenceForAgent("all clear", {})).toBe("all clear");
  });

  it("refuses credential-shaped payloads even after scrubbing", () => {
    expect(() => fenceForAgent({ refresh_token: "x" }, {})).toThrow(
      AgentPayloadRefused,
    );
  });
});

describe("looksLikeCredential", () => {
  it("flags marker substrings case-insensitively", () => {
    expect(looksLikeCredential("SECRET://x")).toBe(true);
    expect(looksLikeCredential("ghp_abc")).toBe(true);
    expect(looksLikeCredential("nothing here")).toBe(false);
  });
});

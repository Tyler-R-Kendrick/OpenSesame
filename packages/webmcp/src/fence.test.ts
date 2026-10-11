import { describe, expect, it, vi } from "vitest";
import {
  AgentPayloadRefused,
  REDACTED,
  fenceForAgent,
  looksLikeCredential,
  scrubLocalSecrets,
} from "./fence.js";

/** Synthetic: `osk_` and 43 base64url characters, none of them a real key. */
const MODEL_KEY = `osk_${"A".repeat(43)}`;
const MODEL_KEY_PUNCTUATED = `osk_${"Ab_-".repeat(10)}Ab_`;

describe("scrubLocalSecrets", () => {
  it("replaces every occurrence of a configured secret", () => {
    const env = { OPENSESAME_OPERATOR_TOKEN: "tok-abcdef123" }; // gitleaks:allow -- synthetic security test vector
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

  it("refuses a model key wherever it sits in a structured payload", () => {
    expect(() => fenceForAgent({ note: `key ${MODEL_KEY}` }, {})).toThrow(
      AgentPayloadRefused,
    );
    expect(() => fenceForAgent({ rows: [[MODEL_KEY]] }, {})).toThrow(
      AgentPayloadRefused,
    );
    expect(() => fenceForAgent(MODEL_KEY, {})).toThrow(AgentPayloadRefused);
  });

  it("passes a model key's short preview and a word that holds the prefix", () => {
    expect(fenceForAgent({ preview: "osk_AbCdEfGh" }, {})).toBe(
      '{"preview":"osk_AbCdEfGh"}',
    );
    expect(fenceForAgent("kiosk_mode=on", {})).toBe("kiosk_mode=on");
  });
});

describe("looksLikeCredential", () => {
  it("flags marker substrings case-insensitively", () => {
    expect(looksLikeCredential("SECRET://x")).toBe(true);
    expect(looksLikeCredential("ghp_abc")).toBe(true);
    expect(looksLikeCredential("nothing here")).toBe(false);
  });

  it.each([
    ["bare", MODEL_KEY],
    ["with every base64url character", MODEL_KEY_PUNCTUATED],
    ["in a sentence", `your key is ${MODEL_KEY}; it is shown once`],
    ["in a URL fragment", `https://app.example/keys#ref=${MODEL_KEY}`],
    ["under a DPoP header", `Authorization: DPoP ${MODEL_KEY}`],
    ["glued to a label", `model_key_${MODEL_KEY}`],
  ])("flags a model key %s", (_where, value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it.each([
    ["one character short", `osk_${"A".repeat(42)}`],
    ["a preview", "osk_AbCdEfGh"],
    ["a space inside the run", `osk_${"A".repeat(20)} ${"A".repeat(23)}`],
    ["the prefix in upper case", `OSK_${"A".repeat(43)}`],
    ["a word that holds the prefix", "kiosk_mode=on tabs=3"],
  ])("does not flag %s", (_what, value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});

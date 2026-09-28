import { describe, expect, it } from "vitest";
import spec from "../../../spec/log-scrub/log-scrub.json" with { type: "json" };
import {
  REDACTED,
  describeError,
  isSensitiveKey,
  scrubStrings,
  scrubText,
  scrubValue,
} from "./index.js";

describe("the shared vectors", () => {
  for (const vector of spec.vectors) {
    it(`${vector.rule}: ${JSON.stringify(vector.input).slice(0, 60)}`, () => {
      expect(scrubText(vector.input)).toBe(vector.expect);
    });
  }

  it.each(spec.unchanged)("leaves %j alone", (text) => {
    expect(scrubText(text)).toBe(text);
  });

  it.each(spec.keyVectors)("key $key is sensitive: $sensitive", (vector) => {
    expect(isSensitiveKey(vector.key)).toBe(vector.sensitive);
  });

  it("is idempotent over every vector", () => {
    for (const vector of spec.vectors) {
      const once = scrubText(vector.input);
      expect(scrubText(once)).toBe(once);
    }
  });

  it("uses the spec's marker", () => {
    expect(REDACTED).toBe("[REDACTED]");
  });
});

describe("scrubValue", () => {
  it("censors sensitive keys at any depth and scrubs every string", () => {
    const out = scrubValue({
      user: "ada",
      ctx: { session: { accessToken: "at-1", tokenType: "Bearer" } },
      note: "retry with Authorization: Bearer abc.def.ghi",
      rows: [{ password: "p" }, "https://x.example/cb?code=abc&state=z"],
    });
    expect(out).toEqual({
      user: "ada",
      ctx: { session: { accessToken: REDACTED, tokenType: "Bearer" } },
      note: `retry with Authorization: ${REDACTED}`,
      rows: [
        { password: REDACTED },
        `https://x.example/cb?code=${REDACTED}&state=${REDACTED}`,
      ],
    });
  });

  it("keeps a boolean or null under a secret-named key legible", () => {
    expect(scrubValue({ hasPassword: true, secret: null, token: 5 })).toEqual({
      hasPassword: true,
      secret: null,
      token: REDACTED,
    });
  });

  it("flattens an error and scrubs its message, stack and cause", () => {
    const cause = new Error("upstream https://u:pw@db.internal/x");
    const error = new Error("token=abc123 rejected", { cause });
    const out = scrubValue(error);
    expect(JSON.stringify(out)).not.toMatch(/abc123|pw@/);
    expect(out).toMatchObject({ name: "Error" });
  });

  it("replaces binary, cuts cycles and bounds depth", () => {
    interface Chain {
      self?: Chain;
      next?: Chain;
    }
    const loop: Chain = {};
    loop.self = loop;
    const top: Chain = {};
    let tail = top;
    for (let i = 0; i < 30; i += 1) {
      const link: Chain = {};
      tail.next = link;
      tail = link;
    }
    expect(scrubValue({ bytes: new Uint8Array([1, 2]) }).bytes).toBe(REDACTED);
    expect(scrubValue(loop)).toEqual({ self: "[Circular]" });
    expect(JSON.stringify(scrubValue(top))).toContain(REDACTED);
  });

  it("does not mutate its input", () => {
    const input = { password: "p", nested: { note: "token=abc" } };
    scrubValue(input);
    expect(input).toEqual({ password: "p", nested: { note: "token=abc" } });
  });

  it.each([
    ["a run of word characters", `${"a.".repeat(50_000)}password=x`],
    ["a run of scheme-like text", "a".repeat(100_000)],
    ["many delimiters", "a;b;".repeat(25_000)],
    ["many pairs", "k=v&".repeat(25_000)],
    ["many quoted fields", '"a":"b",'.repeat(12_000)],
    ["unterminated blocks", "-----BEGIN A-----".repeat(5_000)],
  ])("stays linear on %s", (_name, text) => {
    const start = Date.now();
    scrubText(text);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("describeError", () => {
  it("prints an error's stack scrubbed", () => {
    const text = describeError(
      new Error("connect postgres://u:pw@db/x failed"),
    );
    expect(text).not.toContain("pw@");
    expect(text).toContain("failed");
  });

  it("prints a thrown string or object scrubbed", () => {
    expect(describeError("token=abc123")).toBe("token=[REDACTED]");
    expect(describeError({ password: "p", ok: 1 })).toContain(REDACTED);
  });
});

describe("scrubStrings", () => {
  it("scrubs strings and leaves every key's policy to the caller", () => {
    const out = scrubStrings({
      user_code: "ABCD-EFGH",
      note: "sent to https://x.example/cb?code=abc&page=2",
      list: ["token=abc123"],
    });
    expect(out).toEqual({
      user_code: "ABCD-EFGH",
      note: `sent to https://x.example/cb?code=${REDACTED}&page=2`,
      list: [`token=${REDACTED}`],
    });
  });
});

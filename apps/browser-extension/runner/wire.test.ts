import { describe, expect, it } from "vitest";
import { refusalFor } from "./test-support/fake-host";
import {
  MAX_OUTCOME_BYTES,
  answers,
  dom,
  done,
  failed,
  filled,
  frame,
  guard,
  isKnownStep,
  presence,
  redactKnown,
  sealed,
  verified,
} from "./wire";

describe("outcomes", () => {
  it("every constructor builds exactly the shape the Host decodes", () => {
    const cases: [string, ReturnType<typeof done>][] = [
      ["navigate", done()],
      ["fill_credential", filled(true)],
      ["fill_credential", filled(false)],
      ["assert_present", presence("Mismatch")],
      ["verify_login", verified("Indeterminate")],
      ["seal_candidate", sealed(false)],
      ["read_dom_redacted", dom("<p/>", 3)],
      ["screenshot_redacted", frame(new Uint8Array([0, 255]), 3, 2)],
      ["submit", failed("challenge")],
    ];
    for (const [step, outcome] of cases) {
      expect(refusalFor(step, JSON.parse(JSON.stringify(outcome)))).toBeNull();
    }
  });

  it("the fake Host is as strict as the real one, so the check above means something", () => {
    expect(refusalFor("navigate", { outcome: "done", password: "x" })).toEqual([
      422,
      "invalid_outcome",
    ]);
    expect(
      refusalFor("navigate", { outcome: "dom", text: "t", epoch: 1 }),
    ).toEqual([422, "wrong_outcome"]);
    expect(
      refusalFor("seal_candidate", { outcome: "sealed", backed_up: "yes" }),
    ).toEqual([422, "invalid_outcome"]);
  });

  it("knows which outcome answers which step, and that failed answers any", () => {
    expect(answers("navigate", done())).toBe(true);
    expect(answers("assert_present", done())).toBe(false);
    expect(answers("seal_candidate", sealed(true))).toBe(true);
    expect(answers("seal_candidate", failed("transport"))).toBe(true);
    expect(answers("teleport", done())).toBe(false);
    expect(isKnownStep("teleport")).toBe(false);
    expect(isKnownStep("capture_credential")).toBe(true);
  });
});

describe("redactKnown", () => {
  it("replaces a value whole, in its JSON-escaped and entity-escaped forms", () => {
    const value = 'p"a<s>&s';
    const text = `raw ${value} json ${JSON.stringify(value).slice(1, -1)} html p&quot;a&lt;s&gt;&amp;s`;
    expect(redactKnown(text, [value])).toBe(
      "raw [redacted] json [redacted] html [redacted]",
    );
  });

  it("ignores an empty value", () => {
    expect(redactKnown("text", [""])).toBe("text");
  });
});

describe("guard", () => {
  it("replaces an answer that does not answer the step", () => {
    expect(guard("assert_present", done(), [])).toEqual(failed("transport"));
  });

  it("replaces a dom that still holds a value the runner knows", () => {
    expect(
      guard("read_dom_redacted", dom("has hunter2 in it", 1), ["hunter2"]),
    ).toEqual(failed("transport"));
    expect(guard("read_dom_redacted", dom("clean", 1), ["hunter2"])).toEqual(
      dom("clean", 1),
    );
  });

  it("does not mistake a short password for the structure of an outcome", () => {
    expect(guard("navigate", done(), ["one", "out", "done"])).toEqual(done());
  });

  it("replaces an outcome over the Host's bound", () => {
    const big = frame(new Uint8Array(MAX_OUTCOME_BYTES / 2), 1, 1);
    expect(guard("screenshot_redacted", big, [])).toEqual(failed("transport"));
  });
});

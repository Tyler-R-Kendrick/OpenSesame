/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { SopsError } from "./errors.js";
import {
  DEFAULT_POLICY,
  assertPolicyValid,
  matchRe2,
  shouldBeEncrypted,
} from "./selectors.js";

const policy = (patch: Partial<typeof DEFAULT_POLICY>) => ({
  ...DEFAULT_POLICY,
  ...patch,
});

describe("SB-046 the selector regex engine is a bounded Go/RE2 subset", () => {
  it("accepts the syntax RE2 and this engine agree on", () => {
    expect(matchRe2("^secret$", "secret")).toBe(true);
    expect(matchRe2("^(pw|token)$", "token")).toBe(true);
    expect(matchRe2("[a-z]+_key", "api_key")).toBe(true);
    expect(matchRe2("a{2,3}", "aaa")).toBe(true);
    expect(matchRe2("\\d+", "42")).toBe(true);
    expect(matchRe2("(?:non|capturing)", "non")).toBe(true);
    expect(matchRe2("^secret$", "not-secret")).toBe(false);
  });

  it("refuses syntax RE2 does not have, rather than guessing a JavaScript meaning", () => {
    for (const pattern of [
      "(?=secret)",
      "(?!secret)",
      "(?<=a)b",
      "(?<!a)b",
      "(?P<name>x)",
      "(?<name>x)",
      "(?i)secret",
      "(a)\\1",
      "\\k<name>",
      "\\pL+",
      "[[:alpha:]]",
      "\\Qliteral\\E",
      "\\Astart",
      "\\x{1F600}",
    ]) {
      expect(() => matchRe2(pattern, "secret"), pattern).toThrow(SopsError);
    }
  });

  it("runs the patterns that make a backtracking engine explode, in linear time", () => {
    // These are the classic catastrophic-backtracking shapes. Go answers
    // them in linear time and so must this engine: accepting them is the
    // point of not delegating to JavaScript's `RegExp`.
    const hostile = "a".repeat(200);
    const started = performance.now();
    expect(matchRe2("(a+)+$", hostile)).toBe(true);
    expect(matchRe2("(a+)+$", `${hostile}b`)).toBe(false);
    expect(matchRe2("(a|aa)*$", hostile)).toBe(true);
    // `(a|aa)*` can match empty, and the search is unanchored, so this
    // matches at end of text — verified against Go's own regexp.
    expect(matchRe2("(a|aa)*$", `${hostile}b`)).toBe(true);
    expect(matchRe2("(x+x+)+y", "x".repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses work outside its budgets", () => {
    expect(() => matchRe2("a{1001}", "a")).toThrow(/1000/u);
    expect(() => matchRe2("a", "a".repeat(9000))).toThrow(/budget/u);
    expect(() => matchRe2("a".repeat(300), "a")).toThrow(/budget/u);
    expect(() => matchRe2("(unclosed", "a")).toThrow(/unbalanced/u);
    expect(() => matchRe2("a{200}{200}", "a")).toThrow(/nested repetition/u);
    expect(() => matchRe2("a**", "a")).toThrow(/nested repetition/u);
    expect(() => matchRe2("a{2}+", "a")).toThrow(/nested repetition/u);
    expect(matchRe2("a*?b", "ab")).toBe(true);
    expect(matchRe2("a{,3}", "a{,3}")).toBe(true);
    expect(() => matchRe2("*", "a")).toThrow(/nothing to repeat/u);
    expect(() => matchRe2("[z-a]", "a")).toThrow(/inverted/u);
    expect(() => matchRe2("[abc", "a")).toThrow(/unterminated/u);
  });
});

describe("SB-045/047 field selection follows upstream's path and comments stack", () => {
  it("applies the default _unencrypted suffix to any ancestor segment", () => {
    const base = DEFAULT_POLICY;
    expect(shouldBeEncrypted(base, ["secret"], [[]], false)).toBe(true);
    expect(shouldBeEncrypted(base, ["public_unencrypted"], [[]], false)).toBe(
      false,
    );
    // An ancestor's suffix clears everything beneath it.
    expect(
      shouldBeEncrypted(base, ["inner_unencrypted", "deep"], [[]], false),
    ).toBe(false);
  });

  it("inverts for encrypted_suffix and honours the regex selectors", () => {
    const suffix = policy({ unencryptedSuffix: "", encryptedSuffix: "_enc" });
    expect(shouldBeEncrypted(suffix, ["a"], [[]], false)).toBe(false);
    expect(shouldBeEncrypted(suffix, ["a_enc"], [[]], false)).toBe(true);
    expect(shouldBeEncrypted(suffix, ["a_enc", "child"], [[]], false)).toBe(
      true,
    );
    const encrypted = policy({
      unencryptedSuffix: "",
      encryptedRegex: "^(pw|token)$",
    });
    expect(shouldBeEncrypted(encrypted, ["pw"], [[]], false)).toBe(true);
    expect(shouldBeEncrypted(encrypted, ["name"], [[]], false)).toBe(false);
    expect(shouldBeEncrypted(encrypted, ["o", "token"], [[]], false)).toBe(
      true,
    );
    const unencrypted = policy({
      unencryptedSuffix: "",
      unencryptedRegex: "^public",
    });
    expect(shouldBeEncrypted(unencrypted, ["public_b"], [[]], false)).toBe(
      false,
    );
    expect(shouldBeEncrypted(unencrypted, ["secret_a"], [[]], false)).toBe(
      true,
    );
  });

  it("reads the comments stack, and leaves the matching comment line itself clear", () => {
    const marked = policy({
      unencryptedSuffix: "",
      encryptedCommentRegex: "sops:enc",
    });
    expect(shouldBeEncrypted(marked, ["a"], [[" sops:enc"]], false)).toBe(true);
    expect(shouldBeEncrypted(marked, ["a"], [[" plain"]], false)).toBe(false);
    // The comment carrying the marker is not itself encrypted...
    expect(shouldBeEncrypted(marked, ["a"], [[" sops:enc"]], true)).toBe(false);
    // ...but a later comment under the same marker is.
    expect(
      shouldBeEncrypted(marked, ["a"], [[" sops:enc", " next"]], true),
    ).toBe(true);
    // An outer level's marker still applies to an inner value.
    expect(
      shouldBeEncrypted(marked, ["a", "b"], [[" sops:enc"], []], false),
    ).toBe(true);
    const cleared = policy({
      unencryptedSuffix: "",
      unencryptedCommentRegex: "plain",
    });
    expect(shouldBeEncrypted(cleared, ["a"], [[" plain"]], false)).toBe(false);
    expect(shouldBeEncrypted(cleared, ["a"], [[" other"]], false)).toBe(true);
  });

  it("refuses a policy that sets more than one selector rule, as upstream does", () => {
    expect(() => assertPolicyValid(DEFAULT_POLICY)).not.toThrow();
    expect(() => assertPolicyValid(policy({ encryptedRegex: "^a$" }))).toThrow(
      /only one/iu,
    );
    expect(() =>
      assertPolicyValid(
        policy({
          unencryptedSuffix: "",
          encryptedRegex: "^a$",
          encryptedSuffix: "_e",
        }),
      ),
    ).toThrow(/only one/iu);
    expect(() =>
      assertPolicyValid(
        policy({ unencryptedSuffix: "", encryptedRegex: "(?i)x" }),
      ),
    ).toThrow(/does not implement/u);
    expect(() =>
      assertPolicyValid(
        policy({ unencryptedSuffix: "", macOnlyEncrypted: true }),
      ),
    ).not.toThrow();
  });
});

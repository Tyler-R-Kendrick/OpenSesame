import { describe, expect, it } from "vitest";
import {
  type CredentialForm,
  EMPTY_FORM,
  entryFromForm,
} from "./credential-form";
import { drivable, matchPattern, originOf, withinOrigin } from "./origin";
import { CANDIDATE_LENGTH, generatePassword } from "./password";

describe("origins", () => {
  it("drives https, and http only on this machine", () => {
    for (const ok of [
      "https://rp.example",
      "https://rp.example:8443",
      "http://127.0.0.1:8787",
      "http://localhost:3000",
    ]) {
      expect(drivable(ok), ok).toBe(true);
    }
    for (const no of [
      "http://rp.example",
      "ftp://rp.example",
      "https://rp.example/path",
      "https://u:p@rp.example",
      "rp.example",
      "",
      "chrome-extension://abc",
    ]) {
      expect(drivable(no), no).toBe(false);
    }
  });

  it("holds a url to the origin exactly", () => {
    expect(withinOrigin("https://rp.example/a?b#c", "https://rp.example")).toBe(
      true,
    );
    for (const url of [
      "https://rp.example.evil.example/",
      "https://rp.example:444/",
      "http://rp.example/",
      "//rp.example/",
      "/path",
      "javascript:1",
    ]) {
      expect(withinOrigin(url, "https://rp.example"), url).toBe(false);
    }
    expect(originOf("https://u:p@rp.example")).toBeNull();
    expect(matchPattern("https://rp.example")).toBe("https://rp.example/*");
  });
});

describe("generatePassword", () => {
  it("is uniform over its alphabet by rejection, and has every class", () => {
    // Preserve the full sample while amortizing platform CSPRNG calls. The
    // injected reader still supplies fresh, uniformly random bytes; the
    // default platform reader is exercised below for every character class.
    const entropy = new Uint8Array(65536);
    let cursor = entropy.length;
    const bufferedRandom = (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1) {
        if (cursor === entropy.length) {
          crypto.getRandomValues(entropy);
          cursor = 0;
        }
        bytes[index] = entropy[cursor] ?? 0;
        cursor += 1;
      }
      return bytes;
    };
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const ch of generatePassword(bufferedRandom))
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(generatePassword()).toHaveLength(CANDIDATE_LENGTH);
    for (let i = 0; i < 200; i += 1) {
      const p = generatePassword();
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
    // No ambiguous glyphs, and no character wildly more likely than another.
    for (const ambiguous of ["0", "O", "1", "l", "I"])
      expect(counts.has(ambiguous)).toBe(false);
    const values = [...counts.values()];
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(2);
  });

  it("uses the bytes it is given and refuses a length that cannot hold every class", () => {
    expect(() => generatePassword(undefined, 3)).toThrow("password_too_short");
    const fixed = (bytes: Uint8Array) => bytes.fill(7);
    const expected = generatePassword(fixed);
    expect(generatePassword(fixed)).toBe(expected);
    let calls = 0;
    const rejectedFirst = (bytes: Uint8Array) => {
      calls += 1;
      return bytes.fill(calls === 1 ? 255 : 7);
    };
    // 255 is outside the first alphabet's rejection limit. It cannot affect
    // the result, and it costs exactly one extra read before the valid byte.
    expect(generatePassword(rejectedFirst)).toBe(expected);
    expect(calls).toBe(2 * CANDIDATE_LENGTH);
  });
});

describe("the credential form", () => {
  const parses = (s: string) => !s.includes("###");
  const base: CredentialForm = {
    ...EMPTY_FORM,
    origin: "https://rp.example",
    username: "ada",
    password: "pw",
  };

  it("takes a credential with no login check", () => {
    expect(entryFromForm(base, parses)).toEqual({
      ok: true,
      entry: { origin: "https://rp.example", username: "ada", password: "pw" },
    });
  });

  it("refuses a bad origin and an empty password", () => {
    expect(
      entryFromForm({ ...base, origin: "http://rp.example" }, parses),
    ).toEqual({ ok: false, error: "origin" });
    expect(entryFromForm({ ...base, password: "" }, parses)).toEqual({
      ok: false,
      error: "password",
    });
  });

  const login = {
    ...base,
    loginUrl: "https://rp.example/login",
    passwordSelector: "#p",
    submitSelector: "#s",
    signedInSelector: "#w",
  };

  it("takes a complete login check on the same origin", () => {
    const result = entryFromForm(
      { ...login, usernameSelector: "#u", rejectedSelector: "#d" },
      parses,
    );
    expect(result.ok && result.entry.login).toEqual({
      url: "https://rp.example/login",
      usernameSelector: "#u",
      passwordSelector: "#p",
      submitSelector: "#s",
      signedInSelector: "#w",
      rejectedSelector: "#d",
    });
  });

  it("refuses an incomplete one, one on another origin, and one that does not parse", () => {
    expect(entryFromForm({ ...login, signedInSelector: "" }, parses)).toEqual({
      ok: false,
      error: "login_incomplete",
    });
    expect(entryFromForm({ ...login, loginUrl: "" }, parses)).toEqual({
      ok: false,
      error: "login_incomplete",
    });
    expect(
      entryFromForm(
        { ...login, loginUrl: "https://evil.example/login" },
        parses,
      ),
    ).toEqual({ ok: false, error: "login_url" });
    expect(entryFromForm({ ...login, submitSelector: "###" }, parses)).toEqual({
      ok: false,
      error: "login_selector",
    });
  });
});

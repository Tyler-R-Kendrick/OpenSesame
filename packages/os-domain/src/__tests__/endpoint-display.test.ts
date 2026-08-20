import { describe, expect, it } from "vitest";
import { briefOrigin, repoHint } from "../endpoint-display.js";

describe("briefOrigin", () => {
  it("drops the scheme and a trailing slash from an http(s) origin", () => {
    expect(briefOrigin("http://127.0.0.1:18787/")).toBe("127.0.0.1:18787");
    expect(briefOrigin("https://box.tailnet.ts.net/host")).toBe(
      "box.tailnet.ts.net/host",
    );
  });

  it("blanks nothing but the empty string", () => {
    expect(briefOrigin("")).toBe("");
    expect(briefOrigin("   ")).toBe("");
  });

  it("shows a typo back verbatim rather than reinterpreting it", () => {
    expect(briefOrigin("not a url")).toBe("not a url");
    expect(briefOrigin("  http//missing-colon  ")).toBe("http//missing-colon");
  });

  it("refuses to shorten a scheme these settings can never hold", () => {
    // Found by the endpoint_display fuzz target: `new URL` parses `w:anything`
    // as an opaque scheme with no host, so shortening returned a
    // percent-encoded pathname — longer than the input and unrecognisable to
    // whoever typed it. A status line exists to shorten; growing is a bug.
    const typo = 'w:z:xa)d<+1$8%g,sk$294".4|^@z.6^s>q-v';
    expect(briefOrigin(typo)).toBe(typo);
    expect(briefOrigin("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(briefOrigin("libsql://db.turso.io")).toBe("libsql://db.turso.io");
  });

  it("never grows what it was given", () => {
    for (const raw of [
      "http://a",
      'w:"quote"',
      "https://x/ÿ",
      "mailto:someone@example.com",
      "a".repeat(200),
    ]) {
      expect(briefOrigin(raw).length).toBeLessThanOrEqual(raw.trim().length);
    }
  });
});

describe("repoHint", () => {
  it("reduces an https remote to owner/repo", () => {
    expect(repoHint("https://github.com/owner/store.git")).toBe("owner/store");
    expect(repoHint("https://gitlab.com/group/sub/store")).toBe(
      "group/sub/store",
    );
  });

  it("passes an scp-style remote through, minus the .git", () => {
    expect(repoHint("git@github.com:owner/store.git")).toBe(
      "git@github.com:owner/store",
    );
  });

  it("leaves a schemed string with no authority alone", () => {
    // Same fuzz finding: without a host there is no remote to shorten, and
    // taking the pathname percent-encodes whatever was typed.
    expect(repoHint("w:owner/store")).toBe("w:owner/store");
  });

  it("trims surrounding whitespace before anything else", () => {
    expect(repoHint("  https://github.com/owner/store.git  ")).toBe(
      "owner/store",
    );
    expect(repoHint("\t git@github.com:owner/store \n")).toBe(
      "git@github.com:owner/store",
    );
  });

  it("strips .git only as a suffix, never mid-path", () => {
    // Unanchored, this mangles any path merely containing the letters:
    // `owner/.github` would come back as `owner/hub`.
    expect(repoHint("https://github.com/owner/.github")).toBe("owner/.github");
    expect(repoHint("https://git.example.com/a/b")).toBe("a/b");
    expect(repoHint("https://github.com/owner/store.github")).toBe(
      "owner/store.github",
    );
  });

  it("strips every leading slash, not just the first", () => {
    // `new URL("https://h//a/b").pathname` is "//a/b"; leaving one behind
    // would render as a path in a status line rather than as owner/repo.
    expect(repoHint("https://host//owner/store")).toBe("owner/store");
    expect(repoHint("https://host///owner/store")).toBe("owner/store");
  });

  it("never grows what it was given, and never leads with a slash", () => {
    for (const raw of [
      "",
      "https://h/a/b.git",
      "w:x",
      "https://h/",
      "ÿ".repeat(40),
    ]) {
      const hint = repoHint(raw);
      expect(hint.length).toBeLessThanOrEqual(raw.trim().length);
      expect(hint.startsWith("/")).toBe(false);
      expect(hint.endsWith(".git")).toBe(false);
    }
  });
});

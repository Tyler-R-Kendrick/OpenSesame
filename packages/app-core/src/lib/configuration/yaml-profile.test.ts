import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES } from "./limits.js";
import { isPresentationOnlyChange, patchYamlTopLevel } from "./yaml-patch.js";
import { parseConfigYaml } from "./yaml-profile.js";

const COMMENTED = `# keep this comment

theme: system
# idle lock
autoLockMinutes: 0
lockOnHide: false
signOutOnLock: false
clipboardClearSeconds: 30
`;

describe("parseConfigYaml", () => {
  it("round-trips a mapping without fetching", () => {
    const parsed = parseConfigYaml(COMMENTED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.theme).toBe("system");
    expect(parsed.value.autoLockMinutes).toBe(0);
  });

  it("rejects documents over the interactive byte limit", () => {
    const source = `theme: ${"x".repeat(MAX_DOCUMENT_BYTES)}`;
    const parsed = parseConfigYaml(source);
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.some((item) => item.code === "too_large")).toBe(
      true,
    );
  });

  it("rejects aliases, merge keys, multi-document streams, and custom tags", () => {
    expect(parseConfigYaml("a: &id 1\nb: *id\n").ok).toBe(false);
    expect(parseConfigYaml("a: 1\n---\nb: 2\n").ok).toBe(false);
    expect(parseConfigYaml("a: !exec foo\n").ok).toBe(false);
    expect(parseConfigYaml("<<: {a: 1}\n").ok).toBe(false);
  });

  it("rejects duplicate keys, prototype keys, and non-string keys", () => {
    expect(parseConfigYaml("theme: light\ntheme: dark\n").ok).toBe(false);
    expect(parseConfigYaml("__proto__: {admin: true}\n").ok).toBe(false);
    expect(parseConfigYaml("1: nope\n").ok).toBe(false);
  });
});

describe("patchYamlTopLevel", () => {
  it("changes one field and keeps comments and blank lines", () => {
    const patched = patchYamlTopLevel(COMMENTED, "autoLockMinutes", 7);
    expect(patched).toContain("# keep this comment");
    expect(patched).toContain("# idle lock");
    expect(patched).toContain("autoLockMinutes: 7");
    expect(patched).toContain("theme: system");
    const parsed = parseConfigYaml(patched);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.autoLockMinutes).toBe(7);
  });

  it("treats a comment-only edit as presentation", () => {
    const commented = `${COMMENTED}# extra\n`;
    expect(isPresentationOnlyChange(COMMENTED, commented)).toBe(true);
    expect(
      isPresentationOnlyChange(
        COMMENTED,
        patchYamlTopLevel(COMMENTED, "theme", "dark"),
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  parsePrefsSource,
  prefsToYaml,
  validatePrefsDocument,
} from "./prefs-document.js";

describe("prefs document", () => {
  it("accepts a custom idle timeout that is not a select option", () => {
    const parsed = parsePrefsSource(
      "theme: dark\nautoLockMinutes: 7\nlockOnHide: false\nsignOutOnLock: false\nclipboardClearSeconds: 30\n",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.autoLockMinutes).toBe(7);
  });

  it("refuses prefsRevision and prototype-like keys", () => {
    expect(validatePrefsDocument({ theme: "dark", prefsRevision: 99 }).ok).toBe(
      false,
    );
    expect(parsePrefsSource("theme: dark\nprefsRevision: 99\n").ok).toBe(false);
  });

  it("keeps exact source when serializing then leaving the mapping alone", () => {
    const yaml = prefsToYaml({
      theme: "system",
      autoLockMinutes: 0,
      lockOnHide: false,
      signOutOnLock: false,
      clipboardClearSeconds: 30,
      prefsRevision: 2,
    });
    const parsed = parsePrefsSource(yaml);
    expect(parsed.ok).toBe(true);
  });

  it("keeps invalid source as the draft text rather than substituting defaults", () => {
    const invalid = "theme: [";
    const parsed = parsePrefsSource(invalid);
    expect(parsed.ok).toBe(false);
    expect(invalid).toBe("theme: [");
  });

  it("does not treat empty or newer-schema documents as current defaults", () => {
    const empty = parsePrefsSource("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.diagnostics[0]?.code).toBe("empty");
    const newer = parsePrefsSource(
      "schemaVersion: 99\ntheme: dark\nautoLockMinutes: 0\nlockOnHide: false\nsignOutOnLock: false\nclipboardClearSeconds: 30\n",
    );
    expect(newer.ok).toBe(false);
    if (!newer.ok) {
      expect(
        newer.diagnostics.some((item) => item.code === "unsupported_version"),
      ).toBe(true);
    }
  });
});

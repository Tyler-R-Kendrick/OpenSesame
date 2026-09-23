import { expect, it } from "vitest";
import {
  decodeSettings,
  encodeSettings,
  suggestSettings,
} from "./settings-files.js";

const general = {
  values: { theme: "dark", clipboardClearSeconds: 12 },
  keybindings: { j: "listing.next" },
};

it("round-trips a section as yaml and toml", () => {
  for (const format of ["yaml", "toml"] as const) {
    const source = encodeSettings("general", general, format);
    const parsed = decodeSettings("general", source, format);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.values.theme).toBe("dark");
    expect(parsed.doc.values.clipboardClearSeconds).toBe(12);
    expect(parsed.doc.keybindings.j).toBe("listing.next");
  }
});

it("rejects a value outside the section", () => {
  const parsed = decodeSettings("security", "theme: dark\n", "yaml");
  expect(parsed.ok).toBe(false);
});

it("suggests only allowed keys and enum values", () => {
  expect(suggestSettings("general", "th", 2)).toEqual(["theme"]);
  expect(suggestSettings("general", "theme: d", 8)).toEqual(["dark"]);
  expect(suggestSettings("security", "lock", 4)).toEqual(["lockOnHide"]);
});

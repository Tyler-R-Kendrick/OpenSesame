/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KEYMAP_HELP } from "./keymap.js";

/**
 * Contract: DESIGN.md, the in-app `?` sheet, and the handler speak the same
 * keymap. A motion that lands in one and not the others is a broken TUI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const design = readFileSync(resolve(here, "../../../../DESIGN.md"), "utf8");
const vfs = readFileSync(
  resolve(here, "../../../../docs/design/vault-vfs.md"),
  "utf8",
);

const REQUIRED_IN_DESIGN = [
  "5j",
  "Ctrl-d",
  "Ctrl-f",
  "H",
  "M",
  "L",
  "gg",
  "Backspace",
  "Tab",
  "g v/c/a/i/s",
];

describe("listing keymap contract", () => {
  it("the in-app sheet is the exported KEYMAP_HELP table", () => {
    expect(KEYMAP_HELP.map(([keys]) => keys)).toEqual([
      "j / k or arrows",
      "3j  10k",
      "Ctrl-d / u",
      "Ctrl-f / b or PgUp/Dn",
      "H / M / L",
      "gg / G  0 / $",
      "l / h  Enter  Backspace",
      "Tab",
      "/  Esc",
      "y / u",
      "e / x",
      "n / .",
      "s",
      "g v/c/a/i/s",
    ]);
  });

  it("DESIGN.md names every motion the sheet advertises", () => {
    for (const token of REQUIRED_IN_DESIGN) {
      expect(design, `DESIGN.md must mention ${token}`).toContain(token);
    }
  });

  it("the VFS design doc names the rail and vault as two listings", () => {
    expect(vfs).toContain("registerRailKeymap");
    expect(vfs).toContain("registerVaultKeymap");
    expect(vfs).toContain("Tab");
    expect(vfs).toContain("[count]");
  });
});

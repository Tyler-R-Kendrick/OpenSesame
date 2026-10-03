import { describe, expect, it } from "vitest";
import { reconcileSource } from "./settings-config.js";
import { decodeSettings, encodeSettings } from "./settings-files.js";
import { yamlKey } from "./settings-keymap-yaml.js";

/** Keys YAML would read as a number or a boolean (ADR 0150). */
describe("keys YAML reads as something else", () => {
  const at = (...bound: (readonly [string, string])[]) => ({
    values: { singleKeys: true },
    keybindings: Object.fromEntries(bound),
  });

  it("quotes a key YAML would read as a number or a boolean", () => {
    const doc = {
      values: { singleKeys: true },
      keybindings: { "0": "item.edit", w: "listing.next" },
      macros: { on: { steps: ["listing.first"] } },
    };
    const source = encodeSettings("keybindings", doc);
    expect(source).toContain('  "0": item.edit');
    expect(source).toContain('  "on":');
    expect(yamlKey("Space")).toBe("Space");
    for (const word of ["true", "False", "null", "yes", "No", "off", "12"])
      expect(yamlKey(word)).toBe(JSON.stringify(word));
    const parsed = decodeSettings("keybindings", source);
    expect(parsed.ok && parsed.doc.keybindings).toEqual(doc.keybindings);
  });

  it("round-trips a `0` binding through the file, keeping every comment", () => {
    const zero = ["0", "item.edit"] as const;
    const jump = ["w", "listing.next"] as const;
    // What the editor wrote is what it reads back, so the person's comments
    // are the ones that ride along.
    const written = encodeSettings("keybindings", at(zero, jump));
    const saved = written
      .replace('"0": item.edit', '"0": item.edit # zero')
      .replace("w: listing.next", "w: listing.next # like j")
      .replace(/^/, "# my keys\n");
    expect(reconcileSource("keybindings", saved, at(zero, jump))).toBe(saved);
    const moved = reconcileSource(
      "keybindings",
      saved,
      at(["0", "item.new"], jump, ["q", "help.keymap"]),
    );
    expect(moved).toContain("# my keys");
    expect(moved).toContain("# zero");
    expect(moved).toContain("# like j");
    expect(moved.match(/^ {2}"?0"?:/gm)).toHaveLength(1);
    const parsed = decodeSettings("keybindings", moved);
    expect(parsed.ok && parsed.doc.keybindings).toEqual({
      "0": "item.new",
      w: "listing.next",
      q: "help.keymap",
    });
    const dropped = reconcileSource("keybindings", saved, at(jump));
    expect(dropped).toContain("# like j");
    expect(dropped).not.toContain("0");
  });

  it("asks for a bare `0` key to be quoted rather than losing the file", () => {
    const bare = decodeSettings(
      "keybindings",
      "keybindings:\n  0: item.edit\n",
    );
    expect(bare).toEqual({
      ok: false,
      message: 'Mapping keys must be strings: write "0" in quotes.',
    });
  });

  it("patches a quoted numeric key inside a context the same way", () => {
    const saved = 'contexts:\n  vault:\n    "0": item.edit # zero\n';
    const out = reconcileSource("keybindings", saved, {
      values: { singleKeys: true },
      keybindings: {},
      contexts: { vault: { "0": "item.new" } },
    });
    expect(out).toContain("# zero");
    expect(out.match(/^ {4}"?0"?:/gm)).toHaveLength(1);
    const parsed = decodeSettings("keybindings", out);
    expect(parsed.ok && parsed.doc.contexts).toEqual({
      vault: { "0": "item.new" },
    });
  });
});

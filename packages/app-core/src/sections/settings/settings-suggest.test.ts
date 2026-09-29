import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../../lib/configuration/yaml-profile.js";
import { suggestSettings } from "./settings-files.js";

describe("suggesting inside the keymap file", () => {
  const at = (source: string) =>
    suggestSettings("keybindings", source, source.length);

  it("offers nothing on the indented lines of a macro or a trigger", () => {
    expect(at("macros:\n  triage:\n    steps: [3 listing.next]")).toEqual([]);
    expect(at("macros:\n  triage:\n    s")).toEqual([]);
    expect(at("macros:\n  triage:\n    on: un")).toEqual([]);
    expect(at("macros:\n  t")).toEqual([]);
    expect(
      at("keybindings:\n  w: listing.next\nmacros:\n  top:\n    steps: ["),
    ).toEqual([]);
    // …nor off the keymap's directory.
    expect(suggestSettings("general", "keybindings:\n  ", 15)).toEqual([]);
  });

  it("offers keys and ids inside keybindings and a context, and only a real one", () => {
    expect(at("keybindings:\n  ")).toContain("j");
    expect(at("contexts:\n  vault:\n    ")).toContain("j");
    expect(at("contexts:\n  rail:\n    d: ")).toContain("item.edit");
    expect(at("contexts:\n  detail:\n    ")).toEqual([]);
    expect(at("contexts:\n  ")).toEqual([]);
    expect(at("singleKeys: true\n\nkeybindings:\n\n  w: nop\n  ")).toContain(
      "j",
    );
  });

  it("narrows by what is typed before it caps, so later commands are reachable", () => {
    const control = at("keybindings:\n  Con");
    expect(control.length).toBeGreaterThan(0);
    expect(control.every((key) => key.startsWith('"Control+'))).toBe(true);
    expect(at("keybindings:\n  g")).toEqual(
      expect.arrayContaining(['"g g"', '"g v"']),
    );
    expect(at("keybindings:\n  g")).not.toContain("j");
    expect(at("keybindings:\n  w: item.")).toContain("item.trash");
    expect(at("keybindings:\n  w: item.s")).toEqual(["item.share"]);
    expect(at("keybindings:\n  w: no")).toEqual(["nop"]);
    expect(at('keybindings:\n  "g v')).toEqual(['"g v"']);
    expect(at("keybindings:\n  w: nope")).toEqual([]);
  });

  it("offers the macros the file names", () => {
    const source =
      "macros:\n  triage:\n    steps: [listing.first]\nkeybindings:\n  w: macro.";
    expect(at(source)).toEqual(["macro.triage"]);
  });

  it("writes every key it offers as YAML that reads back as that key", () => {
    const keys = at("keybindings:\n  ");
    for (const suggestion of [":", "@", "?", "Control+l", "g g", "0", "$"]) {
      const offered = keys.find(
        (key) => key.replace(/^"|"$/g, "") === suggestion,
      );
      expect(offered, suggestion).toBeDefined();
      const parsed = parseConfigYaml(`${offered}: nop\n`);
      expect(parsed.ok && Object.keys(parsed.value), suggestion).toEqual([
        suggestion,
      ]);
    }
  });
});

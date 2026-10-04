import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../../lib/configuration/yaml-profile.js";
import { decodeSettings, suggestSettings } from "./settings-files.js";
import { gestureSuggestions, inGestures } from "./settings-suggest.js";

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
    expect(at("keybindings:\n  w: item.")).toContain("item.edit");
    expect(at("keybindings:\n  s: item.s")).toEqual(["item.share"]);
    expect(at("keybindings:\n  w: no")).toEqual(["nop"]);
    expect(at('keybindings:\n  "g v')).toEqual(['"g v"']);
    expect(at("keybindings:\n  w: nope")).toEqual([]);
  });

  it("offers a command that asks first only on its own locked key", () => {
    // `readKeymap` refuses `w: item.trash`, so Tab must not write it.
    expect(at("keybindings:\n  w: item.")).not.toContain("item.trash");
    expect(at("keybindings:\n  w: item.")).not.toContain("item.share");
    expect(at("keybindings:\n  w: item.s")).toEqual([]);
    expect(at("contexts:\n  vault:\n    w: item.t")).toEqual([]);
    expect(at("keybindings:\n  x: item.")).toContain("item.trash");
    expect(at("keybindings:\n  x: item.")).not.toContain("item.share");
    expect(at("contexts:\n  vault:\n    s: item.s")).toEqual(["item.share"]);
    // Whatever is offered, the file accepts.
    for (const id of at("keybindings:\n  w: ")) {
      const parsed = decodeSettings(
        "keybindings",
        `keybindings:\n  w: ${id}\n`,
      );
      expect(parsed.ok, id).toBe(true);
    }
  });

  it("judges a key the way the file does, whatever its spelling", () => {
    // `X` is `item.purge`'s own locked key, and the file accepts it written
    // any of these ways, so the completion list must offer it for each.
    for (const key of ["X", "Shift+X", "shift+x", "Shift+x"]) {
      expect(at(`keybindings:\n  ${key}: item.pu`), key).toEqual([
        "item.purge",
      ]);
      expect(
        decodeSettings("keybindings", `keybindings:\n  ${key}: item.purge\n`)
          .ok,
        key,
      ).toBe(true);
    }
    expect(at("keybindings:\n  Shift+Y: item.pu")).toEqual([]);
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

describe("gesture completion (ADR 0165)", () => {
  const at = (source: string) => gestureSuggestions(source, source.length);

  it("knows when the caret is inside gestures:", () => {
    const source = "keybindings:\n  w: listing.next\ngestures:\n  sh";
    expect(inGestures(source, source.length)).toBe(true);
    expect(inGestures("keybindings:\n  w", 16)).toBe(false);
    expect(inGestures("gestures:\n", 0)).toBe(false);
  });

  it("offers gesture names for a key, narrowed to what is typed", () => {
    expect(at("gestures:\n  two-finger-swipe-")).toEqual([
      "two-finger-swipe-left",
      "two-finger-swipe-right",
      "two-finger-swipe-up",
      "two-finger-swipe-down",
    ]);
    expect(at("gestures:\n  sh")).toEqual(["shake"]);
  });

  it("offers only actions a gesture may bind, and the file's own macros", () => {
    const offered = at(
      "macros:\n  top:\n    steps: [listing.first]\ngestures:\n  shake: ",
    );
    expect(offered).toContain("item.favorite");
    expect(offered).toContain("macro.top");
    expect(offered).toContain("nop");
    expect(offered).not.toContain("item.trash");
    expect(offered).not.toContain("register.record");
    expect(at("gestures:\n  shake: item.fav")).toEqual(["item.favorite"]);
  });
});

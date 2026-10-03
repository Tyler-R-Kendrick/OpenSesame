import { describe, expect, it } from "vitest";
import { suggestSettings } from "./settings-files.js";
import {
  applySuggestion,
  completeAt,
  tabSuggestion,
} from "./settings-raw-editor-model.js";

const tab = (category: string, source: string, caret = source.length) =>
  tabSuggestion(source, caret, suggestSettings(category, source, caret));

describe("what Tab does in the raw editor", () => {
  it("completes only a partly typed word at the end of its line", () => {
    expect(tab("general", "th")).toBe("theme");
    expect(tab("general", "theme")).toBe("theme");
    expect(tab("general", "theme: d")).toBe("dark");
    expect(tab("keybindings", "keybindings:\n  w: item.s")).toBe("item.share");
    expect(tab("keybindings", "keybindings:\n  Control+")).toBe('"Control+n"');
  });

  it("leaves Tab alone on an empty line, a finished word or a mid-line caret", () => {
    expect(tab("general", "")).toBeNull();
    expect(tab("general", "theme: ")).toBeNull();
    expect(tab("general", "theme: dark")).toBeNull();
    expect(tab("keybindings", "keybindings:\n  ")).toBeNull();
    expect(tab("keybindings", "keybindings:\n  w: ")).toBeNull();
    expect(tab("keybindings", "keybindings:\n  w: nop")).toBeNull();
    expect(tab("general", "theme: d", 3)).toBeNull();
  });

  it("never rewrites a macro's steps, its trigger or a context's name", () => {
    const macros =
      "macros:\n  triage:\n    on: unlock\n    steps: [3 listing.next]";
    expect(tab("keybindings", macros)).toBeNull();
    expect(tab("keybindings", `${macros}\n    s`)).toBeNull();
    expect(tab("keybindings", "contexts:\n  v")).toBeNull();
    expect(
      tab("keybindings", "keybindings:\n  w: listing.next\nmacros:\n  t"),
    ).toBeNull();
  });
});

describe("writing a completion", () => {
  it("opens a fresh key with its colon", () => {
    expect(completeAt("th", 2, "theme")).toEqual({
      source: "theme: ",
      caret: 7,
    });
    expect(applySuggestion("keybindings:\n  ", 15, "j")).toBe(
      "keybindings:\n  j: ",
    );
  });

  it("finishes a value without touching the key", () => {
    expect(applySuggestion("theme: d", 8, "dark")).toBe("theme: dark");
    expect(applySuggestion("k:\n  w: it\nz: 1", 10, "item.edit")).toBe(
      "k:\n  w: item.edit\nz: 1",
    );
  });

  it("finishes a key without overwriting the value beside it", () => {
    const done = completeAt("keybindings:\n  g: help.keymap", 15, '"g g"');
    expect(done.source).toBe('keybindings:\n  "g g": help.keymap');
    expect(done.caret).toBe(done.source.indexOf("help.keymap"));
  });

  it("reads a quoted key that holds a colon as one key", () => {
    expect(applySuggestion('  ":": ', 7, "nop")).toBe('  ":": nop');
  });
});

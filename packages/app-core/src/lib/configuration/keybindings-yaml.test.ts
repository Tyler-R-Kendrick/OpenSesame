import { describe, expect, it } from "vitest";
import { keybindingsToYaml, readKeybindingsYaml } from "./keybindings-yaml.js";

describe("keybindings.yaml", () => {
  it("writes YAML and reads it back", () => {
    const text = keybindingsToYaml({
      j: "listing.next",
      "Control+l": "command.palette",
    });
    expect(text).toBe("j: listing.next\nControl+l: command.palette\n");
    expect(readKeybindingsYaml(text)).toEqual({
      j: "listing.next",
      "Control+l": "command.palette",
    });
  });

  it("still reads the JSON the panel used to write", () => {
    expect(readKeybindingsYaml('{ ":": "command.palette" }')).toEqual({
      ":": "command.palette",
    });
  });

  it("answers null for text that is not YAML, and an empty map for nothing", () => {
    expect(readKeybindingsYaml("a: [")).toBeNull();
    expect(readKeybindingsYaml("")).toEqual({});
  });
});

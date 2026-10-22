import { describe, expect, it } from "vitest";
import { sharedText } from "./formats/shared-text.js";
import type { DetectInput } from "./types.js";

function input(overrides: Partial<DetectInput> = {}): DetectInput {
  return {
    fileName: ".opensesame-share.txt",
    text: "Deploy note\n\nAPI_KEY=sk-test",
    headers: null,
    json: null,
    bytes: null,
    ...overrides,
  };
}

describe("shared text", () => {
  it("claims only the internal share filename", () => {
    expect(sharedText.detect(input())).toBe(true);
    expect(sharedText.detect(input({ fileName: "notes.txt" }))).toBe(true);
    expect(sharedText.detect(input({ fileName: "notes.md" }))).toBe(true);
    expect(sharedText.detect(input({ fileName: "photo.png" }))).toBe(false);
    expect(sharedText.detect(input({ text: "" }))).toBe(false);
  });

  it("turns the shared text into one reviewed note", () => {
    const result = sharedText.parse(input());
    expect(result.items[0]).toMatchObject({
      kind: "note",
      name: "Deploy note",
      notes: "Deploy note\n\nAPI_KEY=sk-test",
    });
    expect(result.source).toBe("shared-text");
  });
});

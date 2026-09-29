// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { writeValue } from "./write";

describe("writeValue", () => {
  it("sets the value and fires input then change, bubbling", () => {
    const form = document.createElement("form");
    const field = document.createElement("input");
    field.type = "password";
    form.appendChild(field);
    document.body.appendChild(form);
    const seen: string[] = [];
    form.addEventListener("input", (e) => seen.push(`input:${e.type}`));
    form.addEventListener("change", (e) => seen.push(`change:${e.type}`));
    writeValue(field, "typed-like-a-person");
    expect(field.value).toBe("typed-like-a-person");
    expect(seen).toEqual(["input:input", "change:change"]);
    expect(document.activeElement).toBe(field);
  });

  it("goes through the prototype setter a framework cannot shadow", () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    let shadowed = "";
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => shadowed,
      set: (next: string) => {
        shadowed = `framework saw ${next}`;
      },
    });
    writeValue(field, "v");
    // The instance shadow was bypassed: the framework's tracker did not
    // swallow the write, so its input listener will see a change.
    expect(shadowed).toBe("");
  });
});

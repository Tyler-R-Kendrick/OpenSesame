import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RESET_ACTIONS } from "./grants.js";
import { PRIMITIVES } from "./types.js";

describe("shared CUA reset contract", () => {
  it("keeps primitives and grant actions on the shared definition", async () => {
    const raw = await readFile(
      new URL(
        "../../../spec/conformance/cua-password-reset.json",
        import.meta.url,
      ),
      "utf8",
    );
    const spec = JSON.parse(raw) as {
      primitives: string[];
      grant_actions: string[];
    };
    expect([...PRIMITIVES]).toEqual(spec.primitives);
    expect([...RESET_ACTIONS]).toEqual(spec.grant_actions);
  });
});

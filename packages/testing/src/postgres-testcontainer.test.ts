import { describe, expect, it } from "vitest";
import { PINNED_POSTGRES_IMAGE } from "./postgres-testcontainer.js";

describe("postgres testcontainer defaults", () => {
  it("pins the postgres image by digest", () => {
    expect(PINNED_POSTGRES_IMAGE).toMatch(
      /^postgres:16-alpine@sha256:[a-f0-9]{64}$/u,
    );
  });
});

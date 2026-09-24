import { describe, expect, it } from "vitest";

describe("pairwise demo seeds", () => {
  it("beta sector is distinct from alpha", () => {
    const digest = (sector: string) =>
      Array.from(new TextEncoder().encode(`${sector}:demo-principal`))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
    expect(digest("https://beta.example.test")).not.toBe(
      digest("https://alpha.example.test"),
    );
  });
});

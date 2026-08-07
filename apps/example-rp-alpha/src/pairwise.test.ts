import { describe, expect, it } from "vitest";

describe("pairwise demo seeds", () => {
  it("alpha and beta sectors differ", () => {
    const digest = (sector: string) =>
      Array.from(new TextEncoder().encode(`${sector}:demo-principal`))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);
    expect(digest("https://alpha.example.test")).not.toBe(
      digest("https://beta.example.test"),
    );
  });
});

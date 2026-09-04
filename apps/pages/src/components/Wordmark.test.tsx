/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  WORDMARK,
  WORDMARK_CIPHER,
  WORDMARK_STEPS,
  Wordmark,
  cipherReel,
} from "./Wordmark.js";

describe("cipherReel", () => {
  it("is a hex track that locks on the plaintext letter", () => {
    const reel = cipherReel(0, "o");
    expect(reel).toHaveLength(WORDMARK_STEPS + 1);
    expect(reel.endsWith("o")).toBe(true);
    expect(
      [...reel.slice(0, WORDMARK_STEPS)].every((glyph) =>
        WORDMARK_CIPHER.includes(glyph),
      ),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "n")).toBe(cipherReel(3, "n"));
    expect(cipherReel(0, "o")).not.toBe(cipherReel(1, "p"));
  });
});

describe("Wordmark", () => {
  it("exposes the brand name once, and hides the reels from AT", () => {
    render(<Wordmark />);
    expect(
      screen.getAllByText(WORDMARK, { selector: ".visually-hidden" }),
    ).toHaveLength(1);
    expect(
      document.querySelector(".wordmark__slots")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(document.querySelectorAll(".wordmark__slot")).toHaveLength(
      WORDMARK.length,
    );
    const glyphs = [
      ...(document
        .querySelector(".wordmark__slot")
        ?.querySelectorAll(".wordmark__glyph") ?? []),
    ].map((node) => node.textContent);
    expect(glyphs).toHaveLength(WORDMARK_STEPS + 1);
    expect(glyphs.at(-1)).toBe("o");
    expect(WORDMARK_CIPHER.includes(glyphs[0] ?? "")).toBe(true);
  });
});

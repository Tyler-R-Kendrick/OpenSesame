/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORDMARK,
  WORDMARK_CIPHER,
  WORDMARK_FRAME_MS,
  WORDMARK_MAX_STEPS,
  WORDMARK_MIN_STEPS,
  Wordmark,
  cipherReel,
  wordmarkSeams,
} from "./Wordmark.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cipherReel", () => {
  it("is a hex track that locks on the plaintext letter", () => {
    const reel = cipherReel(0, "o", WORDMARK_MAX_STEPS);
    expect(reel).toHaveLength(WORDMARK_MAX_STEPS + 1);
    expect(reel.endsWith("o")).toBe(true);
    expect(
      [...reel.slice(0, -1)].every((glyph) => WORDMARK_CIPHER.includes(glyph)),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "n", 8)).toBe(cipherReel(3, "n", 8));
    expect(cipherReel(0, "o", 8)).not.toBe(cipherReel(1, "p", 8));
  });
});

describe("Wordmark", () => {
  beforeEach(() => {
    wordmarkSeams.revealed = false;
  });

  it("settles at once on a second mount in the same session", () => {
    const first = render(<Wordmark />);
    expect(first.container.querySelector(".wordmark--settled")).toBeNull();
    first.unmount();
    const second = render(<Wordmark />);
    expect(second.container.querySelector(".wordmark--settled")).toBeTruthy();
    expect(second.container.querySelectorAll(".wordmark__slot")).toHaveLength(
      WORDMARK.length,
    );
  });

  it("scrambles every unread slot until the cursor locks it", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999);
    const { container, rerender } = render(<Wordmark />);
    const slots = [
      ...container.querySelectorAll<HTMLElement>(".wordmark__slot"),
    ];
    expect(slots).toHaveLength(WORDMARK.length);
    let locked = 0;
    for (const [index, slot] of slots.entries()) {
      const advance = index === 0 ? WORDMARK_MIN_STEPS : WORDMARK_MAX_STEPS;
      const steps = locked + advance;
      const reel = slot.querySelector<HTMLElement>(".wordmark__reel");
      expect(slot.querySelectorAll(".wordmark__glyph")).toHaveLength(steps + 1);
      expect(slot.style.animationDelay).toBe(`${locked * WORDMARK_FRAME_MS}ms`);
      expect(slot.style.animationDuration).toBe(
        `${advance * WORDMARK_FRAME_MS}ms`,
      );
      expect(reel?.style.animationDuration).toBe(
        `${steps * WORDMARK_FRAME_MS}ms`,
      );
      expect(
        slot.querySelector(".wordmark__glyph:last-child")?.textContent,
      ).toBe(WORDMARK[index]);
      locked += advance;
    }
    expect(WORDMARK).toBe("open-sesame");
    expect(locked * WORDMARK_FRAME_MS).toBeGreaterThan(2300);
    expect(locked * WORDMARK_FRAME_MS).toBeLessThan(5000);
    const original = container.innerHTML;
    rerender(<Wordmark />);
    expect(container.innerHTML).toBe(original);
  });
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
    expect(glyphs.length).toBeGreaterThanOrEqual(WORDMARK_MIN_STEPS + 1);
    expect(glyphs.length).toBeLessThanOrEqual(WORDMARK_MAX_STEPS + 1);
    expect(glyphs.at(-1)).toBe("o");
    expect(WORDMARK_CIPHER.includes(glyphs[0] ?? "")).toBe(true);
  });
});

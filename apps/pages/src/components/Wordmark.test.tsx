/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORDMARK,
  WORDMARK_CIPHER,
  WORDMARK_DISPLAY,
  WORDMARK_FRAME_MS,
  WORDMARK_MAX_STEPS,
  WORDMARK_MIN_STEPS,
  Wordmark,
  cipherReel,
  fitEm,
  wordmarkSeams,
} from "./Wordmark.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cipherReel", () => {
  it("is a hex track that locks on the plaintext letter", () => {
    const reel = cipherReel(0, "O", WORDMARK_MAX_STEPS);
    expect(reel).toHaveLength(WORDMARK_MAX_STEPS + 1);
    expect(reel.endsWith("O")).toBe(true);
    expect(
      [...reel.slice(0, -1)].every((glyph) => WORDMARK_CIPHER.includes(glyph)),
    ).toBe(true);
  });

  it("is deterministic per slot", () => {
    expect(cipherReel(3, "N", 8)).toBe(cipherReel(3, "N", 8));
    expect(cipherReel(0, "O", 8)).not.toBe(cipherReel(1, "P", 8));
  });
});

describe("fitEm", () => {
  it("fits the hero to its column and caps it", () => {
    expect(fitEm(700, { max: 90 })).toBeCloseTo(89.97, 1);
    expect(fitEm(1200, { max: 90 })).toBe(90);
    expect(fitEm(288, { max: 90 })).toBeCloseTo(37.0, 0);
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
    expect(
      second.container.querySelector("canvas.cipher-wordmark__canvas"),
    ).toBeTruthy();
  });

  it("replays the decrypt when asked, then leaves later mounts settled", () => {
    const first = render(<Wordmark />);
    first.unmount();
    const replayed = render(<Wordmark replay />);
    expect(replayed.container.querySelector(".wordmark--settled")).toBeNull();
    replayed.unmount();
    const later = render(<Wordmark />);
    expect(later.container.querySelector(".wordmark--settled")).toBeTruthy();
  });

  it("publishes staggered slot timings for verify, the space taking none", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.999);
    const { container } = render(<Wordmark />);
    const timings = container
      .querySelector(".cipher-wordmark")
      ?.getAttribute("data-cipher-timings");
    expect(timings).toBeTruthy();
    // SAFETY: the component wrote this JSON itself (slotTimingsJson), one object per slot.
    const parsed = JSON.parse(timings ?? "[]") as Array<{
      delay: number;
      duration: number;
      letter: string;
    }>;
    expect(parsed.map((slot) => slot.letter).join("")).toBe(WORDMARK_DISPLAY);
    const active = parsed.filter((slot) => slot.letter !== " ");
    expect(active).toHaveLength(10);
    let locked = 0;
    for (const [index, slot] of active.entries()) {
      const advance = index === 0 ? WORDMARK_MIN_STEPS : WORDMARK_MAX_STEPS;
      expect(slot.delay).toBe(locked * WORDMARK_FRAME_MS);
      expect(slot.duration).toBe(advance * WORDMARK_FRAME_MS);
      locked += advance;
    }
    expect(locked * WORDMARK_FRAME_MS).toBeGreaterThan(2300);
    expect(locked * WORDMARK_FRAME_MS).toBeLessThan(5000);
  });

  it("exposes the brand name once, and hides the plates from AT", () => {
    render(<Wordmark as="h1" />);
    expect(
      screen.getAllByText(WORDMARK, { selector: ".visually-hidden" }),
    ).toHaveLength(1);
    expect(document.querySelector("h1.wordmark")).toBeTruthy();
    expect(
      document.querySelector(".wordmark__slots")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      document.querySelector(".cipher-wordmark")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(document.querySelector(".wordmark svg")).toBeNull();
  });
});

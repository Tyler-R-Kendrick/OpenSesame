import type { ReactElement } from "react";
import { IconMark } from "./Icons.js";

/** The brand line every gate and the rail share. */
export const WORDMARK = "opensesame";

/** Hex alphabet — the same glyphs a digest is written in. */
export const WORDMARK_CIPHER = "0123456789abcdef";

/** Cipher frames in each slot before the plaintext letter locks. */
export const WORDMARK_STEPS = 7;

/**
 * Deterministic reel for slot `index`. Knuth multiplicative hash, then the
 * Numerical Recipes LCG, so hydration and tests see the same ciphertext.
 */
export function cipherReel(index: number, target: string): string {
  let seed = ((index + 1) * 2_654_435_761) >>> 0;
  let out = "";
  for (let step = 0; step < WORDMARK_STEPS; step += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const glyph = WORDMARK_CIPHER[seed % WORDMARK_CIPHER.length];
    out += glyph ?? "0";
  }
  return `${out}${target}`;
}

type Slot = {
  id: string;
  delay: string;
  glyphs: Array<{ id: string; glyph: string }>;
};

const SLOTS: Slot[] = [...WORDMARK].map((letter, index) => {
  const reel = cipherReel(index, letter);
  return {
    id: `${index}:${letter}`,
    delay: `${index * 42}ms`,
    glyphs: [...reel].map((glyph, glyphIndex) => ({
      id: `${index}:${glyphIndex}`,
      glyph,
    })),
  };
});

/**
 * Brand wordmark. Jhey Tompkins' composited slot-reel (Craft of UI, 2024):
 * each letter is a 1ch terminal cell whose inner track steps through hex
 * ciphertext and locks on the plaintext. Glyphs are stacked in the DOM so
 * wrap cannot fail on a font where `1ch` is not a full cell. `steps()` +
 * transform stay on the compositor. The readable name is visually hidden;
 * the reels are decorative.
 */
export function Wordmark({
  className,
  size = 16,
}: {
  className?: string;
  size?: number;
}): ReactElement {
  return (
    <p className={className ? `wordmark ${className}` : "wordmark"}>
      <IconMark size={size} />
      <span className="visually-hidden">{WORDMARK}</span>
      <span className="wordmark__slots" aria-hidden="true">
        {SLOTS.map((slot) => (
          <span
            key={slot.id}
            className="wordmark__slot"
            style={{ animationDelay: slot.delay }}
          >
            <span className="wordmark__reel">
              {slot.glyphs.map((cell) => (
                <span className="wordmark__glyph" key={cell.id}>
                  {cell.glyph}
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </p>
  );
}

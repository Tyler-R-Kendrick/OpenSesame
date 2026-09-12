import { type ReactElement, useEffect, useState } from "react";
import { IconMark } from "./Icons.js";
import "./wordmark.css";

/**
 * Whether a wordmark has already revealed itself this session. The reel is
 * the one authored moment of an arrival; a second gate mounting seconds later
 * — the setup ceremony after the front door, the rail after unlock — arrives
 * still. Tests reset it between renders.
 */
export const wordmarkSeams = { revealed: false };

/** The brand line every gate and the rail share. */
export const WORDMARK = "open-sesame";

/** Hex alphabet — the same glyphs a digest is written in. */
export const WORDMARK_CIPHER = "0123456789abcdef";

/** Cipher frames in each slot before the plaintext letter locks. */
export const WORDMARK_MIN_STEPS = 6;
export const WORDMARK_MAX_STEPS = 12;
export const WORDMARK_FRAME_MS = 35;

/**
 * Deterministic reel for slot `index`. Knuth multiplicative hash, then the
 * Numerical Recipes LCG, so hydration and tests see the same ciphertext.
 */
export function cipherReel(
  index: number,
  target: string,
  steps: number,
): string {
  let seed = ((index + 1) * 2_654_435_761) >>> 0;
  let out = "";
  for (let step = 0; step < steps; step += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const glyph = WORDMARK_CIPHER[seed % WORDMARK_CIPHER.length];
    out += glyph ?? "0";
  }
  return `${out}${target}`;
}

type Slot = {
  id: string;
  delay: string;
  duration: string;
  reelDuration: string;
  steps: number;
  glyphs: Array<{ id: string; glyph: string }>;
};

function createSlots(): Slot[] {
  let locked = 0;
  return [...WORDMARK].map((letter, index) => {
    const advance =
      WORDMARK_MIN_STEPS +
      Math.floor(Math.random() * (WORDMARK_MAX_STEPS - WORDMARK_MIN_STEPS + 1));
    const steps = locked + advance;
    const reel = cipherReel(index, letter, steps);
    const slot = {
      id: `${index}:${letter}`,
      delay: `${locked * WORDMARK_FRAME_MS}ms`,
      duration: `${advance * WORDMARK_FRAME_MS}ms`,
      reelDuration: `${steps * WORDMARK_FRAME_MS}ms`,
      steps,
      glyphs: [...reel].map((glyph, glyphIndex) => ({
        id: `${index}:${glyphIndex}`,
        glyph,
      })),
    };
    locked += advance;
    return slot;
  });
}

/**
 * Brand wordmark. Jhey Tompkins' composited slot-reel (Craft of UI, 2024):
 * every unread cell scrambles from t=0; a cursor locks one plaintext letter
 * at a time. Only the cursor's advance is randomized. Glyphs are stacked in
 * the DOM so wrap cannot fail on a font where `1ch` is not a full cell.
 * `steps()` + transform stay on the compositor. The readable name is
 * visually hidden; the reels are decorative. The reel runs once per session:
 * a later mount renders the same reels already settled on their letters.
 */
export function Wordmark({
  className,
  size = 16,
  as: Tag = "p",
}: {
  className?: string;
  size?: number;
  /**
   * The brand line is a paragraph in the chrome. On the front door it is
   * the page's title, so the same reels render as the `h1` — assistive
   * technology reads the hidden name as the heading, never the reels.
   */
  as?: "p" | "h1";
}): ReactElement {
  const [slots] = useState(createSlots);
  const [settled] = useState(() => wordmarkSeams.revealed);
  useEffect(() => {
    wordmarkSeams.revealed = true;
  }, []);
  const classes = ["wordmark"];
  if (settled) classes.push("wordmark--settled");
  if (className) classes.push(className);
  return (
    <Tag className={classes.join(" ")}>
      <IconMark size={size} />
      <span className="visually-hidden">{WORDMARK}</span>
      <span className="wordmark__slots" aria-hidden="true">
        {slots.map((slot) => (
          <span
            key={slot.id}
            className="wordmark__slot"
            style={{
              animationDelay: slot.delay,
              animationDuration: slot.duration,
            }}
          >
            <span
              className="wordmark__reel"
              style={{
                animationDuration: slot.reelDuration,
                animationTimingFunction: `steps(${slot.steps}, end)`,
              }}
            >
              {slot.glyphs.map((cell) => (
                <span className="wordmark__glyph" key={cell.id}>
                  {cell.glyph}
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </Tag>
  );
}

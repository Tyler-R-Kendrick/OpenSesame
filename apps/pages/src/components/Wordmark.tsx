import {
  type ReactElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  CipherWordmark,
  type CipherWordmarkHandle,
  DISPLAY_WORD,
  FRAME_MS,
  MAX_STEPS,
  MIN_STEPS,
  WORDMARK_WIDTH_EM,
  cipherReel,
} from "./CipherWordmark/index.js";
import "./wordmark.css";

/**
 * Whether a wordmark has already revealed itself this session. The decrypt is
 * the one authored moment of an arrival; a second gate mounting seconds later
 * — the setup ceremony after the front door, the rail after unlock — arrives
 * still. Tests reset it between renders.
 */
export const wordmarkSeams = { revealed: false };

/** The accessible brand name every gate and the rail share. */
export const WORDMARK = "open-sesame";

/** Hex alphabet — the same glyphs a digest is written in. */
export const WORDMARK_CIPHER = "0123456789ABCDEF";

export {
  cipherReel,
  DISPLAY_WORD as WORDMARK_DISPLAY,
  FRAME_MS as WORDMARK_FRAME_MS,
  MIN_STEPS as WORDMARK_MIN_STEPS,
  MAX_STEPS as WORDMARK_MAX_STEPS,
};

export type WordmarkHandle = {
  replayCipher: () => void;
};

export type WordmarkFit = {
  /** The largest em the hero may take; the column's width sets the rest. */
  max: number;
};

/** A hero's em: the column divided by the wordmark's width, capped. */
export function fitEm(columnPx: number, fit: WordmarkFit): number {
  return Math.max(1, Math.min(fit.max, columnPx / WORDMARK_WIDTH_EM));
}

/**
 * Measure the parent column and size the hero to it. The tier follows the
 * em on its own: a 320px phone gets solid plates at 37px, never a cropped
 * field (particles need 48px to survive).
 */
function useFitEm(
  ref: { current: HTMLElement | null },
  fit: WordmarkFit | undefined,
): number | undefined {
  const [em, setEm] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const column = ref.current?.parentElement;
    if (!fit || !column) return;
    const measure = () => setEm(fitEm(column.clientWidth, fit));
    measure();
    if (globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [ref, fit]);
  return em;
}

/**
 * Brand wordmark: the mark and the name punched out of plates on a canvas
 * ({@link CipherWordmark}). The visual line is {@link DISPLAY_WORD}; the
 * accessible name is {@link WORDMARK}, read once. The decrypt runs once per
 * session; `replay` runs it again on this mount (the unlock gate).
 */
export const Wordmark = forwardRef<
  WordmarkHandle,
  {
    className?: string;
    /** Em height of the plates. Unset, the element's font-size decides. */
    size?: number;
    /** Fit a hero to its column instead of a fixed em. */
    fit?: WordmarkFit;
    /**
     * The brand line is a paragraph in the chrome. On the front door it is
     * the page's title, so the same plates render as the `h1` — assistive
     * technology reads the hidden name as the heading, never the canvas.
     */
    as?: "p" | "h1";
    replay?: boolean;
  }
>(function Wordmark(
  { className, size, fit, as: Tag = "p", replay = false },
  ref,
): ReactElement {
  const rootRef = useRef<HTMLElement | null>(null);
  const cipherRef = useRef<CipherWordmarkHandle>(null);
  const [animate] = useState(() => (replay ? true : !wordmarkSeams.revealed));
  const [settled] = useState(() => (replay ? false : wordmarkSeams.revealed));
  const fitted = useFitEm(rootRef, fit);

  useImperativeHandle(
    ref,
    () => ({
      replayCipher: () => {
        cipherRef.current?.replay();
      },
    }),
    [],
  );

  useEffect(() => {
    wordmarkSeams.revealed = true;
  }, []);

  const classes = ["wordmark"];
  if (settled && !replay) classes.push("wordmark--settled");
  if (className) classes.push(className);

  return (
    <Tag
      ref={(element: HTMLElement | null) => {
        rootRef.current = element;
      }}
      className={classes.join(" ")}
    >
      <span className="visually-hidden">{WORDMARK}</span>
      <span className="wordmark__slots" aria-hidden="true">
        <CipherWordmark
          ref={cipherRef}
          text={DISPLAY_WORD}
          size={fit ? fitted : size}
          animateOnMount={animate}
          replay={replay}
          static={settled && !replay}
          className="wordmark__cipher"
        />
      </span>
    </Tag>
  );
});

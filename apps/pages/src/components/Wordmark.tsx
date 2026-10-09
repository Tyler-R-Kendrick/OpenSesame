import {
  type ReactElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
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
  cipherReel,
} from "./CipherWordmark/index.js";
import { IconMark } from "./Icons.js";
import "./CipherWordmark/cipher-wordmark.css";

/**
 * Whether a wordmark has already revealed itself this session. The decrypt is
 * the one authored moment of an arrival; a second gate mounting seconds later
 * — the setup ceremony after the front door, the rail after unlock — arrives
 * still. Tests reset it between renders.
 */
export const wordmarkSeams = { revealed: false };

/** Accessible brand name (lowercase, hyphenated). */
export const WORDMARK = "open-sesame";

/** @deprecated Use {@link CIPHER} from CipherWordmark — uppercase on canvas. */
export const WORDMARK_CIPHER = "0123456789ABCDEF";

export {
  cipherReel,
  FRAME_MS as WORDMARK_FRAME_MS,
  MIN_STEPS as WORDMARK_MIN_STEPS,
  MAX_STEPS as WORDMARK_MAX_STEPS,
};

export type WordmarkHandle = {
  replayCipher: () => void;
};

/**
 * Brand wordmark: IconMark + lock-v5 particle-plate CipherWordmark. Visual
 * line is {@link DISPLAY_WORD}; assistive name is {@link WORDMARK}.
 */
export const Wordmark = forwardRef<
  WordmarkHandle,
  {
    className?: string;
    size?: number;
    as?: "p" | "h1";
    replay?: boolean;
  }
>(function Wordmark(
  { className, size = 16, as: Tag = "p", replay = false },
  ref,
): ReactElement {
  const cipherRef = useRef<CipherWordmarkHandle>(null);
  const [animate] = useState(() => (replay ? true : !wordmarkSeams.revealed));
  const [settled] = useState(() => (replay ? false : wordmarkSeams.revealed));

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
    <Tag className={classes.join(" ")}>
      <IconMark size={size} />
      <span className="visually-hidden">{WORDMARK}</span>
      <span className="wordmark__slots" aria-hidden="true">
        <CipherWordmark
          ref={cipherRef}
          text={DISPLAY_WORD}
          size={size}
          animateOnMount={animate}
          replay={replay}
          static={settled && !replay}
          className="wordmark__cipher"
        />
      </span>
    </Tag>
  );
});

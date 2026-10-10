import {
  type ReactElement,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { DecryptRun } from "./cipher.js";
import { DISPLAY_WORD } from "./cipher.js";
import type { Layout } from "./particles.js";
import { useCipherBoot } from "./use-cipher-boot.js";
import { useCipherLifecycle } from "./use-cipher-lifecycle.js";
import { prefersReducedMotion, useCipherPaint } from "./use-cipher-paint.js";

export type CipherWordmarkProps = {
  text?: string;
  /** Em height for plate layout; when unset, derived from computed font-size. */
  size?: number;
  animateOnMount?: boolean;
  replay?: boolean;
  showCursor?: boolean;
  /** When set, overrides `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** Skip animation; draw settled field frame. */
  static?: boolean;
  className?: string;
  onSettled?: () => void;
  /** Draw the mark at plate height inside the canvas. */
  includeMark?: boolean;
};

export type CipherWordmarkHandle = {
  replay: () => void;
};

function motionDisabled(
  staticSnapshot: boolean,
  reducedMotion: boolean | undefined,
): boolean {
  if (staticSnapshot || reducedMotion === true) return true;
  return reducedMotion === undefined && prefersReducedMotion();
}

function rootClass(settled: boolean, className: string | undefined): string {
  const classes = ["cipher-wordmark"];
  if (settled) classes.push("cipher-wordmark--settled");
  if (className) classes.push(className);
  return classes.join(" ");
}

/**
 * The name punched out of eleven plates on a canvas (lock-v5): a field of
 * ink particles at hero size, a solid plate in the chrome, letters alone in
 * the rail (`particles-model.ts` has the tiers). Every cell starts as hex
 * cipher; a cursor walks them left to right and locks one letter at a time.
 * Decorative: the parent carries the accessible name.
 */
export const CipherWordmark = forwardRef<
  CipherWordmarkHandle,
  CipherWordmarkProps
>(function CipherWordmark(props, ref): ReactElement {
  const {
    text = DISPLAY_WORD,
    size,
    animateOnMount = true,
    replay: replayProp = false,
    showCursor = true,
    reducedMotion,
    static: staticSnapshot = false,
    className,
    onSettled,
    includeMark = true,
  } = props;
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const runsRef = useRef<DecryptRun[]>([]);
  const rafRef = useRef<number>(0);
  const settledRef = useRef(false);
  const visibleRef = useRef(true);
  const [settled, setSettled] = useState(
    () => staticSnapshot || !animateOnMount,
  );
  const motionOff = motionDisabled(staticSnapshot, reducedMotion);
  const { startRun, settleRun, resize, paint, scheduleFrame } = useCipherPaint(
    {
      rootRef,
      canvasRef,
      layoutRef,
      runsRef,
      settledRef,
      visibleRef,
      rafRef,
    },
    {
      text,
      size,
      includeMark,
      showCursor,
      motionOff,
      onSettled,
      setSettled,
    },
  );

  useImperativeHandle(
    ref,
    () => ({
      replay: () => {
        startRun();
        scheduleFrame();
      },
    }),
    [startRun, scheduleFrame],
  );

  useCipherBoot({
    motionOff,
    animateOnMount,
    replayProp,
    startRun,
    settleRun,
    resize,
    paint,
    scheduleFrame,
  });
  useCipherLifecycle({
    rootRef,
    canvasRef,
    visibleRef,
    rafRef,
    resize,
    paint,
    scheduleFrame,
  });

  return (
    <span
      ref={rootRef}
      className={rootClass(settled, className)}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="cipher-wordmark__canvas" />
    </span>
  );
});

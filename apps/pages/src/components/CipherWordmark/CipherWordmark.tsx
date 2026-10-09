import {
  type ReactElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { readCanvas2d } from "./canvas-context.js";
import {
  DISPLAY_WORD,
  type DecryptRun,
  FRAME_MS,
  createSlotRuns,
  isSettled,
  pruneRuns,
} from "./cipher.js";
import {
  DRAW_CALIBRATION,
  type Layout,
  drawWordmark,
  layoutWordmark,
  readAccent,
  readInkRgb,
} from "./particles.js";
import "./cipher-wordmark.css";

export type CipherWordmarkTone = "default" | "rail";

export type CipherWordmarkProps = {
  text?: string;
  /** Em height for plate layout; when unset, derived from computed font-size. */
  size?: number;
  animateOnMount?: boolean;
  replay?: boolean;
  showCursor?: boolean;
  theme?: CipherWordmarkTone;
  /** When set, overrides `prefers-reduced-motion`. */
  reducedMotion?: boolean;
  /** Skip animation; draw settled field frame. */
  static?: boolean;
  className?: string;
  onSettled?: () => void;
  /** Draw the punched-plate icon mark inside the canvas (standalone demos). */
  includeMark?: boolean;
};

export type CipherWordmarkHandle = {
  replay: () => void;
};

const PAD = 4;
const GAP_EM = 0.28;

function nowMs(): number {
  const w = globalThis as { __vt?: number };
  if (typeof w.__vt === "number") return w.__vt;
  return performance.now();
}

function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function slotTimingsJson(runs: DecryptRun[]): string {
  const slots = runs[0]?.slots ?? [];
  return JSON.stringify(
    slots.map((s) => ({
      delay: s.delay * FRAME_MS,
      duration: s.duration * FRAME_MS,
      steps: s.steps,
      letter: s.letter,
    })),
  );
}

export const CipherWordmark = forwardRef<
  CipherWordmarkHandle,
  CipherWordmarkProps
>(function CipherWordmark(
  {
    text = DISPLAY_WORD,
    size,
    animateOnMount = true,
    replay: replayProp = false,
    showCursor = true,
    theme = "default",
    reducedMotion,
    static: staticSnapshot = false,
    className,
    onSettled,
    includeMark = false,
  },
  ref,
): ReactElement {
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

  const motionOff =
    staticSnapshot ||
    reducedMotion === true ||
    (reducedMotion === undefined && prefersReducedMotion());

  const startRun = useCallback(() => {
    const slots = createSlotRuns([...text], Math.random);
    runsRef.current = [{ t0: nowMs(), slots }];
    settledRef.current = false;
    setSettled(false);
    if (rootRef.current) {
      rootRef.current.dataset.cipherTimings = slotTimingsJson(runsRef.current);
    }
  }, [text]);

  useImperativeHandle(ref, () => ({
    replay: () => {
      startRun();
      scheduleFrame();
    },
  }));

  const resize = useCallback(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = readCanvas2d(canvas);
    if (!ctx) {
      if (rootRef.current && runsRef.current[0]) {
        rootRef.current.dataset.cipherTimings = slotTimingsJson(
          runsRef.current,
        );
      }
      return;
    }
    const emPx =
      size ?? (Number.parseFloat(getComputedStyle(root).fontSize) || 16);
    const layout = layoutWordmark(
      ctx,
      [...text],
      emPx,
      GAP_EM,
      PAD,
      includeMark,
    );
    layoutRef.current = layout;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round((layout.W + PAD * 2) * dpr);
    canvas.height = Math.round((layout.H + PAD * 2) * dpr);
    canvas.style.width = `${layout.W + PAD * 2}px`;
    canvas.style.height = `${layout.H + PAD * 2}px`;
    root.dataset.cipherTimings = slotTimingsJson(runsRef.current);
  }, [text, size, includeMark]);

  const paint = useCallback(
    (timeMs: number) => {
      const root = rootRef.current;
      const canvas = canvasRef.current;
      const layout = layoutRef.current;
      if (!root || !canvas || !layout) return;
      const ctx = readCanvas2d(canvas);
      if (!ctx) return;
      runsRef.current = pruneRuns(runsRef.current, timeMs);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const ink = readInkRgb(root);
      const accent = readAccent(document.documentElement);
      const frozen = motionOff || settledRef.current;
      drawWordmark(
        ctx,
        layout,
        runsRef.current,
        timeMs,
        dpr,
        PAD,
        ink,
        DRAW_CALIBRATION,
        frozen,
        includeMark,
        accent,
        showCursor,
      );
      const done = motionOff || isSettled(runsRef.current, timeMs);
      if (done && !settledRef.current) {
        settledRef.current = true;
        setSettled(true);
        onSettled?.();
      }
    },
    [motionOff, onSettled, showCursor, includeMark],
  );

  const scheduleFrame = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const loop = () => {
      if (!visibleRef.current) return;
      const t = nowMs();
      paint(t);
      if (!motionOff && !isSettled(runsRef.current, t)) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [motionOff, paint]);

  useEffect(() => {
    if (motionOff) {
      runsRef.current = [];
      settledRef.current = true;
      setSettled(true);
      resize();
      paint(nowMs());
      return;
    }
    if (animateOnMount || replayProp) {
      startRun();
    } else {
      runsRef.current = [];
      settledRef.current = true;
      setSettled(true);
    }
    resize();
    scheduleFrame();
  }, [
    animateOnMount,
    motionOff,
    paint,
    replayProp,
    resize,
    scheduleFrame,
    startRun,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            resize();
            paint(nowMs());
          })
        : null;
    ro?.observe(root);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            visibleRef.current = entries[0]?.isIntersecting ?? true;
            if (visibleRef.current) scheduleFrame();
          })
        : null;
    io?.observe(canvas);
    const onVis = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) scheduleFrame();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(rafRef.current);
    };
  }, [paint, resize, scheduleFrame]);

  const classes = ["cipher-wordmark"];
  if (theme === "rail") classes.push("cipher-wordmark--rail");
  if (settled) classes.push("cipher-wordmark--settled");
  if (className) classes.push(className);

  return (
    <span ref={rootRef} className={classes.join(" ")} aria-hidden="true">
      <canvas ref={canvasRef} className="cipher-wordmark__canvas" />
    </span>
  );
});

import {
  MAX_SEQUENCE,
  formatSequence,
  keycapLabel,
  parseSequence,
  tokenFromPress,
} from "@opensesame/app-core/lib/keymap/notation.js";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { StatusMark } from "../../../components/StatusMark.js";
import { keymapSeams } from "../../../lib/keymap.js";
import type { Refusal } from "./useBindFlow.js";

/**
 * Pressing a key beside the field must not take focus from it: Safari, iOS
 * and Firefox on macOS blur the field on a press and never focus the button,
 * so the capture would cancel before the click landed.
 */
export function keepFocus(event: { preventDefault: () => void }) {
  event.preventDefault();
}

/**
 * The presses held so far, kept as a sequence once nothing follows for the
 * keymap's timeout (or at the fourth press); Enter keeps them at once, or
 * reads what a soft keyboard typed.
 */
function usePressedKeys(
  onCommit: (sequence: string) => void,
  onCancel: () => void,
  problem: Refusal | null | undefined,
) {
  const [tokens, setTokens] = useState<string[]>([]);
  const [text, setText] = useState("");
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // A refused key clears the field for another try. Every refusal is a new
  // object, so the same message twice clears twice.
  useEffect(() => {
    if (problem) setTokens([]);
  }, [problem]);

  // Focus leaving the field drops what was half typed: it must not be kept
  // once the timeout lapses with the person somewhere else.
  const clear = () => {
    setTokens([]);
    setText("");
  };

  useEffect(() => {
    if (tokens.length === 0) return;
    if (tokens.length >= MAX_SEQUENCE) {
      commit.current(formatSequence(tokens));
      return;
    }
    const timer = setTimeout(
      () => commit.current(formatSequence(tokens)),
      keymapSeams.goTimeoutMs,
    );
    return () => clearTimeout(timer);
  }, [tokens]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const key = event.nativeEvent;
    if (key.key === "Tab") {
      clear();
      return;
    }
    if (key.isComposing) return;
    if (key.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (key.key === "Enter") {
      event.preventDefault();
      const typed = tokens.length > 0 ? tokens : parseSequence(text);
      if (typed && typed.length > 0) onCommit(formatSequence(typed));
      return;
    }
    const token = tokenFromPress(key);
    // A soft keyboard's blank key types into the field instead.
    if (token === null) return;
    event.preventDefault();
    setText("");
    setTokens((held) => [...held, token].slice(0, MAX_SEQUENCE));
  };

  return { tokens, text, setText, onKeyDown, clear };
}

/**
 * The keymap timeout as a custom property, not `animation-duration`: the
 * global reduced-motion rule forces that one to 0.01ms, and only the
 * stylesheet can answer it.
 */
function drainStyle(): CSSProperties {
  // SAFETY: structurally a CSSProperties; the typing only lacks an index for custom properties.
  return { "--kb-drain-ms": `${keymapSeams.goTimeoutMs}ms` } as CSSProperties;
}

/** A refused key: the mark, and the same words spoken — once per refusal. */
function Refused({ problem }: { problem: Refusal }) {
  return (
    <>
      <StatusMark tone="err" label={problem.message} />
      {/* Keyed by the refusal, so the same message twice is announced twice. */}
      <span key={problem.n} role="alert" className="visually-hidden">
        {problem.message}
      </span>
    </>
  );
}

/**
 * Where a key is recorded, in place of the keycap it replaces — never a
 * dialog. Press the keys: one press, or a sequence (`g v`, `Space f`), which
 * is kept once nothing follows for the keymap's own timeout — the hairline
 * under the field drains over exactly that time, so it teaches what the `g`
 * of `g v` will do at run time. Enter keeps what was pressed; Escape puts the
 * keycap back untouched; Tab leaves (the field never traps the keyboard).
 *
 * A soft keyboard that sends no key names can still type the notation
 * (`Control+d`, `g v`) and press Enter.
 */
export function KeyCapture({
  label,
  problem,
  onCommit,
  onCancel,
  children,
}: {
  /** What is being recorded: "New key for Next row". */
  label: string;
  /** Why the last attempt was refused, drawn as a mark. */
  problem?: Refusal | null;
  onCommit: (sequence: string) => void;
  onCancel: () => void;
  /** Keys that act on this capture (remove, cancel). */
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const pressing = useRef(false);
  const { tokens, text, setText, onKeyDown, clear } = usePressedKeys(
    onCommit,
    onCancel,
    problem,
  );

  useEffect(() => {
    input.current?.focus();
  }, []);

  // A press that began inside the capture is not focus leaving it.
  useEffect(() => {
    const lift = () => {
      pressing.current = false;
    };
    const events = ["pointerup", "pointercancel", "mouseup", "dragend"];
    for (const name of events) window.addEventListener(name, lift);
    return () => {
      for (const name of events) window.removeEventListener(name, lift);
    };
  }, []);

  // Trust where focus is now, not relatedTarget: a browser that does not
  // focus a pressed button reports none. Nothing to do once unmounted.
  const focusLeft = () =>
    queueMicrotask(() => {
      const held = wrap.current;
      if (!held?.isConnected || pressing.current) return;
      if (held.contains(document.activeElement)) return;
      onCancel();
    });

  const shown = tokens.length > 0 ? tokens.map(keycapLabel).join(" ") : text;

  return (
    <span
      ref={wrap}
      className="kb-capture"
      data-key-capture=""
      onBlur={focusLeft}
      onPointerDown={() => {
        pressing.current = true;
      }}
      onMouseDown={() => {
        pressing.current = true;
      }}
    >
      <span className="kb-capture__field">
        <input
          ref={input}
          className="kb-capture__input"
          aria-label={label}
          aria-invalid={problem ? true : undefined}
          placeholder="press keys"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={shown}
          onChange={(event) => {
            if (tokens.length === 0) setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={clear}
        />
        {tokens.length > 0 ? (
          <span
            key={tokens.length}
            className="kb-capture__drain"
            style={drainStyle()}
            aria-hidden="true"
          />
        ) : null}
      </span>
      {problem ? <Refused problem={problem} /> : null}
      {children}
    </span>
  );
}

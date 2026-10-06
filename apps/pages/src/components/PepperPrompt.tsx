/**
 * Asking for the pepper an older version sealed a password under (ADR 0174 §5).
 *
 * A pepper is not asked for and not stored now, so this is the one place one is
 * typed, and only to convert a password that older version made, once. It is a
 * `CeremonySheet`, so focus is trapped, Escape closes and the key that opened it
 * gets focus back. The value lives in this component's state and nowhere else:
 * it is handed to the caller once, on commit, and the state goes with the sheet.
 * It is never logged and never drawn outside the input.
 *
 * `usePepperPrompt()` is the promise-shaped way in: `ask` resolves with what
 * was typed and rejects with `PepperCancelled` when the sheet is closed.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CeremonySheet } from "./CeremonySheet.js";
import { FieldShell } from "./FieldShell.js";
import { FormCommit } from "./FormCommit.js";
import { IconKey } from "./IconKey.js";
import { IconEye, IconEyeOff, IconLock } from "./Icons.js";

export class PepperCancelled extends Error {
  constructor() {
    super("The pepper prompt was closed.");
    this.name = "PepperCancelled";
  }
}

export function isPepperCancelled<T>(caught: T): caught is T & PepperCancelled {
  return caught instanceof PepperCancelled;
}

export type PepperAskFn = (
  purpose: string,
  /** Names the field: "Earlier pepper", or "Master input" for Sphinx. */
  label?: string,
) => Promise<string>;

export function PepperPrompt({
  purpose,
  label = "Pepper",
  onSubmit,
  onCancel,
}: {
  purpose: string;
  label?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ready = value !== "";
  const commit = `Use ${label.toLowerCase()}`;
  const type = reveal ? "text" : "password";

  return (
    <CeremonySheet
      title={purpose}
      mark={<IconLock size={20} />}
      onClose={onCancel}
      initialFocus={input}
    >
      <form
        className="pepper"
        aria-label={purpose}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (ready) onSubmit(value);
        }}
      >
        <FieldShell
          inputRef={input}
          label={label}
          type={type}
          mono
          autoComplete="off"
          value={value}
          onValueChange={setValue}
          tail={
            <IconKey
              small
              label={
                reveal
                  ? `Hide ${label.toLowerCase()}`
                  : `Show ${label.toLowerCase()}`
              }
              aria-pressed={reveal}
              onClick={() => setReveal((on) => !on)}
            >
              {reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </IconKey>
          }
        />
        <FormCommit label={commit} disabled={!ready} />
      </form>
    </CeremonySheet>
  );
}

type Open = { purpose: string; label: string; key: number };
type Pending = {
  resolve: (value: string) => void;
  reject: (reason: PepperCancelled) => void;
};

/**
 * `element` is drawn once by the caller, outside any `<form>` of its own;
 * `ask` opens it. Asking again while it is open cancels the earlier ask.
 */
export type PepperPromptHandle = { ask: PepperAskFn; element: ReactNode };

export function usePepperPrompt(): PepperPromptHandle {
  const [open, setOpen] = useState<Open | null>(null);
  const pending = useRef<Pending | null>(null);
  const count = useRef(0);

  const settle = useCallback((outcome: "submit" | "cancel", value = "") => {
    const current = pending.current;
    pending.current = null;
    setOpen(null);
    if (!current) return;
    if (outcome === "submit") current.resolve(value);
    else current.reject(new PepperCancelled());
  }, []);

  const ask = useCallback<PepperAskFn>((purpose, label = "Pepper") => {
    return new Promise<string>((resolve, reject) => {
      pending.current?.reject(new PepperCancelled());
      pending.current = { resolve, reject };
      count.current += 1;
      setOpen({ purpose, label, key: count.current });
    });
  }, []);

  // Leaving the screen with the sheet open is a cancel, and holds no value.
  useEffect(
    () => () => {
      pending.current?.reject(new PepperCancelled());
      pending.current = null;
    },
    [],
  );

  const element = open ? (
    <PepperPrompt
      key={open.key}
      purpose={open.purpose}
      label={open.label}
      onSubmit={(value) => settle("submit", value)}
      onCancel={() => settle("cancel")}
    />
  ) : null;
  return { ask, element };
}

import {
  type DuressRefusal,
  type enableDuressCode,
  isAcceptableDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import {
  type DuressMode,
  type DuressModeId,
  MODES,
  getMode,
  inputReady,
} from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import { starterText } from "@opensesame/app-core/lib/duress/settings/modes/inputs.js";
import { activeProject } from "@opensesame/app-core/lib/projects.js";
import { type FormEvent, useState } from "react";
import type { Run } from "./run.js";

type Inputs = {
  armed: boolean;
  busy: boolean;
  run: Run;
  /** Closes the sheet; `message` is what the panel says, or nothing. */
  onDone: (message: string) => void;
  arm: typeof enableDuressCode;
};

function modeOf(id: DuressModeId): DuressMode {
  return getMode(id) ?? MODES[0];
}

/**
 * The duress sheet's form: the chosen mode, the code typed twice, the one
 * acknowledgement and what arming said back. A pick that changes the mode
 * takes the acknowledgement back and offers the new mode's starter lines (or
 * nothing), because the sentence ticked names one mode and a yes to it is not
 * a yes to another.
 */
export function useDuressCeremony({ armed, busy, run, onDone, arm }: Inputs) {
  const [modeId, setModeId] = useState<DuressModeId>(MODES[0].id);
  const mode = modeOf(modeId);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [extra, setExtra] = useState("");
  const [understoodFor, setUnderstoodFor] = useState<DuressModeId | null>(null);
  const [refusal, setRefusal] = useState<DuressRefusal | null>(null);
  const understood = understoodFor === modeId;
  const extras = mode.input.kind === "none" ? {} : { [mode.input.id]: extra };
  const inputOk = inputReady(mode, extras);
  const ready =
    isAcceptableDuressCode(first) && first === second && understood && inputOk;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setRefusal(null);
    void run(async () => {
      const result = await arm({
        code: first,
        mode: modeId,
        extras,
        vaultRef: activeProject().id,
      });
      if (!result.ok) {
        // Kept, so the person can fix it; the reason shows in the card.
        setRefusal(result.code);
        return;
      }
      setFirst("");
      setSecond("");
      onDone(armed ? "Duress code changed." : "Duress code is on.");
    }, null);
  }

  return {
    mode,
    modeId,
    extra,
    first,
    second,
    understood,
    refusal,
    ready,
    submit,
    setExtra,
    pick(next: DuressModeId) {
      setModeId(next);
      setExtra(starterText(modeOf(next)));
      setUnderstoodFor(null);
    },
    typeFirst(next: string) {
      setFirst(next.trim());
      setRefusal(null);
    },
    typeSecond(next: string) {
      setSecond(next.trim());
    },
    understand(on: boolean) {
      setUnderstoodFor(on ? modeId : null);
    },
  };
}

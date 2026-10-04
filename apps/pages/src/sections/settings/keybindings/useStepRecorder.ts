import {
  type KeymapEvent,
  MACRO_LIMITS,
  type MacroStep,
  stepProblem,
} from "@opensesame/app-core/lib/keymap/config.js";
import { MAX_SEQUENCE } from "@opensesame/app-core/lib/keymap/notation.js";
import { stepsFromKeys } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { useState } from "react";
import type { KeymapState } from "./useKeymap.js";

/**
 * Recording turns the keys pressed into steps on stop, leaving out — and
 * naming — whatever this macro's trigger may not run.
 */
export function useStepRecorder(
  steps: readonly MacroStep[],
  on: KeymapEvent | undefined,
  state: KeymapState,
  onChange: (steps: MacroStep[]) => void,
  afterStop: () => void,
) {
  const [recording, setRecording] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const finish = (refocus = true) => {
    const recorded = stepsFromKeys(tokens, state.config, state.commands);
    const allowed = recorded.steps.filter(
      (step) => stepProblem(step, on, state.commands) === null,
    );
    const refused = recorded.steps
      .filter((step) => !allowed.includes(step))
      .map((step) => step.command);
    setSkipped([...recorded.skipped, ...refused]);
    if (allowed.length > 0)
      onChange([...steps, ...allowed].slice(0, MACRO_LIMITS.steps));
    setTokens([]);
    setRecording(false);
    if (refocus) afterStop();
  };
  return {
    recording,
    tokens,
    skipped,
    toggle: () => {
      if (recording) {
        finish();
        return;
      }
      setSkipped([]);
      setRecording(true);
    },
    finish,
    add: (token: string) =>
      setTokens((held) =>
        held.length >= MACRO_LIMITS.steps * MAX_SEQUENCE
          ? held
          : [...held, token],
      ),
  };
}

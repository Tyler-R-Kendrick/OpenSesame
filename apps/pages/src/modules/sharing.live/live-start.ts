/**
 * Starting a session from the Form (ADR 0150 §2): the one press, its answer,
 * and what a failed start says. A start that is refused is a sentence on the
 * Form, never a rejected promise nobody holds.
 */

import { LiveRoutesRefused } from "@opensesame/app-core/lib/live/routes.js";
import {
  type HostInput,
  startHosting,
} from "@opensesame/app-core/lib/live/session.js";
import { useCallback, useState } from "react";

export type Starter = Readonly<{
  /** A start is under way: a second press would replace the first. */
  starting: boolean;
  /** Why the last start did not happen; empty when it did or none was made. */
  failed: string;
  start: (input: HostInput) => void;
}>;

export function useStartSession(): Starter {
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState("");
  const start = useCallback((input: HostInput) => {
    setFailed("");
    setStarting(true);
    startHosting(input)
      .catch((error) =>
        setFailed(
          error instanceof LiveRoutesRefused
            ? error.message
            : "The live session could not start",
        ),
      )
      .finally(() => setStarting(false));
  }, []);
  return { starting, failed, start };
}

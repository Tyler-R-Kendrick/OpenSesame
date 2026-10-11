/**
 * What a failed ceremony step says, and where it says it (ADR 0157, AGENTS.md
 * §5): a failure is never drawn in the page. The control that failed carries a
 * `StatusMark tone="err"` with the sentence, and the same sentence is one
 * notice in the tray, because inside a sheet the bell is out of reach.
 *
 * The engine's refusals are already sentences a person can act on ("this
 * packet was cut off or changed on the way"), so those pass through, worded as
 * sentences. Anything else — a stored value that no longer parses, a bug —
 * becomes one generic sentence: an internal message may name what a
 * ceremony was holding, and a notice is not the place for that.
 */

import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  AssertionError,
  EnrollmentError,
  EpochError,
  GuardianError,
  PacketError,
  PolicyError,
  QuorumGrantError,
  RecoveryError,
  RequestError,
} from "@opensesame/app-core/lib/quorum/index.js";
import { PrfCeremonyError } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-output.js";
import { useCallback, useMemo, useState } from "react";
import { useFailureNotice } from "../../components/use-failure-notice.js";

export const GENERIC_FAILURE = "That step did not finish.";
export const KEY_NOT_USED = "The security key was not used.";

/** A fragment such as "the key was not touched" as a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return GENERIC_FAILURE;
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** The refusals whose own `message` is written for a person. */
const OWN_WORDS = [
  AssertionError,
  DeskError,
  EnrollmentError,
  EpochError,
  GuardianError,
  PacketError,
  PolicyError,
  PrfCeremonyError,
  QuorumGrantError,
  RecoveryError,
  RequestError,
];

/** The sentence for a failed step. Never a stack, never a document. */
export function failureText(error: Error): string {
  // The browser refuses a key prompt that is dismissed or times out this way.
  if (error.name === "NotAllowedError") return KEY_NOT_USED;
  if (OWN_WORDS.some((own) => error instanceof own)) {
    return sentence(error.message);
  }
  return GENERIC_FAILURE;
}

/** How a step ended: its value, or that it failed and said so. */
export type Attempt<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false }>;

export type CeremonyFailure = Readonly<{
  /** The last failure's sentence; empty when the last step worked or none ran. */
  message: string;
  /**
   * Run one ceremony step. A throw becomes `message` (and the tray notice)
   * and `{ ok: false }`; the next step clears both before it starts.
   */
  run: <T>(step: () => Promise<T>) => Promise<Attempt<T>>;
  clear: () => void;
}>;

type Said = Readonly<{ message: string; count: number }>;

/**
 * One failing control's voice: pass `message` to a `StatusMark tone="err"`
 * on the control that failed, and the tray gets the notice under `id`.
 */
export function useCeremonyFailure(id: string, title: string): CeremonyFailure {
  const [said, setSaid] = useState<Said>({ message: "", count: 0 });
  // `count` makes an identical sentence raised again come back to the tray
  // after the person dismissed it.
  useFailureNotice(id, title, said.message, "err", { occurrence: said.count });
  const clear = useCallback(
    () =>
      setSaid((now) => (now.message === "" ? now : { ...now, message: "" })),
    [],
  );
  const run = useCallback(
    async function run<T>(step: () => Promise<T>): Promise<Attempt<T>> {
      clear();
      try {
        return { ok: true, value: await step() };
      } catch (caught) {
        const message =
          caught instanceof Error ? failureText(caught) : GENERIC_FAILURE;
        setSaid((now) => ({ message, count: now.count + 1 }));
        return { ok: false };
      }
    },
    [clear],
  );
  return useMemo(
    () => ({ message: said.message, run, clear }),
    [said.message, run, clear],
  );
}

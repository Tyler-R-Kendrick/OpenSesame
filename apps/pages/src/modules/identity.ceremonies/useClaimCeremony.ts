/**
 * The claim ceremony as React state (ADR 0140 plan step 8). The steps are
 * `createClaimCeremony`'s; this hook only asks for them and keeps the one it
 * got back. It adds three things a page needs:
 *
 *   - an arrival starts the ceremony (`claimStartFor`), and a new arrival —
 *     a pasted link — starts it again;
 *   - a session appearing while the claim waits for one picks it up, so
 *     connecting (or signing in and coming back) resumes without a press;
 *   - a failure's words go to the notifications tray as well as the mark,
 *     and a spent or finished claim is forgotten from the route's memory.
 */

import type {
  ClaimOpen,
  ClaimStep,
} from "@opensesame/app-core/lib/claims/ceremony.js";
import { claimCeremony } from "@opensesame/app-core/lib/claims/ceremony.js";
import type { ClaimArrival } from "@opensesame/app-core/lib/claims/link.js";
import { useClaimCeremonyState } from "./useClaimCeremony.state.js";
import { type ClaimTone, toneOf } from "./useClaimCeremony.tone.js";

export type { ClaimTone } from "./useClaimCeremony.tone.js";

export type ClaimView = Readonly<{
  step: ClaimStep;
  /** How the step's words read: a failure, or a wait for someone to sign in. */
  tone: ClaimTone | null;
  busy: boolean;
  /** Say something about the entry itself (a paste that is not a claim). */
  say: (words: string) => void;
  retry: () => void;
  guest: () => void;
  complete: (open: ClaimOpen, userCode: string) => void;
}>;

export { toneOf } from "./useClaimCeremony.tone.js";

export const claimHookSeams = {
  ceremony: (): typeof claimCeremony => claimCeremony,
};

export function useClaimCeremony(arrival: ClaimArrival): ClaimView {
  const ceremony = claimHookSeams.ceremony();
  const { step, busy, say, retry, guest, complete } = useClaimCeremonyState(
    ceremony,
    arrival,
  );
  return { step, tone: toneOf(step), busy, say, retry, guest, complete };
}

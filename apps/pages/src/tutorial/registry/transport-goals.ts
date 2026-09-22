/**
 * The transport walkthrough — kept out of `goals.ts` so that file's recorded
 * line debt does not rise (ADR 0093).
 *
 * Transport is optional (ADR 0130). A device with no endpoint configured has
 * nothing to ask, so the guide says that rather than sending somebody looking
 * for a service that is not there, and it names no address of its own.
 */

import type { GuideGoalDescriptor } from "./goals.js";

export const TRANSPORT_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "settings.transport",
    title: "Read the transport status for a target",
    routes: [],
    guide: [
      "guide/1",
      'goal "settings.transport"',
      'say "Transport is optional. This panel records which target this device asks about, by name, and shows what that target reported. It never holds a key, a path or a socket."',
      'wait state "vault.unlocked" is=true timeout=60000',
      'navigate "/settings/security"',
      'wait route "/settings/security" timeout=15000',
      'focus "settings.transport" "The record names a target, a policy and an identity by reference. The marks under it stay separate: what was asked for, what credential exists, what the runtime presents, what a peer observed, and whether anything is refused without a certificate. With no endpoint set they all sit idle and nothing is sent." side=bottom',
      "end",
    ].join("\n"),
  },
];

/**
 * Every sentence support says when something goes wrong.
 *
 * A person stuck in a vault gets a sentence, not a code and never a stack
 * trace: the failing identifier is the developer's half of the story, and the
 * half that leaks internals. Each map is keyed by a frozen union, so a new
 * failure code is a compile error here rather than a blank panel in front of
 * somebody who already could not work out what to do.
 */

import type { GuideRuntimeErrorCode } from "@opensesame/guide-runtime";
import type {
  SupportErrorCode,
  SupportUnavailableReason,
} from "@opensesame/support-agent";

/** Why nothing can answer — said plainly, including when the answer is "we can't". */
export const UNAVAILABLE_TEXT = {
  no_local_model:
    "This browser has no on-device model, and this deployment has no support endpoint configured. The written help below still works.",
  model_not_downloaded:
    "The on-device model has not been downloaded on this device yet.",
  no_remote_endpoint:
    "This deployment has no support endpoint configured, and this browser has no on-device model.",
  offline: "This device is offline, so nothing can be asked right now.",
  vault_locked: "The vault is locked.",
  platform_unsupported:
    "This browser cannot run a model on the device, and this deployment has no support endpoint configured.",
} satisfies Record<SupportUnavailableReason, string>;

export const SUPPORT_ERROR_TEXT = {
  AGENT_UNAVAILABLE: "Nothing is available to answer that right now.",
  AGENT_ABORTED: "Stopped.",
  AGENT_PROTOCOL_ERROR:
    "The answer did not arrive in one piece. Ask again, or use the written help below.",
  AGENT_OUTPUT_INVALID:
    "That answer came back in a form this app will not run, so none of it ran.",
  EGRESS_REFUSED: "That question was not allowed to leave this device.",
  VAULT_LOCKED: "The vault locked, so the conversation was dropped.",
} satisfies Record<SupportErrorCode, string>;

export const GUIDE_ERROR_TEXT = {
  TARGET_NOT_MOUNTED:
    "The walkthrough pointed at a control that is not on this screen, so it stopped here.",
  UNKNOWN_TARGET: "The walkthrough named a control this app does not have.",
  UNKNOWN_ROUTE: "The walkthrough named a screen this app does not have.",
  UNKNOWN_PREDICATE:
    "The walkthrough waited on something this app does not report.",
  GUIDE_VALIDATION_ERROR:
    "That walkthrough was not written in a form this app will run, so none of it ran.",
  GUIDE_TIMEOUT:
    "The walkthrough waited as long as it is allowed to and stopped. Nothing was changed.",
  GUIDE_SUPERSEDED: "A newer walkthrough took over.",
  VAULT_LOCKED: "The vault locked, so the walkthrough stopped.",
} satisfies Record<GuideRuntimeErrorCode, string>;

/**
 * A walkthrough the compiler refused. The codes it failed with are a
 * developer's fact; the person is told only that nothing ran.
 */
export const GUIDE_REFUSED_TEXT =
  "The walkthrough that came with that answer was refused before anything ran. The answer above still stands.";

/** The one sentence for a failure with no code at all. */
export const UNEXPECTED_TEXT =
  "Something went wrong on the way to an answer. The written help below does not need a model.";

export function supportErrorText(code: SupportErrorCode): string {
  return SUPPORT_ERROR_TEXT[code];
}

export function guideErrorText(code: GuideRuntimeErrorCode): string {
  return GUIDE_ERROR_TEXT[code];
}

export function unavailableText(reason: SupportUnavailableReason): string {
  return UNAVAILABLE_TEXT[reason];
}

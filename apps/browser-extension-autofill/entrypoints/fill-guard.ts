/**
 * The fill guard (ADR 0150 §6.4). An unlisted script: it has no manifest
 * `content_scripts` entry. The background registers it at runtime, top frame
 * only, for the sites a person switched on, and injects it into frame 0 only
 * as a fallback for a tab that loaded before its site was switched on.
 *
 * On load it does nothing but listen for an arm from this extension. It never
 * fills on load, never draws into the page, and never listens to the page.
 */
import {
  type RequestValue,
  answerArm,
  claimDocument,
  fromThisExtension,
} from "@/lib/fill/guard-runtime";
import { armMessage, valueReply } from "@/lib/fill/wire";

export default defineUnlistedScript(() => {
  if (!claimDocument(window)) return;
  const requestValue: RequestValue = async (request) => {
    const reply = valueReply.safeParse(
      await browser.runtime.sendMessage(request),
    );
    return reply.success ? reply.data : { refusal: "no_value" };
  };
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    const arm = armMessage.safeParse(message);
    if (!arm.success || !fromThisExtension(sender, browser.runtime.id)) {
      return undefined;
    }
    answerArm(window, requestValue, arm.data).then(respond, () =>
      respond({ outcome: "guard_failed" }),
    );
    return true;
  });
});

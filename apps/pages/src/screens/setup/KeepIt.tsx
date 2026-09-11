/**
 * The offer beneath the active setup step: keep it on this device.
 *
 * Not a step. The ceremony is a tab per concern (ADR 0114), and installing
 * is not one of them: it has no wrong answer, it is not asked before the
 * steps that matter, and it does not gate the commit. So it rides beneath
 * whichever step is on screen, above the same terminal `.go`.
 *
 * It earns its place there for a reason particular to a vault: the items are
 * stored on this device, and a browser is entitled to clear a tab's storage
 * when the device runs short of room. An installed app is not treated that
 * way. So this is not a growth nudge — it is the difference between a vault
 * the browser may clear and one it will not.
 *
 * The heading is `InstallOffer`'s own, deliberately: it is withheld with the
 * body on a browser that cannot install, so no host of the offer can leave a
 * heading standing over nothing by forgetting a guard of its own (ADR 0086).
 */

import { InstallOffer } from "../../components/InstallOffer.js";

export function KeepIt() {
  return <InstallOffer heading="Keep it on this device" />;
}

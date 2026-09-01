/**
 * The last section of first-run setup: keep it on this device.
 *
 * Not a step. The ceremony is deliberately one screen and one question —
 * *who signs people in* — with no stepper, no counter, no skip and no back
 * (ADR 0078). Installing is not a second question: it has no wrong answer, it
 * is not asked before the one that matters, and it does not gate the commit.
 * So it is a section beneath the allowlist, in the same `ways__head` voice as
 * "Add a provider" and "Or an OpenSesame identity service", above the same
 * terminal `.go`.
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

/**
 * Step 3 — identity. The one question the old screen asked, kept whole:
 * who signs people in. The allowlist lives in `WaysIn` and writes
 * `settings.v1` as it is edited.
 */

import { GuideTarget } from "../../../tutorial/registry/react.jsx";
import { WaysIn } from "../WaysIn.js";
import { StepHead } from "./shared.js";

export function IdentityStep() {
  return (
    <>
      <StepHead title="How do people sign in?">
        The compiled-in broker already works. Add an organisation's issuer or an
        identity service only if this deployment answers to one — a local vault
        with no accounts is a decision, not a gap.
      </StepHead>
      <GuideTarget id="setup.ways">
        <WaysIn />
      </GuideTarget>
    </>
  );
}

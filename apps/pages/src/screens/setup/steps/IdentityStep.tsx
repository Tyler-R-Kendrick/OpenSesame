/**
 * Step — identity. Ways-in allowlist (`WaysIn` → `settings.v1`).
 */

import { GuideTarget } from "../../../tutorial/registry/react.jsx";
import { WaysIn } from "../WaysIn.js";

export function IdentityStep() {
  return (
    <GuideTarget id="setup.ways">
      <WaysIn />
    </GuideTarget>
  );
}

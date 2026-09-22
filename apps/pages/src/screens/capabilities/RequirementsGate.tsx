/**
 * The requirements panel where a locked device first sees it — the front
 * door and the unlock form. Renders only while the plan has required roots
 * nobody has accepted; accept and review both go to setup's capabilities
 * tab (the one place a commit happens), decline hides it for this session
 * and writes nothing (MODEL-10).
 */

import { useState } from "react";
import {
  CAPABILITY_CATALOG,
  useComposition,
} from "../../lib/configuration/capabilities-ports.js";
import { InstallationRequirements } from "./InstallationRequirements.js";
import "./capabilities.css";

export function RequirementsGate({
  onOpenSetup,
}: {
  /** `join` true lands on the acceptance step; false on the roads. */
  onOpenSetup: (join: boolean) => void;
}) {
  const snapshot = useComposition();
  const [declined, setDeclined] = useState(false);
  const required = snapshot.plan?.consent.requiredNotAccepted ?? [];
  if (declined || required.length === 0) return null;
  return (
    <InstallationRequirements
      required={required}
      catalog={CAPABILITY_CATALOG}
      instanceId={snapshot.plan?.identity.instanceId ?? "this instance"}
      onAccept={() => onOpenSetup(true)}
      onDecline={() => setDeclined(true)}
      onReview={() => onOpenSetup(false)}
    />
  );
}

/**
 * Turn off Self-issued OpenID and Ambient single sign-on from the one-time
 * notice. This is the Features switch: a reviewed plan and a consent receipt.
 * Nothing here runs unless the person chooses Turn off. A failed commit is a
 * tray notice, not a box on the page.
 */

import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  appendStatusNotice,
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  LEGACY_IDENTITY_NOTICE_ID,
  LEGACY_IDENTITY_OFF_FAILURE,
  LEGACY_IDENTITY_OFF_FAILURE_ID,
  LEGACY_IDENTITY_RELOAD_BODY,
  LEGACY_IDENTITY_RELOAD_NOTICE_ID,
  type LegacyIdentityCapability,
  legacyIdentityTurnOffProposal,
} from "@opensesame/app-core/lib/vault/legacy-identity-notice.js";
import { commitProposal, currentRoots } from "./useCapabilityChange.js";

let turningOff = false;

function reloadToFinish(): void {
  location.reload();
}

export async function turnOffLegacyIdentity(
  enabled: readonly LegacyIdentityCapability[],
): Promise<void> {
  if (turningOff) return;
  turningOff = true;
  try {
    const snapshot = capabilityPorts.compositionStore.getSnapshot();
    const proposal = legacyIdentityTurnOffProposal(
      {
        roots: currentRoots(snapshot.selection),
        alternatives: snapshot.selection?.chosenAlternatives ?? {},
      },
      enabled,
      snapshot.plan,
      capabilityPorts.CAPABILITY_CATALOG,
    );
    const failure = await commitProposal(snapshot, proposal);
    if (failure) {
      setStatusNotice({
        id: LEGACY_IDENTITY_OFF_FAILURE_ID,
        tone: "err",
        title: "Identity",
        body: failure,
      });
      return;
    }
    dismissNotice(LEGACY_IDENTITY_NOTICE_ID);
    const after = capabilityPorts.compositionStore.getSnapshot();
    const waiting = enabled.some(
      (id) => after.plan?.capabilities[id]?.restartRequired === true,
    );
    if (!waiting) return;
    appendStatusNotice({
      id: LEGACY_IDENTITY_RELOAD_NOTICE_ID,
      tone: "info",
      title: "Identity",
      body: LEGACY_IDENTITY_RELOAD_BODY,
      retry: reloadToFinish,
      retryLabel: "Reload",
    });
  } catch {
    setStatusNotice({
      id: LEGACY_IDENTITY_OFF_FAILURE_ID,
      tone: "err",
      title: "Identity",
      body: LEGACY_IDENTITY_OFF_FAILURE,
    });
  } finally {
    turningOff = false;
  }
}

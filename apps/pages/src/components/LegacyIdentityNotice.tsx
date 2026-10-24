/**
 * One-time notice on unlock when this vault still approves Self-issued
 * OpenID or Ambient single sign-on. Fresh installs leave both off and see
 * nothing. The notice does not turn them off.
 *
 * Mounted after the toast stack so the arrival is heard. The seen marker
 * is sealed in vault prefs.
 */

import {
  appendStatusNotice,
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import {
  LEGACY_IDENTITY_OFF_FAILURE,
  LEGACY_IDENTITY_OFF_FAILURE_ID,
  LEGACY_IDENTITY_SAVE_FAILURE_ID,
  type LegacyIdentityNoticeDecision,
  raiseLegacyIdentityNotice,
} from "@opensesame/app-core/lib/vault/legacy-identity-notice.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect } from "react";
import { useComposition } from "../bindings/capabilities.js";
import { useVault } from "../lib/vault/hooks.js";

function failTurnOff(): void {
  setStatusNotice({
    id: LEGACY_IDENTITY_OFF_FAILURE_ID,
    tone: "err",
    title: "Identity",
    body: LEGACY_IDENTITY_OFF_FAILURE,
  });
}

function announceLegacyIdentity(notice: LegacyIdentityNoticeDecision): void {
  const input = {
    id: notice.id,
    tone: notice.tone,
    title: notice.title,
    body: notice.body,
    open: notice.open,
    act: {
      label: "Turn off",
      run: () => {
        void import("../sections/settings/legacy-identity-turn-off.js")
          .then((mod) => mod.turnOffLegacyIdentity(notice.enabled))
          .catch(failTurnOff);
      },
    },
  };
  // A restored tray row keeps the words and drops Turn off (the closure is
  // not sealed). Replace it so this unlock gets one arrival, with the act.
  dismissNotice(notice.id);
  appendStatusNotice(input);
}

export function LegacyIdentityNotice() {
  const vault = useVault();
  const composition = useComposition();
  useEffect(() => {
    raiseLegacyIdentityNotice(
      {
        status: vault.status,
        guest: vault.guest,
        tomb: vault.tomb,
        seen: vault.prefs.legacyIdentityNoticeSeen === true,
        ready: composition.status === "ready" && composition.plan !== null,
        approved: composition.plan?.approvedCapabilities ?? [],
      },
      {
        markSeen: () =>
          vaultStore.commitPrefs({ legacyIdentityNoticeSeen: true }),
        announce: announceLegacyIdentity,
        fail: (message) => {
          setStatusNotice({
            id: LEGACY_IDENTITY_SAVE_FAILURE_ID,
            tone: "err",
            title: "Identity",
            body: message,
          });
        },
      },
    );
  }, [
    vault.status,
    vault.guest,
    vault.tomb,
    vault.prefs.legacyIdentityNoticeSeen,
    composition.status,
    composition.plan,
  ]);
  return null;
}

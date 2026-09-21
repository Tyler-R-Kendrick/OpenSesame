import { useState } from "react";

import { connectorLabel } from "../lib/capabilities.js";
import {
  authorizeCapabilityConnector,
  bindCapabilityConnector,
  bindingNeedsAuth,
} from "../lib/capability-bind.js";
import { openConsentPopup } from "../lib/connections.js";
import { loadSettings } from "../lib/settings.js";
import { PBKDF2_ITERATIONS } from "../lib/vault/crypto.js";
import { preferenceMechanismLabel } from "../lib/vault/protection/protection-view.js";
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
import { IconLock, IconPasskey, IconShield } from "./Icons.js";
import { StatusNote } from "./StatusNote.js";

export const keyVaultCeremonyDependencies = {
  loadSettings,
  bindCapabilityConnector,
  authorizeCapabilityConnector,
  openConsentPopup,
};

/** Setup preference only — passkeys enroll under Unlock methods / Vault key protection. */
const LOCAL = ["webcrypto"] as const;
const RECOVERY = ["age"] as const;
const HARDWARE = ["yubikey"] as const;
const CLOUD = ["aws-kms", "azure-key-vault-keys", "gcp-kms"] as const;

type Flash = { tone: "ok" | "warn" | "err"; text: string } | null;

function preferenceName(providerId: string): string {
  const honest = preferenceMechanismLabel(providerId);
  if (honest !== providerId) return honest;
  return connectorLabel(providerId);
}

/**
 * Connection preference for protecting a vault key — not the enrolled
 * authority view. Enrollment and verification live under Settings › Security ›
 * Vault key protection. Binding writes a setup preference; without a matching
 * cryptographic record it is setup intent only (KP-04).
 */
export function KeyVaultCeremony({ onClose }: { onClose: () => void }) {
  const [binding, setBinding] = useState(
    () =>
      keyVaultCeremonyDependencies.loadSettings().capabilityConnectors
        .encryption,
  );
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

  const owesAuth = bindingNeedsAuth("encryption", binding);

  function choose(providerId: string) {
    const next = keyVaultCeremonyDependencies.bindCapabilityConnector(
      "encryption",
      providerId,
    );
    setBinding(next);
    setFlash({
      tone: "ok",
      text: `${preferenceName(providerId)} saved as a setup preference. Enroll it under Settings › Security › Vault key protection.`,
    });
  }

  function authorize() {
    // Opened on the click gesture — a popup created after an await is blocked.
    const popup = keyVaultCeremonyDependencies.openConsentPopup("about:blank");
    setBusy(true);
    setFlash(null);
    void (async () => {
      const outcome =
        await keyVaultCeremonyDependencies.authorizeCapabilityConnector(
          "encryption",
          popup,
        );
      setBinding(
        keyVaultCeremonyDependencies.loadSettings().capabilityConnectors
          .encryption,
      );
      setFlash(
        outcome.tone === "ok"
          ? {
              tone: "ok",
              text: `${preferenceName(binding.providerId)} authorized for vault key protection. Enroll it under Vault key protection.`,
            }
          : outcome,
      );
      setBusy(false);
    })();
  }

  const alts: CeremonyAlt[] = [
    {
      id: "local",
      label: "Password on this device",
      icon: <IconLock size={18} />,
      render: () => (
        <Picker ids={LOCAL} current={binding.providerId} onPick={choose} />
      ),
    },
    {
      id: "recovery",
      label: "age recipient (recovery)",
      icon: <IconPasskey size={18} />,
      render: () => (
        <Picker ids={RECOVERY} current={binding.providerId} onPick={choose} />
      ),
    },
    {
      id: "hardware",
      label: "YubiKey PIV (advanced)",
      icon: <IconPasskey size={18} />,
      render: () => (
        <Picker ids={HARDWARE} current={binding.providerId} onPick={choose} />
      ),
    },
    {
      id: "cloud",
      label: "Cloud KMS",
      icon: <IconShield size={18} />,
      render: () => (
        <Picker ids={CLOUD} current={binding.providerId} onPick={choose} />
      ),
    },
  ];

  return (
    <>
      <CeremonyShell
        ok={!owesAuth}
        top={owesAuth ? "Bound, not yet authorized" : "Setup preference"}
        name={preferenceName(binding.providerId)}
        facts={
          binding.providerId === "webcrypto"
            ? [
                { key: "Wrapping", value: "AES-GCM 256" },
                {
                  key: "Derivation",
                  value: `PBKDF2-SHA256 · ${PBKDF2_ITERATIONS.toLocaleString("en-US")} iterations`,
                },
                {
                  key: "Enrollment",
                  value: "Settings › Security › Vault key protection",
                },
              ]
            : binding.providerId === "age"
              ? [
                  { key: "Format", value: "age (typage)" },
                  { key: "Keys", value: "Settings › Security › Age key" },
                  {
                    key: "Enrollment",
                    value: "Settings › Security › Vault key protection",
                  },
                ]
              : [
                  { key: "Wrapping", value: "AES-GCM 256" },
                  {
                    key: "Authorization",
                    value: binding.connectionId ? "granted" : "not yet granted",
                  },
                  {
                    key: "Enrollment",
                    value: "Settings › Security › Vault key protection",
                  },
                ]
        }
        primary={
          owesAuth
            ? {
                label: busy ? "Authorizing…" : "Authorize connection",
                onClick: authorize,
                busy,
              }
            : {
                label: "Keep this preference",
                onClick: onClose,
              }
        }
        alts={alts}
      />
      {flash ? <StatusNote message={flash} /> : null}
    </>
  );
}

function Picker({
  ids,
  current,
  onPick,
}: {
  ids: readonly string[];
  current: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="picker">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className={`picker__opt${id === current ? " is-on" : ""}`}
          aria-pressed={id === current}
          onClick={() => onPick(id)}
        >
          <IconLock size={16} />
          <span>{preferenceName(id)}</span>
        </button>
      ))}
    </div>
  );
}

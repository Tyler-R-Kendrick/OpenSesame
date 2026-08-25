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
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
import { IconLock, IconPasskey, IconShield } from "./Icons.js";
import { StatusNote } from "./StatusNote.js";

export const keyVaultCeremonyDependencies = {
  loadSettings,
  bindCapabilityConnector,
  authorizeCapabilityConnector,
  openConsentPopup,
};

/** Hardware-backed choices, and the cloud services, as the catalog allows. */
const HARDWARE = ["yubikey", "fido2"] as const;
const CLOUD = ["aws-kms", "azure-key-vault-keys", "gcp-kms"] as const;

type Flash = { tone: "ok" | "warn" | "err"; text: string } | null;

/**
 * The key vault ceremony.
 *
 * Every provider offered here is already a legal binding in
 * `CAPABILITIES.encryption` — this sheet is not new product surface, it is the
 * existing catalog made reachable from the glyph that reports on it. Binding
 * writes settings immediately; the ones that need Host authorization run the
 * consent round trip in place rather than sending you to the connectors panel
 * to start again.
 */
export function KeyVaultCeremony({ onClose }: { onClose: () => void }) {
  const [binding, setBinding] = useState(
    () =>
      keyVaultCeremonyDependencies.loadSettings().capabilityConnectors
        .encryption,
  );
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);

  const builtIn = binding.providerId === "webcrypto";
  const owesAuth = bindingNeedsAuth("encryption", binding);

  function choose(providerId: string) {
    const next = keyVaultCeremonyDependencies.bindCapabilityConnector(
      "encryption",
      providerId,
    );
    setBinding(next);
    setFlash({
      tone: "ok",
      text: `${connectorLabel(providerId)} bound. ${
        bindingNeedsAuth("encryption", next)
          ? "Authorize it on Host to finish."
          : "Nothing else to do."
      }`,
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
      setFlash(outcome);
      setBusy(false);
    })();
  }

  const alts: CeremonyAlt[] = [
    {
      id: "hardware",
      label: "Bind a YubiKey or FIDO2 key",
      icon: <IconPasskey size={18} />,
      render: () => (
        <Picker ids={HARDWARE} current={binding.providerId} onPick={choose} />
      ),
    },
    {
      id: "cloud",
      label: "Bind a cloud KMS connector",
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
        top={owesAuth ? "Bound, not yet authorized" : "Active"}
        name={connectorLabel(binding.providerId)}
        facts={
          builtIn
            ? [
                { key: "Wrapping", value: "AES-GCM 256" },
                {
                  key: "Derivation",
                  value: `PBKDF2-SHA256 · ${PBKDF2_ITERATIONS.toLocaleString("en-US")} iterations`,
                },
              ]
            : [
                { key: "Wrapping", value: "AES-GCM 256" },
                {
                  key: "Authorization",
                  value: binding.connectionId ? "granted" : "not yet granted",
                },
              ]
        }
        primary={
          owesAuth
            ? {
                label: busy ? "Authorizing…" : "Authorize on Host",
                onClick: authorize,
                busy,
              }
            : {
                label: builtIn
                  ? "Keep the built-in vault"
                  : `Keep ${connectorLabel(binding.providerId)}`,
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
          <span>{connectorLabel(id)}</span>
        </button>
      ))}
    </div>
  );
}

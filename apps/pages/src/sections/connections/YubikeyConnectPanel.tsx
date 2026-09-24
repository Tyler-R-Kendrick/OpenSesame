/**
 * Settings › Connections › YubiKey — local PIV recipient configuration.
 *
 * Browser cannot drive PIV. The person pastes the public age-plugin-yubikey
 * recipient; OpenSesame seals it in the vault and can bind encryption to it.
 */

import { connectorLabel } from "@opensesame/app-core/lib/capabilities.js";
import { bindCapabilityConnector } from "@opensesame/app-core/lib/capability-bind.js";
import { fieldGuidance } from "@opensesame/app-core/lib/connector-guidance.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import { yubikeyPivAgeCapabilities } from "@opensesame/app-core/lib/vault/protection/adapters/yubikey-piv-age.js";
import {
  type YubikeyDeviceConfig,
  clearYubikeyConfig,
  readYubikeyConfig,
  writeYubikeyConfig,
} from "@opensesame/app-core/lib/yubikey-config.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useEffect, useId, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconLock, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";

type YubikeySettingsSlice = {
  capabilityConnectors: { encryption: { providerId: string } };
};

export const yubikeyConnectDependencies = {
  loadSettings: (): YubikeySettingsSlice => {
    const encryption = loadSettings().capabilityConnectors.encryption;
    return {
      capabilityConnectors: {
        encryption: { providerId: encryption.providerId },
      },
    } satisfies YubikeySettingsSlice;
  },
  bindCapabilityConnector,
  readYubikeyConfig,
  writeYubikeyConfig,
  clearYubikeyConfig,
  yubikeyPivAgeCapabilities,
};

type FormState = {
  recipient: string;
  slot: string;
  serialHint: string;
  label: string;
};

function emptyForm(): FormState {
  return { recipient: "", slot: "", serialHint: "", label: "" };
}

function formFromConfig(config: YubikeyDeviceConfig): FormState {
  return {
    recipient: config.recipient,
    slot: config.slot ?? "",
    serialHint: config.serialHint ?? "",
    label: config.label ?? "",
  };
}

export function YubikeyConnectPanel({
  onFlash,
}: {
  onFlash: (flash: Flash) => void;
}) {
  const { status, guest, tomb } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saved, setSaved] = useState<YubikeyDeviceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindingId, setBindingId] = useState(
    () =>
      yubikeyConnectDependencies.loadSettings().capabilityConnectors.encryption
        .providerId,
  );
  const recipientId = useId();
  const slotId = useId();
  const serialId = useId();
  const labelId = useId();
  const caps = yubikeyConnectDependencies.yubikeyPivAgeCapabilities();
  const active = bindingId === "yubikey";
  const configured = Boolean(saved?.recipient);

  useEffect(() => {
    if (!unlocked || !tomb) {
      setSaved(null);
      setForm(emptyForm());
      return;
    }
    let cancelled = false;
    void yubikeyConnectDependencies.readYubikeyConfig(tomb).then((next) => {
      if (cancelled) return;
      setSaved(next.recipient ? next : null);
      setForm(formFromConfig(next));
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, tomb]);

  function setField(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      onFlash({ tone: "warn", text: "Unlock a vault to seal this YubiKey." });
      return;
    }
    setBusy(true);
    try {
      const next = await yubikeyConnectDependencies.writeYubikeyConfig(tomb, {
        recipient: form.recipient,
        slot: form.slot,
        serialHint: form.serialHint,
        label: form.label,
      });
      setSaved(next);
      setForm(formFromConfig(next));
      onFlash({ tone: "ok", text: "YubiKey recipient sealed on this device." });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function preferYubikey() {
    const next = yubikeyConnectDependencies.bindCapabilityConnector(
      "encryption",
      "yubikey",
    );
    setBindingId(next.providerId);
    onFlash({
      tone: "ok",
      text: `${connectorLabel("yubikey")} selected for vault key protection preference.`,
    });
  }

  async function forget() {
    if (!tomb) return;
    setBusy(true);
    try {
      await yubikeyConnectDependencies.clearYubikeyConfig(tomb);
      setSaved(null);
      setForm(emptyForm());
      onFlash({ tone: "ok", text: "YubiKey configuration removed." });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="panel__body">
        <StatusMark
          tone="warn"
          label="Unlock a vault to configure a YubiKey on this device."
        />
      </div>
    );
  }

  const recipientHelp = fieldGuidance({
    name: "recipient",
    label: "Recipient",
    secret: false,
    required: true,
  });
  const slotHelp = fieldGuidance({
    name: "slot",
    label: "PIV slot",
    secret: false,
    required: false,
  });

  return (
    <div className="panel__body">
      <div className="conn-yubikey__status">
        <StatusMark
          tone={configured ? "ok" : "idle"}
          label={
            configured
              ? saved?.label || saved?.serialHint || "YubiKey recipient sealed"
              : "No YubiKey recipient sealed yet"
          }
        />
        <StatusMark
          tone={active ? "ok" : "idle"}
          label={
            active
              ? "Preferred for vault key protection"
              : "Not the encryption preference"
          }
        />
        <StatusMark
          tone={caps.runtime === "requires-native-client" ? "warn" : "ok"}
          label="PIV wrap needs the native client"
        />
      </div>

      <form className="conn-tile__body" onSubmit={save}>
        <div className="field">
          <label className="label conn-field-label" htmlFor={recipientId}>
            Recipient (required)
          </label>
          <input
            id={recipientId}
            name="recipient"
            type="text"
            autoComplete="off"
            required
            spellCheck={false}
            placeholder={recipientHelp.placeholder}
            title={recipientHelp.help}
            aria-describedby={`${recipientId}-help`}
            value={form.recipient}
            onChange={(event) => setField("recipient", event.target.value)}
          />
          <p className="hint" id={`${recipientId}-help`}>
            {recipientHelp.help}
          </p>
        </div>
        <details className="conn-client-alt">
          <summary>Optional settings</summary>
          <div className="field">
            <label className="label" htmlFor={labelId}>
              Name
            </label>
            <input
              id={labelId}
              value={form.label}
              onChange={(event) => setField("label", event.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={slotId}>
              PIV slot
            </label>
            <input
              id={slotId}
              value={form.slot}
              placeholder={slotHelp.placeholder}
              title={slotHelp.help}
              onChange={(event) => setField("slot", event.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={serialId}>
              Serial
            </label>
            <input
              id={serialId}
              value={form.serialHint}
              onChange={(event) => setField("serialHint", event.target.value)}
            />
          </div>
        </details>
        <FormCommit
          label={busy ? "Saving YubiKey" : "Save YubiKey"}
          disabled={busy}
        >
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy || !configured}
            aria-label="Prefer YubiKey for vault key protection"
            title="Prefer YubiKey for vault key protection"
            onClick={preferYubikey}
          >
            <IconLock size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            disabled={busy || !configured}
            aria-label="Remove YubiKey configuration"
            title="Remove YubiKey configuration"
            onClick={() => void forget()}
          >
            <IconTrash size={16} />
          </button>
        </FormCommit>
      </form>
    </div>
  );
}

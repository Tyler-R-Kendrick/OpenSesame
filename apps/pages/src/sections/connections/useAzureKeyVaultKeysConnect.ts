/**
 * State and actions for Settings › Connections › Azure Key Vault Keys.
 */

import { type FormEvent, useEffect, useState } from "react";
import {
  type AzureKeyVaultKeysDeviceConfig,
  clearAzureKeyVaultKeysConfig,
  readAzureKeyVaultKeysConfig,
  toAzureKeyVaultKeysPublic,
  writeAzureKeyVaultKeysConfig,
} from "../../lib/azure-key-vault-keys-config.js";
import { connectorLabel } from "../../lib/capabilities.js";
import { bindCapabilityConnector } from "../../lib/capability-bind.js";
import { loadSettings } from "../../lib/settings.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type AzureKeyVaultKeysFormState,
  emptyAzureKeyVaultKeysForm,
} from "./AzureKeyVaultKeysConnectFields.js";
import { type Flash, errorText } from "./shared.js";

type AzureSettingsSlice = {
  capabilityConnectors: { encryption: { providerId: string } };
};

export const azureKeyVaultKeysConnectDependencies = {
  loadSettings: (): AzureSettingsSlice => {
    const encryption = loadSettings().capabilityConnectors.encryption;
    return {
      capabilityConnectors: {
        encryption: { providerId: encryption.providerId },
      },
    } satisfies AzureSettingsSlice;
  },
  bindCapabilityConnector,
  readAzureKeyVaultKeysConfig,
  writeAzureKeyVaultKeysConfig,
  clearAzureKeyVaultKeysConfig,
};

function formFromConfig(
  config: AzureKeyVaultKeysDeviceConfig,
): AzureKeyVaultKeysFormState {
  return {
    versionedKeyId: config.versionedKeyId,
    tenantId: config.tenantId,
    clientId: config.clientId,
    clientSecret: "",
    label: config.label ?? "",
  };
}

function useSealedConfig(unlocked: boolean, tomb: string | null) {
  const [form, setForm] = useState(emptyAzureKeyVaultKeysForm);
  const [saved, setSaved] = useState<AzureKeyVaultKeysDeviceConfig | null>(
    null,
  );
  useEffect(() => {
    if (!unlocked || !tomb) {
      setSaved(null);
      setForm(emptyAzureKeyVaultKeysForm());
      return;
    }
    let cancelled = false;
    void azureKeyVaultKeysConnectDependencies
      .readAzureKeyVaultKeysConfig(tomb)
      .then((next) => {
        if (cancelled) return;
        setSaved(next.versionedKeyId ? next : null);
        setForm(formFromConfig(next));
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, tomb]);
  return { form, setForm, saved, setSaved };
}

export function useAzureKeyVaultKeysConnect(onFlash: (flash: Flash) => void) {
  const { status, guest, tomb } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const { form, setForm, saved, setSaved } = useSealedConfig(unlocked, tomb);
  const [busy, setBusy] = useState(false);
  const [bindingId, setBindingId] = useState(
    () =>
      azureKeyVaultKeysConnectDependencies.loadSettings().capabilityConnectors
        .encryption.providerId,
  );
  const active = bindingId === "azure-key-vault-keys";
  const configured = Boolean(saved?.versionedKeyId && saved.clientSecret);
  const publicView = saved ? toAzureKeyVaultKeysPublic(saved) : null;

  const setField = (key: keyof AzureKeyVaultKeysFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      onFlash({
        tone: "warn",
        text: "Unlock a vault to seal Azure Key Vault.",
      });
      return;
    }
    setBusy(true);
    try {
      const next =
        await azureKeyVaultKeysConnectDependencies.writeAzureKeyVaultKeysConfig(
          tomb,
          { ...form, keepExistingSecret: configured },
        );
      setSaved(next);
      setForm(formFromConfig(next));
      onFlash({
        tone: "ok",
        text: "Azure Key Vault Keys sealed on this device.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function preferAzure() {
    const next = azureKeyVaultKeysConnectDependencies.bindCapabilityConnector(
      "encryption",
      "azure-key-vault-keys",
    );
    setBindingId(next.providerId);
    onFlash({
      tone: "ok",
      text: `${connectorLabel("azure-key-vault-keys")} selected for vault key protection.`,
    });
  }

  async function forget() {
    if (!tomb) return;
    setBusy(true);
    try {
      await azureKeyVaultKeysConnectDependencies.clearAzureKeyVaultKeysConfig(
        tomb,
      );
      setSaved(null);
      setForm(emptyAzureKeyVaultKeysForm());
      onFlash({
        tone: "ok",
        text: "Azure Key Vault Keys configuration removed.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return {
    unlocked,
    form,
    busy,
    active,
    configured,
    statusLabel: publicView?.label || publicView?.clientId || null,
    setField,
    save,
    preferAzure,
    forget,
  };
}

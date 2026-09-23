/**
 * State and actions for Settings › Connections › Google Cloud KMS.
 */

import { connectorLabel } from "@opensesame/app-core/lib/capabilities.js";
import { bindCapabilityConnector } from "@opensesame/app-core/lib/capability-bind.js";
import {
  type GcpKmsDeviceConfig,
  clearGcpKmsConfig,
  readGcpKmsConfig,
  toGcpKmsPublic,
  writeGcpKmsConfig,
} from "@opensesame/app-core/lib/gcp-kms-config.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type GcpKmsFormState,
  emptyGcpKmsForm,
} from "./GcpKmsConnectFields.js";

type GcpSettingsSlice = {
  capabilityConnectors: { encryption: { providerId: string } };
};

export const gcpKmsConnectDependencies = {
  loadSettings: (): GcpSettingsSlice => {
    const encryption = loadSettings().capabilityConnectors.encryption;
    return {
      capabilityConnectors: {
        encryption: { providerId: encryption.providerId },
      },
    } satisfies GcpSettingsSlice;
  },
  bindCapabilityConnector,
  readGcpKmsConfig,
  writeGcpKmsConfig,
  clearGcpKmsConfig,
};

function formFromConfig(config: GcpKmsDeviceConfig): GcpKmsFormState {
  return {
    keyName: config.keyName,
    projectId: config.projectId,
    serviceAccountJson: "",
    label: config.label ?? "",
  };
}

function useSealedConfig(unlocked: boolean, tomb: string | null) {
  const [form, setForm] = useState(emptyGcpKmsForm);
  const [saved, setSaved] = useState<GcpKmsDeviceConfig | null>(null);
  useEffect(() => {
    if (!unlocked || !tomb) {
      setSaved(null);
      setForm(emptyGcpKmsForm());
      return;
    }
    let cancelled = false;
    void gcpKmsConnectDependencies.readGcpKmsConfig(tomb).then((next) => {
      if (cancelled) return;
      setSaved(next.keyName ? next : null);
      setForm(formFromConfig(next));
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, tomb]);
  return { form, setForm, saved, setSaved };
}

export function useGcpKmsConnect(onFlash: (flash: Flash) => void) {
  const { status, guest, tomb } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const { form, setForm, saved, setSaved } = useSealedConfig(unlocked, tomb);
  const [busy, setBusy] = useState(false);
  const [bindingId, setBindingId] = useState(
    () =>
      gcpKmsConnectDependencies.loadSettings().capabilityConnectors.encryption
        .providerId,
  );
  const active = bindingId === "gcp-kms";
  const configured = Boolean(saved?.keyName && saved.serviceAccountJson);
  const publicView = saved ? toGcpKmsPublic(saved) : null;

  const setField = (key: keyof GcpKmsFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      onFlash({
        tone: "warn",
        text: "Unlock a vault to seal Google Cloud KMS.",
      });
      return;
    }
    setBusy(true);
    try {
      const next = await gcpKmsConnectDependencies.writeGcpKmsConfig(tomb, {
        ...form,
        keepExistingSecret: configured,
      });
      setSaved(next);
      setForm(formFromConfig(next));
      onFlash({
        tone: "ok",
        text: "Google Cloud KMS credentials sealed on this device.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function preferGcpKms() {
    const next = gcpKmsConnectDependencies.bindCapabilityConnector(
      "encryption",
      "gcp-kms",
    );
    setBindingId(next.providerId);
    onFlash({
      tone: "ok",
      text: `${connectorLabel("gcp-kms")} selected for vault key protection.`,
    });
  }

  async function forget() {
    if (!tomb) return;
    setBusy(true);
    try {
      await gcpKmsConnectDependencies.clearGcpKmsConfig(tomb);
      setSaved(null);
      setForm(emptyGcpKmsForm());
      onFlash({ tone: "ok", text: "Google Cloud KMS configuration removed." });
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
    statusLabel: publicView?.label || publicView?.projectId || null,
    setField,
    save,
    preferGcpKms,
    forget,
  };
}

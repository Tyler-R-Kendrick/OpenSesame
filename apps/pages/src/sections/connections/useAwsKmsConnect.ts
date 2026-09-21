/**
 * State and actions for Settings › Connections › AWS KMS.
 */

import { type FormEvent, useEffect, useState } from "react";
import {
  type AwsKmsDeviceConfig,
  clearAwsKmsConfig,
  readAwsKmsConfig,
  toAwsKmsPublic,
  writeAwsKmsConfig,
} from "../../lib/aws-kms-config.js";
import { connectorLabel } from "../../lib/capabilities.js";
import { bindCapabilityConnector } from "../../lib/capability-bind.js";
import { loadSettings } from "../../lib/settings.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type AwsKmsFormState,
  emptyAwsKmsForm,
} from "./AwsKmsConnectFields.js";
import { type Flash, errorText } from "./shared.js";

type AwsKmsSettingsSlice = {
  capabilityConnectors: { encryption: { providerId: string } };
};

export const awsKmsConnectDependencies = {
  loadSettings: (): AwsKmsSettingsSlice => {
    const encryption = loadSettings().capabilityConnectors.encryption;
    return {
      capabilityConnectors: {
        encryption: { providerId: encryption.providerId },
      },
    } satisfies AwsKmsSettingsSlice;
  },
  bindCapabilityConnector,
  readAwsKmsConfig,
  writeAwsKmsConfig,
  clearAwsKmsConfig,
};

function formFromConfig(config: AwsKmsDeviceConfig): AwsKmsFormState {
  return {
    keyArn: config.keyArn,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: "",
    sessionToken: config.sessionToken ?? "",
    label: config.label ?? "",
  };
}

export function useAwsKmsConnect(onFlash: (flash: Flash) => void) {
  const { status, guest, tomb } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const [form, setForm] = useState<AwsKmsFormState>(emptyAwsKmsForm);
  const [saved, setSaved] = useState<AwsKmsDeviceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindingId, setBindingId] = useState(
    () =>
      awsKmsConnectDependencies.loadSettings().capabilityConnectors.encryption
        .providerId,
  );
  const active = bindingId === "aws-kms";
  const configured = Boolean(saved?.keyArn && saved.secretAccessKey);
  const publicView = saved ? toAwsKmsPublic(saved) : null;

  useEffect(() => {
    if (!unlocked || !tomb) {
      setSaved(null);
      setForm(emptyAwsKmsForm());
      return;
    }
    let cancelled = false;
    void awsKmsConnectDependencies.readAwsKmsConfig(tomb).then((next) => {
      if (cancelled) return;
      setSaved(next.keyArn ? next : null);
      setForm(formFromConfig(next));
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, tomb]);

  const setField = (key: keyof AwsKmsFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!tomb) {
      onFlash({ tone: "warn", text: "Unlock a vault to seal AWS KMS." });
      return;
    }
    setBusy(true);
    try {
      const next = await awsKmsConnectDependencies.writeAwsKmsConfig(tomb, {
        ...form,
        keepExistingSecret: configured,
      });
      setSaved(next);
      setForm(formFromConfig(next));
      onFlash({
        tone: "ok",
        text: "AWS KMS credentials sealed on this device.",
      });
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function preferAwsKms() {
    const next = awsKmsConnectDependencies.bindCapabilityConnector(
      "encryption",
      "aws-kms",
    );
    setBindingId(next.providerId);
    onFlash({
      tone: "ok",
      text: `${connectorLabel("aws-kms")} selected for vault key protection.`,
    });
  }

  async function forget() {
    if (!tomb) return;
    setBusy(true);
    try {
      await awsKmsConnectDependencies.clearAwsKmsConfig(tomb);
      setSaved(null);
      setForm(emptyAwsKmsForm());
      onFlash({ tone: "ok", text: "AWS KMS configuration removed." });
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
    statusLabel: publicView?.label || publicView?.accessKeyId || null,
    setField,
    save,
    preferAwsKms,
    forget,
  };
}

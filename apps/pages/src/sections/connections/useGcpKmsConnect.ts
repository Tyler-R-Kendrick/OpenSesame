/**
 * State and actions for Settings › Connections › Google Cloud KMS.
 */

import {
  type GcpKmsDeviceConfig,
  clearGcpKmsConfig,
  readGcpKmsConfig,
  toGcpKmsPublic,
  writeGcpKmsConfig,
} from "@opensesame/app-core/lib/gcp-kms-config.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type GcpKmsFormState,
  emptyGcpKmsForm,
} from "./GcpKmsConnectFields.js";

export const gcpKmsConnectDependencies = {
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
  const { status, guest, tomb, header } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const { form, setForm, saved, setSaved } = useSealedConfig(unlocked, tomb);
  const [busy, setBusy] = useState(false);
  const configured = Boolean(saved?.keyName && saved.serviceAccountJson);
  const publicView = saved ? toGcpKmsPublic(saved) : null;
  // A saved connection is what Test opens the protector with, so it is not
  // removable, and its key is not replaceable, while a protector on this key
  // is enrolled (ADR 0156 §3). Credentials for the same key may rotate.
  const enrolled = Boolean(
    saved?.keyName &&
      header?.protection?.records.some(
        (record) =>
          record.kind === "gcp-kms" && record.keyName === saved.keyName,
      ),
  );

  const setField = (key: keyof GcpKmsFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  async function save(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!tomb) {
      onFlash({
        tone: "warn",
        text: "Unlock a vault to seal Google Cloud KMS.",
      });
      return;
    }
    if (enrolled && form.keyName.trim() !== saved?.keyName) {
      onFlash({
        tone: "err",
        text: "A vault protector wraps with this key. Remove the protector before changing the crypto key.",
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
    enrolled,
    configured,
    statusLabel: publicView?.label || publicView?.projectId || null,
    setField,
    save,
    forget,
  };
}

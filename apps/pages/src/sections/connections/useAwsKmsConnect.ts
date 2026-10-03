/**
 * State and actions for Settings › Connections › AWS KMS.
 */

import {
  type AwsKmsDeviceConfig,
  clearAwsKmsConfig,
  readAwsKmsConfig,
  toAwsKmsPublic,
  writeAwsKmsConfig,
} from "@opensesame/app-core/lib/aws-kms-config.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type AwsKmsFormState,
  emptyAwsKmsForm,
} from "./AwsKmsConnectFields.js";

export const awsKmsConnectDependencies = {
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
  const { status, guest, tomb, header } = useVault();
  const unlocked = status === "unlocked" && !guest && Boolean(tomb);
  const [form, setForm] = useState<AwsKmsFormState>(emptyAwsKmsForm);
  const [saved, setSaved] = useState<AwsKmsDeviceConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = Boolean(saved?.keyArn && saved.secretAccessKey);
  const publicView = saved ? toAwsKmsPublic(saved) : null;
  // A saved connection is what Test opens the protector with, so it is not
  // removable, and its key is not replaceable, while a protector on this key
  // is enrolled (ADR 0150 §3). Credentials for the same key may rotate.
  const enrolled = Boolean(
    saved?.keyArn &&
      header?.protection?.records.some(
        (record) => record.kind === "aws-kms" && record.keyArn === saved.keyArn,
      ),
  );
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

  async function save(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!tomb) {
      onFlash({ tone: "warn", text: "Unlock a vault to seal AWS KMS." });
      return;
    }
    if (enrolled && form.keyArn.trim() !== saved?.keyArn) {
      onFlash({
        tone: "err",
        text: "A vault protector wraps with this key. Remove the protector before changing the key ARN.",
      });
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
    enrolled,
    configured,
    statusLabel: publicView?.label || publicView?.accessKeyId || null,
    setField,
    save,
    forget,
  };
}

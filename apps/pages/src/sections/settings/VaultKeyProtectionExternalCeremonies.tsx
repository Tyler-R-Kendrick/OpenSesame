/**
 * The three protectors that name a key held outside this session: an age
 * recipient, an AWS KMS key, a Google Cloud KMS key. Each is a body of the Add
 * sheet's choice list — it expands in place — and each ends in the one key
 * that commits its form. What runs is `vault-protector-enrollment-model`.
 */

import { readAwsKmsConfig } from "@opensesame/app-core/lib/aws-kms-config.js";
import { readGcpKmsConfig } from "@opensesame/app-core/lib/gcp-kms-config.js";
import {
  runCaught,
  status,
} from "@opensesame/app-core/sections/settings/vault-key-protection-ceremonies-model.js";
import {
  type AgeRecipientEntry,
  type AwsKmsEntry,
  type GcpKmsEntry,
  enrollAgeRecipientFlow,
  enrollAwsKmsFlow,
  enrollGcpKmsFlow,
  testAgeRecipientFlow,
} from "@opensesame/app-core/sections/settings/vault-protector-enrollment-model.js";
import { type ReactNode, useEffect, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconSecret } from "../../components/Icons.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  AwsKmsConnectFields,
  type AwsKmsFormState,
  emptyAwsKmsForm,
} from "../connections/AwsKmsConnectFields.js";
import {
  GcpKmsConnectFields,
  type GcpKmsFormState,
  emptyGcpKmsForm,
} from "../connections/GcpKmsConnectFields.js";
import { downloadOnce } from "./download-once.js";

/**
 * What the ceremonies call. A seam, so a test drives the sheets without the
 * vault, the network or a file download behind them.
 */
export const externalCeremonyDependencies = {
  readAwsKmsConfig,
  readGcpKmsConfig,
  enrollAgeRecipientFlow,
  enrollAwsKmsFlow,
  enrollGcpKmsFlow,
  testAgeRecipientFlow,
  downloadOnce,
};

function useTomb(): string {
  return useVault().tomb ?? "";
}

/** age-keygen's own file shape, so `age -d -i <file>` opens what it protects. */
function identityFile(identity: string, recipient: string): string {
  return `# public key: ${recipient}\n${identity}\n`;
}

export function AgeRecipientBody({
  onDone,
}: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const tomb = useTomb();
  const [recipient, setRecipient] = useState("");
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);

  const enroll = (entry: AgeRecipientEntry) => {
    setBusy(true);
    void runCaught(async () => {
      const enrolled =
        await externalCeremonyDependencies.enrollAgeRecipientFlow({
          protection: store.protection,
          tomb,
          entry,
          deliver: (delivery) =>
            externalCeremonyDependencies.downloadOnce(
              "opensesame-vault-age-identity.txt",
              identityFile(delivery.identity, delivery.recipient),
            ),
        });
      status(
        "info",
        "age recipient",
        entry.recipient.trim() === ""
          ? "Enrolled and proven. The identity was saved to a file — keep it outside this vault."
          : enrolled.proven
            ? "Enrolled and proven."
            : "Enrolled, not yet proven. Test it with its identity.",
      );
      onDone();
    }, "Could not enroll an age recipient.").finally(() => setBusy(false));
  };

  return (
    <>
      <FieldShell
        label="Recipient"
        value={recipient}
        onValueChange={setRecipient}
        placeholder="age1…"
        autoComplete="off"
        mono
        disabled={busy}
      />
      <FieldShell
        label="Identity to prove it"
        type="password"
        value={identity}
        onValueChange={setIdentity}
        placeholder="AGE-SECRET-KEY-1…"
        autoComplete="off"
        mono
        disabled={busy}
      />
      <FormCommit
        label="Add age recipient"
        busy={busy}
        disabled={busy || recipient.trim() === ""}
        onClick={() => enroll({ recipient, identity })}
      >
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Make a new age key"
          title="Make a new age key"
          disabled={busy}
          onClick={() => enroll({ recipient: "", identity: "" })}
        >
          <IconSecret size={16} />
        </button>
      </FormCommit>
    </>
  );
}

function awsFormFrom(saved: Awaited<ReturnType<typeof readAwsKmsConfig>>) {
  return {
    keyArn: saved.keyArn,
    region: saved.region,
    accessKeyId: saved.accessKeyId,
    secretAccessKey: "",
    sessionToken: saved.sessionToken ?? "",
    label: saved.label ?? "",
  } satisfies AwsKmsFormState;
}

export function AwsKmsBody({ onDone }: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const tomb = useTomb();
  const [form, setForm] = useState<AwsKmsFormState>(emptyAwsKmsForm);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void externalCeremonyDependencies.readAwsKmsConfig(tomb).then((saved) => {
      if (!live || !saved.keyArn) return;
      setConfigured(saved.secretAccessKey !== "");
      setForm(awsFormFrom(saved));
    });
    return () => {
      live = false;
    };
  }, [tomb]);
  const entry: AwsKmsEntry = { ...form };
  const ready =
    form.keyArn.trim() !== "" &&
    form.accessKeyId.trim() !== "" &&
    (configured || form.secretAccessKey.trim() !== "");
  return (
    <>
      <AwsKmsConnectFields
        form={form}
        configured={configured}
        onChange={(key, value) =>
          setForm((current) => ({ ...current, [key]: value }))
        }
      />
      <FormCommit
        label="Add AWS KMS"
        busy={busy}
        disabled={busy || !ready}
        onClick={() => {
          setBusy(true);
          void runCaught(async () => {
            await externalCeremonyDependencies.enrollAwsKmsFlow({
              protection: store.protection,
              tomb,
              entry,
            });
            status("info", "AWS KMS", "Enrolled and proven with the key.");
            onDone();
          }, "Could not enroll AWS KMS.").finally(() => setBusy(false));
        }}
      />
    </>
  );
}

function gcpFormFrom(saved: Awaited<ReturnType<typeof readGcpKmsConfig>>) {
  return {
    keyName: saved.keyName,
    projectId: saved.projectId,
    serviceAccountJson: "",
    label: saved.label ?? "",
  } satisfies GcpKmsFormState;
}

export function GcpKmsBody({ onDone }: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const tomb = useTomb();
  const [form, setForm] = useState<GcpKmsFormState>(emptyGcpKmsForm);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void externalCeremonyDependencies.readGcpKmsConfig(tomb).then((saved) => {
      if (!live || !saved.keyName) return;
      setConfigured(saved.serviceAccountJson !== "");
      setForm(gcpFormFrom(saved));
    });
    return () => {
      live = false;
    };
  }, [tomb]);
  const entry: GcpKmsEntry = { ...form };
  const ready =
    form.keyName.trim() !== "" &&
    (configured || form.serviceAccountJson.trim() !== "");
  return (
    <>
      <GcpKmsConnectFields
        form={form}
        configured={configured}
        onChange={(key, value) =>
          setForm((current) => ({ ...current, [key]: value }))
        }
      />
      <FormCommit
        label="Add Google Cloud KMS"
        busy={busy}
        disabled={busy || !ready}
        onClick={() => {
          setBusy(true);
          void runCaught(async () => {
            await externalCeremonyDependencies.enrollGcpKmsFlow({
              protection: store.protection,
              tomb,
              entry,
            });
            status(
              "info",
              "Google Cloud KMS",
              "Enrolled and proven with the key.",
            );
            onDone();
          }, "Could not enroll Google Cloud KMS.").finally(() =>
            setBusy(false),
          );
        }}
      />
    </>
  );
}

export function TestAgeCeremony({
  protectorId,
  onDone,
}: {
  protectorId: string;
  onDone: () => void;
}): ReactNode {
  const store = useVaultStore();
  const tomb = useTomb();
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <CeremonyShell
      ok={identity.length > 0}
      name="Test age recipient"
      primary={{
        label: "Test",
        busy,
        disabled: busy || identity.trim().length === 0,
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            await externalCeremonyDependencies.testAgeRecipientFlow({
              protection: store.protection,
              tomb,
              protectorId,
              identity,
            });
            status(
              "info",
              "Vault key protection",
              "Protector proof succeeded.",
            );
            onDone();
          }, "Protector proof failed.").finally(() => setBusy(false));
        },
      }}
    >
      <FieldShell
        label="Identity"
        type="password"
        value={identity}
        onValueChange={setIdentity}
        placeholder="AGE-SECRET-KEY-1…"
        autoComplete="off"
        mono
      />
    </CeremonyShell>
  );
}

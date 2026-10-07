import { checkWebauthnHost } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import {
  rotationKeeps,
  rotationLosses,
  runCaught,
  status,
} from "@opensesame/app-core/sections/settings/vault-key-protection-ceremonies-model.js";
import { type ReactNode, useRef, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import {
  IconAlert,
  IconPasskey,
  IconPlus,
  IconRefresh,
  IconSecret,
  IconShield,
  IconX,
} from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import {
  AgeRecipientBody,
  AwsKmsBody,
  GcpKmsBody,
  TestAgeCeremony,
  externalCeremonyDependencies,
} from "./VaultKeyProtectionExternalCeremonies.js";

export type ProtectionSheetKind =
  | "add"
  | "rotate"
  | "test-recovery"
  | "test-age";

export type ProtectionSheetRequest = {
  kind: ProtectionSheetKind;
  protectorId?: string;
};

export function AddKeyProtection({
  onDone,
}: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  const enroll = (
    kind: "recovery-key" | "webauthn-prf" | "age-webauthn",
    ok: [string, string],
    fallback: string,
  ) => {
    setBusy(true);
    void runCaught(async () => {
      const candidate = await store.protection.enrollCandidate(kind);
      if (candidate.recoverySecretB64) {
        externalCeremonyDependencies.downloadOnce(
          "opensesame-recovery-key.txt",
          `${candidate.recoverySecretB64}\n`,
        );
      }
      await store.protection.commitEnrollment(candidate.operationId);
      status("info", ok[0], ok[1]);
      onDone();
    }, fallback).finally(() => setBusy(false));
  };
  return (
    <CeremonyShell
      ok
      name="Add key protection"
      primary={{
        label: "Recovery key",
        choice: true,
        busy,
        disabled: busy,
        onClick: () =>
          enroll(
            "recovery-key",
            [
              "Recovery key",
              "Enrolled. Secret downloaded once — store it offline.",
            ],
            "Could not enroll recovery key.",
          ),
      }}
      secondary={{
        label: "Passkey / security key",
        choice: true,
        disabled: busy,
        onClick: () =>
          enroll(
            "webauthn-prf",
            ["Passkey / security key", "Passkey enrolled."],
            "Could not enroll a passkey protector.",
          ),
      }}
      alts={[
        {
          id: "age-recipient",
          label: "age recipient",
          icon: <IconSecret size={18} />,
          render: () => <AgeRecipientBody onDone={onDone} />,
        },
        {
          id: "age-webauthn",
          label: "age passkey (advanced)",
          icon: <IconPasskey size={18} />,
          render: () => (
            <FormCommit
              label="Add age passkey"
              busy={busy}
              disabled={busy}
              onClick={() =>
                enroll(
                  "age-webauthn",
                  ["Age WebAuthn", "Protector enrolled and proven."],
                  "Could not enroll Age WebAuthn.",
                )
              }
            />
          ),
        },
        {
          id: "aws-kms",
          label: "AWS KMS",
          icon: <IconShield size={18} />,
          render: () => <AwsKmsBody onDone={onDone} />,
        },
        {
          id: "gcp-kms",
          label: "Google Cloud KMS",
          icon: <IconShield size={18} />,
          render: () => <GcpKmsBody onDone={onDone} />,
        },
      ]}
    />
  );
}

function RotateCeremony({ onDone }: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const { header } = useVault();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  // Read once, when the sheet opens: the rotation rewrites the header.
  const [keeps] = useState(() => rotationKeeps(header, checkWebauthnHost().ok));
  const [lost] = useState(() => rotationLosses(header, keeps));
  const gone = lost.join(", ");
  // A master password is proved against what is enrolled and wrapped anew. A
  // vault without one is never given one (ADR 0180): it is re-keyed under a
  // new passkey, or a new PIN where the browser cannot make a passkey.
  const typed = keeps !== "passkey";
  const ready = !typed || secret.length > 0;
  const effect = {
    password: "A new vault key; the master password is wrapped anew",
    passkey: "A new vault key; a new passkey opens it",
    pin: "A new vault key; the new PIN opens it",
  }[keeps];
  return (
    <CeremonyShell
      ok={ready}
      name="Rotate compromised vault key"
      facts={[
        { key: "Effect", value: effect },
        { key: "Removed", value: gone === "" ? "nothing else" : gone },
      ]}
      primary={{
        label: "Rotate",
        icon: <IconRefresh size={18} />,
        busy,
        disabled: busy || !ready,
        tone: "danger",
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            await store.protection.rotateCompromisedRoot(
              keeps === "password"
                ? { password: secret }
                : keeps === "pin"
                  ? { pin: secret }
                  : { passkey: true },
            );
            status(
              "info",
              "Vault key protection",
              gone === ""
                ? "Vault key rotated."
                : `Vault key rotated. Removed with the old key: ${gone}. Add them again.`,
            );
            onDone();
          }, "Could not rotate the vault key.").finally(() => setBusy(false));
        },
      }}
    >
      {typed ? (
        <FieldShell
          label={keeps === "password" ? "Master password" : "New PIN"}
          type="password"
          value={secret}
          onValueChange={setSecret}
          autoComplete={
            keeps === "password" ? "current-password" : "new-password"
          }
          mono
        />
      ) : null}
    </CeremonyShell>
  );
}

function TestRecoveryCeremony({
  protectorId,
  onDone,
}: {
  protectorId: string;
  onDone: () => void;
}): ReactNode {
  const store = useVaultStore();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <CeremonyShell
      ok={secret.length > 0}
      name="Test recovery key"
      primary={{
        label: "Test",
        busy,
        disabled: busy || secret.length === 0,
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            await store.protection.testProtector(protectorId, {
              recoverySecretB64: secret,
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
        label="Recovery secret"
        type="password"
        value={secret}
        onValueChange={setSecret}
        mono
      />
    </CeremonyShell>
  );
}

const TITLE = {
  add: "Add",
  rotate: "Rotate",
  "test-recovery": "Test",
  "test-age": "Test",
} as const satisfies Record<ProtectionSheetKind, string>;

function sheetIcon(kind: ProtectionSheetKind, size: number): ReactNode {
  if (kind === "rotate") return <IconAlert size={size} />;
  if (kind === "test-recovery" || kind === "test-age") {
    return <IconSecret size={size} />;
  }
  return <IconPlus size={size} />;
}

export function VaultKeyProtectionSheet({
  request,
  onClose,
}: {
  request: ProtectionSheetRequest;
  onClose: () => void;
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);

  let body: ReactNode;
  if (request.kind === "add") {
    body = <AddKeyProtection onDone={onClose} />;
  } else if (request.kind === "rotate") {
    body = <RotateCeremony onDone={onClose} />;
  } else if (request.kind === "test-age") {
    body = (
      <TestAgeCeremony
        protectorId={request.protectorId ?? ""}
        onDone={onClose}
      />
    );
  } else {
    body = (
      <TestRecoveryCeremony
        protectorId={request.protectorId ?? ""}
        onDone={onClose}
      />
    );
  }

  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page
        role="dialog"
        aria-label={TITLE[request.kind]}
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            {sheetIcon(request.kind, 20)}
          </span>
          <div className="sheet__grow">
            <h2>{TITLE[request.kind]}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">{body}</div>
      </div>
    </div>
  );
}

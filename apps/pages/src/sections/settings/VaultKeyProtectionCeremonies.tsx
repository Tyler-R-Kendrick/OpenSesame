/**
 * Settings › Vault key protection — one sheet for add / rotate / test / age.
 * Matches Unlock methods: forms live in the sheet, never under a row.
 */

import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { ProtectionError } from "@opensesame/app-core/lib/vault/protection/errors.js";
import { type ReactNode, useRef, useState } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAlert,
  IconPasskey,
  IconPlus,
  IconSecret,
  IconX,
} from "../../components/Icons.js";
import { useModalFocus } from "../../lib/modal-focus.js";
import { useVaultStore } from "../../lib/vault/hooks.js";

export type ProtectionSheetKind =
  | "add"
  | "rotate"
  | "test-recovery"
  | "age-webauthn";

export type ProtectionSheetRequest = {
  kind: ProtectionSheetKind;
  protectorId?: string;
};

function status(
  tone: "info" | "warn" | "err",
  title: string,
  body: string,
): void {
  setStatusNotice({ id: "vault-key-protection", tone, title, body });
}

function downloadOnce(filename: string, body: string): void {
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function runCaught(
  work: () => Promise<void>,
  fallback: string,
): Promise<void> {
  try {
    await work();
  } catch (caught) {
    if (caught instanceof ProtectionError || caught instanceof Error) {
      status("err", "Vault key protection", caught.message);
      return;
    }
    status("err", "Vault key protection", fallback);
  }
}

function AddCeremony({
  onDone,
  onOpenAgeWebauthn,
}: {
  onDone: () => void;
  onOpenAgeWebauthn: () => void;
}): ReactNode {
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  const [unlockWithPasskey, setUnlockWithPasskey] = useState(true);
  return (
    <CeremonyShell
      ok
      name="Add key protection"
      facts={[{ key: "Policy", value: "Any enrolled method unlocks alone" }]}
      primary={{
        label: "Recovery key",
        busy,
        disabled: busy,
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            const candidate =
              await store.protection.enrollCandidate("recovery-key");
            await store.protection.commitEnrollment(candidate.operationId);
            if (candidate.recoverySecretB64) {
              downloadOnce(
                "opensesame-recovery-key.txt",
                `${candidate.recoverySecretB64}\n`,
              );
              status(
                "info",
                "Recovery key",
                "Enrolled. Secret downloaded once — store it offline.",
              );
            }
            onDone();
          }, "Could not enroll recovery key.").finally(() => setBusy(false));
        },
      }}
      secondary={{
        label: "age passkey (advanced)",
        disabled: busy,
        onClick: onOpenAgeWebauthn,
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={unlockWithPasskey}
          disabled={busy}
          onChange={(event) => setUnlockWithPasskey(event.target.checked)}
        />
        Use this passkey to unlock this vault
      </label>
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => {
            if (!unlockWithPasskey) {
              status(
                "info",
                "Passkey / security key",
                "Unchecked leaves vault protection unchanged. Enroll a sign-in passkey under Identity.",
              );
              return;
            }
            setBusy(true);
            void runCaught(async () => {
              const candidate =
                await store.protection.enrollCandidate("webauthn-prf");
              await store.protection.commitEnrollment(candidate.operationId);
              status(
                "info",
                "Passkey / security key",
                "This passkey can unlock the vault.",
              );
              onDone();
            }, "Could not enroll a passkey protector.").finally(() =>
              setBusy(false),
            );
          }}
        >
          Passkey / security key
        </button>
      </div>
    </CeremonyShell>
  );
}

function AgeWebauthnCeremony({ onDone }: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const [busy, setBusy] = useState(false);
  return (
    <CeremonyShell
      ok
      name="age passkey (advanced)"
      facts={[
        {
          key: "Runtime",
          value:
            "typage age.webauthn — prefer Unlock methods › Passkey (WebAuthn PRF) for vault unlock",
        },
      ]}
      primary={{
        label: "Enroll",
        busy,
        disabled: busy,
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            const candidate =
              await store.protection.enrollCandidate("age-webauthn");
            await store.protection.commitEnrollment(candidate.operationId);
            status("info", "Age WebAuthn", "Protector enrolled and proven.");
            onDone();
          }, "Could not enroll Age WebAuthn.").finally(() => setBusy(false));
        },
      }}
    />
  );
}

function RotateCeremony({ onDone }: { onDone: () => void }): ReactNode {
  const store = useVaultStore();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <CeremonyShell
      ok={password.length > 0}
      name="Rotate compromised vault key"
      facts={[
        { key: "Effect", value: "New root generation; re-enroll passkey/PIN" },
      ]}
      primary={{
        label: "Rotate",
        busy,
        disabled: busy || password.length === 0,
        tone: "danger",
        onClick: () => {
          setBusy(true);
          void runCaught(async () => {
            await store.protection.rotateCompromisedRoot({ password });
            status(
              "info",
              "Vault key protection",
              "Vault key rotated. Re-enroll passkey/PIN if you used them.",
            );
            onDone();
          }, "Could not rotate the vault key.").finally(() => setBusy(false));
        },
      }}
    >
      <FieldShell
        label="Master password"
        type="password"
        value={password}
        onValueChange={setPassword}
        autoComplete="current-password"
        mono
      />
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
  "age-webauthn": "Age WebAuthn",
} as const satisfies Record<ProtectionSheetKind, string>;

function sheetIcon(kind: ProtectionSheetKind, size: number): ReactNode {
  if (kind === "rotate") return <IconAlert size={size} />;
  if (kind === "age-webauthn") return <IconPasskey size={size} />;
  if (kind === "test-recovery") return <IconSecret size={size} />;
  return <IconPlus size={size} />;
}

export function VaultKeyProtectionSheet({
  request,
  onClose,
  onReplace,
}: {
  request: ProtectionSheetRequest;
  onClose: () => void;
  onReplace: (next: ProtectionSheetRequest) => void;
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);

  let body: ReactNode;
  if (request.kind === "add") {
    body = (
      <AddCeremony
        onDone={onClose}
        onOpenAgeWebauthn={() => onReplace({ kind: "age-webauthn" })}
      />
    );
  } else if (request.kind === "age-webauthn") {
    body = <AgeWebauthnCeremony onDone={onClose} />;
  } else if (request.kind === "rotate") {
    body = <RotateCeremony onDone={onClose} />;
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

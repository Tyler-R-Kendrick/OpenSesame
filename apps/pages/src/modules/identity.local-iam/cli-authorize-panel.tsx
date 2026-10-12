import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import { type FormEvent, useEffect, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import {
  type CliAuthorizeRow,
  cliAuthorizeAuthHeaders,
  daemonOrigin,
  parseFirstPending,
  postCliAuthorizeRespond,
} from "./cli-authorize-session.js";
import { cliAuthorizeUi } from "./cli-authorize-ui.js";
import { cliAuthorizeProofMethods } from "./cli-authorize-unlock-methods.js";

const ui = cliAuthorizeUi;

type ProofMode = "pin" | "passkey";

export function CliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [proofMode, setProofMode] = useState<ProofMode>("passkey");
  const [canPasskey, setCanPasskey] = useState(false);
  const [canPin, setCanPin] = useState(false);
  const [header, setHeader] = useState<VaultHeader | null>(null);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
    occurrence: number;
  } | null>(null);
  useFailureNotice(
    "cli-authorize-proof",
    failure?.title ?? "",
    failure?.message ?? null,
    "err",
    { occurrence: failure?.occurrence },
  );

  useEffect(() => {
    void (async () => {
      const origin = daemonOrigin();
      const headers = cliAuthorizeAuthHeaders();
      if (!origin || !headers) return setRow(null);
      const res = await localNetworkFetch(
        `${origin}/v1/cli/app-integration/pending`,
        {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers,
        },
      );
      if (!res.ok) return setRow(null);
      setRow(parseFirstPending(await res.json()));
    })();
  }, []);

  useEffect(() => {
    if (!approving) return;
    void import("@opensesame/app-core/lib/vault/store.js").then(
      ({ vaultStore }) => {
        const snapshotHeader = vaultStore.getSnapshot().header;
        setHeader(snapshotHeader);
        const methods = cliAuthorizeProofMethods(snapshotHeader);
        setCanPasskey(methods.includes("passkey"));
        setCanPin(methods.includes("pin"));
        setProofMode(methods.includes("passkey") ? "passkey" : "pin");
      },
    );
  }, [approving]);

  function noteFailure(title: string, message: string) {
    setFailure((prev) => ({
      title,
      message,
      occurrence: (prev?.occurrence ?? 0) + 1,
    }));
  }

  async function respond(
    decision: "approve" | "deny",
    humanProof?: string,
  ): Promise<boolean> {
    if (!row || busy) return false;
    setBusy(true);
    const ok = await postCliAuthorizeRespond(row, decision, humanProof);
    setBusy(false);
    if (ok) {
      setRow(null);
      setApproving(false);
      setPin("");
      setMark(null);
      return true;
    }
    return false;
  }

  async function finishApprove(humanProof: string) {
    setMark(null);
    const ok = await respond("approve", humanProof);
    if (!ok) {
      noteFailure("CLI authorization failed", "That did not work.");
      setMark("That did not work.");
    }
  }

  async function provePasskey() {
    if (!row || busy) return;
    setBusy(true);
    setMark(null);
    try {
      const { mintCliAuthorizePasskeyProof } = await import(
        "./cli-authorize-mint-proof.js"
      );
      const proof = await mintCliAuthorizePasskeyProof(row);
      setBusy(false);
      await finishApprove(proof);
    } catch (error) {
      setBusy(false);
      const message =
        error instanceof WrongPasswordError
          ? error.message
          : "Passkey confirmation was cancelled.";
      noteFailure("Passkey confirmation", message);
      setMark(message);
    }
  }

  async function provePin(event: FormEvent) {
    event.preventDefault();
    if (!row || !header || busy) return;
    setBusy(true);
    setMark(null);
    try {
      const { mintCliAuthorizePinProof } = await import(
        "./cli-authorize-mint-proof.js"
      );
      const proof = await mintCliAuthorizePinProof(row, pin, header);
      setBusy(false);
      await finishApprove(proof);
    } catch (error) {
      setBusy(false);
      const message =
        error instanceof WrongPasswordError
          ? error.message
          : "That PIN did not work.";
      noteFailure("PIN confirmation", message);
      setMark(message);
    }
  }

  function cancelApprove() {
    setApproving(false);
    setPin("");
    setMark(null);
  }

  if (approving && row) {
    if (!canPasskey && !canPin) {
      return (
        <section className="panel" aria-label={ui.sheetTitle}>
          <div className="panel__head">
            <h1>{ui.sheetTitle}</h1>
          </div>
          <div className="panel__body">
            <p>Unlock with a PIN or passkey on this device first.</p>
          </div>
        </section>
      );
    }

    return (
      <section className="panel" aria-label={ui.sheetTitle}>
        <div className="panel__head">
          <h1>{ui.sheetTitle}</h1>
          <IconKey label="Close" onClick={cancelApprove} disabled={busy}>
            <IconX size={16} />
          </IconKey>
        </div>
        <div className="panel__body">
          <p>{ui.sheetLead}</p>
          <p>
            <code className="identity-ref">{row[2]}</code>
          </p>
          {proofMode === "pin" && canPin ? (
            <form onSubmit={(e) => void provePin(e)}>
              <FieldShell
                label={ui.confirmPin}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder={ui.pinPlaceholder}
                value={pin}
                disabled={busy}
                onValueChange={setPin}
                status={mark ? <StatusMark tone="err" label={mark} /> : null}
              />
              <FormCommit
                label={ui.allowKey}
                disabled={busy || pin.length === 0}
                busy={busy}
              >
                {canPasskey ? (
                  <IconKey
                    label={ui.confirmPasskey}
                    disabled={busy}
                    onClick={() => setProofMode("passkey")}
                  >
                    <IconPasskey size={16} />
                  </IconKey>
                ) : null}
              </FormCommit>
            </form>
          ) : null}
          {proofMode === "passkey" && canPasskey ? (
            <FormCommit
              label={ui.confirmPasskey}
              disabled={busy}
              onClick={() => void provePasskey()}
            >
              {canPin ? (
                <IconKey
                  label={ui.confirmPin}
                  disabled={busy}
                  onClick={() => setProofMode("pin")}
                >
                  <IconPasskey size={16} />
                </IconKey>
              ) : null}
            </FormCommit>
          ) : null}
          {mark && proofMode === "passkey" ? (
            <output aria-live="polite">
              <StatusMark tone="err" label={mark} />
            </output>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="panel" aria-label={ui.sheetTitle}>
      <div className="panel__head">
        <h1>{ui.sheetTitle}</h1>
      </div>
      <div className="panel__body">
        {row === undefined ? <output>Reading CLI request…</output> : null}
        {row === null ? <p>No CLI request is waiting.</p> : null}
        {row ? (
          <>
            <p>{ui.sheetLead}</p>
            <p>
              <code className="identity-ref">{row[2]}</code>
            </p>
          </>
        ) : null}
        {row ? (
          <FormCommit
            label={ui.allowKey}
            disabled={busy}
            onClick={() => setApproving(true)}
          >
            <IconKey
              label={ui.denyKey}
              disabled={busy}
              onClick={() => void respond("deny")}
            >
              <IconX size={16} />
            </IconKey>
          </FormCommit>
        ) : null}
      </div>
    </section>
  );
}

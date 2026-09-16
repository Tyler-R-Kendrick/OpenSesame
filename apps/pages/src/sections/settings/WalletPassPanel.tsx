/**
 * Settings › Security › Google Wallet launcher.
 *
 * One persistent pass opens OpenSesame across many ephemeral interactions.
 * Issuance needs the hosted Identity wallet surface; without it the panel
 * explains the gap and leaves local approval alone.
 */

import { useCallback, useEffect, useState } from "react";
import { StatusNote } from "../../components/StatusNote.js";
import { isRemoteIdentityConfigured } from "../../lib/identity.js";
import {
  WalletRegistrationUnavailable,
  type WalletRegistrationWire,
  disableWalletLauncher,
  listWalletRegistrations,
  registerWalletLauncher,
} from "../../lib/wallet-registration.js";

function newRegistrationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `wl_${hex}`;
}

export function WalletPassPanel() {
  const hasIdentity = isRemoteIdentityConfigured();
  const [rows, setRows] = useState<readonly WalletRegistrationWire[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "err" | "warn";
    text: string;
  } | null>(null);
  const [saveUrl, setSaveUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasIdentity) return;
    try {
      setRows(await listWalletRegistrations());
    } catch (caught) {
      if (caught instanceof WalletRegistrationUnavailable) {
        setMessage({ tone: "warn", text: caught.message });
        setRows([]);
        return;
      }
      setMessage({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not list passes",
      });
    }
  }, [hasIdentity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = async () => {
    setBusy(true);
    setMessage(null);
    setSaveUrl(null);
    try {
      const result = await registerWalletLauncher({
        registrationId: newRegistrationId(),
        header: "OpenSesame",
        subtitle: "Open your vault",
      });
      setSaveUrl(result.saveUrl);
      setMessage({
        tone: "ok",
        text: result.reissued
          ? "Save link re-issued for your existing pass."
          : "Pass registered. Open the Save link to add it to Google Wallet.",
      });
      await refresh();
    } catch (caught) {
      setMessage({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not register pass",
      });
    } finally {
      setBusy(false);
    }
  };

  const onDisable = async (registrationId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await disableWalletLauncher(registrationId);
      setMessage({
        tone: "ok",
        text: outcome.googleAcknowledged
          ? "Pass disabled here and at Google."
          : "Pass disabled here. Google expiry will retry when reachable.",
      });
      await refresh();
    } catch (caught) {
      setMessage({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not disable pass",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="settings-wallet-pass">
      <div className="panel__head">
        <div>
          <h2 id="settings-wallet-pass">Google Wallet</h2>
          <p className="hint">
            One persistent launcher pass. It opens OpenSesame; it never carries
            a live approval or a credential.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {!hasIdentity ? (
          <p className="hint">
            Configure an Identity API to enroll a Google Wallet pass. Local
            approvals keep working without it.
          </p>
        ) : (
          <>
            <div className="row gap">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void onAdd()}
              >
                Add to Google Wallet
              </button>
            </div>
            {saveUrl ? (
              <p className="hint">
                <a href={saveUrl} rel="noopener noreferrer" target="_blank">
                  Open Save link
                </a>
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="hint">No launcher passes on this account yet.</p>
            ) : (
              <ul className="list">
                {rows.map((row) => (
                  <li key={row.registrationId} className="list__row">
                    <div>
                      <strong>{row.registrationId}</strong>
                      <span className="hint"> · {row.state}</span>
                    </div>
                    {row.state === "active" ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void onDisable(row.registrationId)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {message ? <StatusNote message={message} /> : null}
      </div>
    </section>
  );
}

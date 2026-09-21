import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type LocalPasskey,
  readLocalPasskeys,
  revokeLocalPasskey,
} from "../../lib/local-credentials.js";
import { LocalDirectoryError } from "../../lib/local-directory.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  type LocalPasskeyVaultOffer,
  viewBuffer,
} from "../../lib/local-passkeys.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { LocalIdentitySession } from "./LocalIdentitySession.js";

type CredentialProps = {
  tomb: string;
  principalId: string;
  disabled: boolean;
  enabled: boolean;
};

export function LocalPasskeys({
  tomb,
  principalId,
  disabled,
  enabled,
}: CredentialProps) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Passkeys</summary>
      {open ? (
        <CredentialCommands
          key={`${tomb}:${principalId}`}
          tomb={tomb}
          principalId={principalId}
          disabled={disabled}
          enabled={enabled}
        />
      ) : null}
    </details>
  );
}

function useTrackedPasskeys(
  tomb: string,
  principalId: string,
  container: RefObject<HTMLDivElement | null>,
  focusSource: RefObject<HTMLElement | null>,
  setRemoving: (update: (id: string | null) => string | null) => void,
) {
  const [keys, setKeys] = useState<LocalPasskey[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let generation = 0;
    const rememberFocus = () => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        container.current?.contains(focused)
      )
        focusSource.current = focused;
    };
    const refresh = () => {
      const current = ++generation;
      void readLocalPasskeys(tomb)
        .then((rows) => {
          if (!active || current !== generation) return;
          rememberFocus();
          setKeys(rows.filter((row) => row.principalId === principalId));
          setError("");
          setRemoving((id) =>
            rows.some((row) => row.credentialId === id) ? id : null,
          );
        })
        .catch(() => {
          if (!active || current !== generation) return;
          rememberFocus();
          setKeys(null);
          setError(
            "Could not read passkeys. Unlock the vault, then reopen Passkeys.",
          );
        });
    };
    const off = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      active = false;
      off();
      window.removeEventListener("focus", refresh);
    };
  }, [tomb, principalId, container, focusSource, setRemoving]);
  return { keys, setKeys, error, setError };
}

function usePasskeyVaultOffer(
  busy: boolean,
  setBusy: (busy: boolean) => void,
  setMessage: (message: string) => void,
  setError: (error: string) => void,
) {
  const [offer, setOffer] = useState<LocalPasskeyVaultOffer | null>(null);
  const [unlockChecked, setUnlockChecked] = useState(false);
  const offerRef = useRef<LocalPasskeyVaultOffer | null>(null);
  const store = useVaultStore();
  useEffect(() => {
    return () => {
      offerRef.current?.discard();
      offerRef.current = null;
    };
  }, []);
  function publishOffer(next: LocalPasskeyVaultOffer | null) {
    if (offerRef.current && offerRef.current !== next)
      offerRef.current.discard();
    offerRef.current = next;
    setOffer(next);
  }
  function keepSignInOnly() {
    publishOffer(null);
    setUnlockChecked(false);
    setMessage("Sign-in only. Vault protection was not changed.");
  }
  async function alsoUnlock() {
    if (!offer || !unlockChecked || busy) return;
    setBusy(true);
    setError("");
    try {
      const candidate = await store.protection.enrollHeldWebauthnPrf({
        prfOutput: viewBuffer(offer.prfOutput),
        prfSalt: offer.prfSalt,
        credentialId: offer.credentialId,
        userId: viewBuffer(offer.userId),
      });
      await store.protection.commitEnrollment(candidate.operationId);
      publishOffer(null);
      setUnlockChecked(false);
      setMessage("This passkey can unlock the vault.");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not add this passkey to vault protection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    offer,
    unlockChecked,
    setUnlockChecked,
    publishOffer,
    keepSignInOnly,
    alsoUnlock,
  };
}

function useCredentialCommands(
  { tomb, principalId, disabled, enabled }: CredentialProps,
  container: RefObject<HTMLDivElement | null>,
) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const { status } = useVault();
  const focusSource = useRef<HTMLElement | null>(null);
  const tracked = useTrackedPasskeys(
    tomb,
    principalId,
    container,
    focusSource,
    setRemoving,
  );
  const vaultOffer = usePasskeyVaultOffer(
    busy,
    setBusy,
    setMessage,
    tracked.setError,
  );
  async function run(action: "enroll" | "revoke", id?: string) {
    if (busy || disabled || !tracked.keys) return;
    if (action === "enroll" && !enabled) return;
    if (action === "revoke" && document.activeElement instanceof HTMLElement)
      focusSource.current = document.activeElement;
    setBusy(true);
    tracked.setError("");
    setMessage("");
    try {
      if (action === "revoke") {
        if (!id) return;
        await revokeLocalPasskey(tomb, principalId, id);
        tracked.setKeys(
          (await readLocalPasskeys(tomb)).filter(
            (row) => row.principalId === principalId,
          ),
        );
        setRemoving(null);
        setMessage("Passkey revoked.");
        return;
      }
      const passkeys = await import("../../lib/local-passkeys.js");
      const enrolled = await passkeys.enrollLocalPasskey(tomb, principalId);
      tracked.setKeys(
        (await readLocalPasskeys(tomb)).filter(
          (row) => row.principalId === principalId,
        ),
      );
      setRemoving(null);
      if (!enrolled.vaultOffer) {
        vaultOffer.publishOffer(null);
        setMessage(
          "Passkey enrolled. This authenticator cannot unlock the vault.",
        );
        return;
      }
      if (status !== "unlocked") {
        enrolled.vaultOffer.discard();
        vaultOffer.publishOffer(null);
        setMessage(
          "Passkey enrolled. The vault is locked, so vault protection was not changed.",
        );
        return;
      }
      vaultOffer.setUnlockChecked(false);
      vaultOffer.publishOffer(enrolled.vaultOffer);
      setMessage(
        "Passkey created. This passkey supports encrypted vault unlock.",
      );
    } catch (failure) {
      tracked.setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "The passkey operation did not complete. Check the vault is unlocked and retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    keys: tracked.keys,
    busy,
    message,
    error: tracked.error,
    removing,
    setRemoving,
    run,
    focusSource,
    ...vaultOffer,
  };
}

function CredentialCommands(props: CredentialProps) {
  const container = useRef<HTMLDivElement>(null);
  const model = useCredentialCommands(props, container);
  const { keys, busy, message, error, run } = model;
  const { focusSource } = model;
  useLayoutEffect(() => {
    if (busy || !focusSource.current) return;
    const previous = focusSource.current;
    focusSource.current = null;
    if (!previous.isConnected && document.activeElement === document.body)
      container.current?.closest("details")?.querySelector("summary")?.focus();
  });
  const disabled = props.disabled || !props.enabled;
  return (
    <div ref={container} aria-busy={busy}>
      <p className="hint">
        Passkeys identify this person in this vault. Enrollment is a
        vault-custodian action; application access requires a separate grant.
      </p>
      {error ? (
        <p className="note note--err" role="alert">
          {error}
        </p>
      ) : null}
      <output aria-label="Passkey status">
        {busy ? "Complete the passkey operation…" : message}
      </output>
      {model.offer ? (
        <div className="identity-passkey-offer">
          <label>
            <input
              type="checkbox"
              checked={model.unlockChecked}
              disabled={busy}
              onChange={(event) => model.setUnlockChecked(event.target.checked)}
            />
            Use this passkey to unlock this vault
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={model.keepSignInOnly}
            >
              Keep sign-in only
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy || !model.unlockChecked}
              onClick={() => void model.alsoUnlock()}
            >
              Also unlock this vault
            </button>
          </div>
        </div>
      ) : null}
      {!keys && !error ? <output>Loading passkeys…</output> : null}
      <div className="actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={disabled || busy || !keys}
          onClick={() => void run("enroll")}
        >
          Enroll passkey
        </button>
      </div>
      <LocalIdentitySession
        tomb={props.tomb}
        principalId={props.principalId}
        disabled={disabled || busy || !keys?.length}
      />
      {keys?.length === 0 ? (
        <p className="hint">No passkeys enrolled.</p>
      ) : null}
      <CredentialRows model={model} disabled={props.disabled} />
    </div>
  );
}

function CredentialRows({
  model,
  disabled,
}: {
  model: ReturnType<typeof useCredentialCommands>;
  disabled: boolean;
}) {
  const { keys, busy, removing, setRemoving, run } = model;
  return (
    <ul className="identity-passkeys">
      {keys?.map((key) => (
        <li key={key.credentialId}>
          <div className="identity-row__main">
            <span>Passkey · {key.credentialId.slice(-8)}</span>
            <span className="hint">
              Enrolled {new Date(key.createdAt).toLocaleDateString()}
              {key.prfCapable
                ? " · This passkey supports encrypted vault unlock."
                : ""}
            </span>
            <div className="actions">
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={disabled || busy}
                onClick={() =>
                  removing === key.credentialId
                    ? void run("revoke", key.credentialId)
                    : setRemoving(key.credentialId)
                }
              >
                {removing === key.credentialId
                  ? "Confirm revocation"
                  : "Revoke passkey"}
              </button>
              {removing === key.credentialId ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={(event) => {
                    const primary = event.currentTarget.previousElementSibling;
                    if (primary instanceof HTMLButtonElement) primary.focus();
                    setRemoving(null);
                  }}
                >
                  Keep passkey
                </button>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

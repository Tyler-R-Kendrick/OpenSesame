import { IconTrash, IconX } from "../../components/Icons.js";
import type { LocalPasskey } from "../../lib/local-credentials.js";

export type PasskeyRowsModel = {
  keys: LocalPasskey[] | null;
  busy: boolean;
  removing: string | null;
  setRemoving: (id: string | null) => void;
  run: (action: "enroll" | "revoke", credentialId?: string) => Promise<void>;
};

export function CredentialRows({
  model,
  disabled,
}: {
  model: PasskeyRowsModel;
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
            </span>
            <div className="actions">
              <button
                type="button"
                className={
                  removing === key.credentialId
                    ? "icon-btn icon-btn--sm icon-btn--danger is-armed"
                    : "icon-btn icon-btn--sm icon-btn--danger"
                }
                disabled={disabled || busy}
                onClick={() =>
                  removing === key.credentialId
                    ? void run("revoke", key.credentialId)
                    : setRemoving(key.credentialId)
                }
                aria-label={
                  removing === key.credentialId
                    ? "Confirm revocation"
                    : "Revoke passkey"
                }
                title={
                  removing === key.credentialId
                    ? "Confirm revocation"
                    : "Revoke passkey"
                }
              >
                <IconTrash size={16} />
              </button>
              {removing === key.credentialId ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={busy}
                  onClick={(event) => {
                    const primary = event.currentTarget.previousElementSibling;
                    setRemoving(null);
                    if (primary instanceof HTMLButtonElement) primary.focus();
                  }}
                  aria-label="Keep passkey"
                  title="Keep passkey"
                >
                  <IconX size={16} />
                </button>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

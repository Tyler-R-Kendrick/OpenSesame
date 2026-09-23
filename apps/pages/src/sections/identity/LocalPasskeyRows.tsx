/**
 * One row per enrolled passkey. The revoke action is an armed icon key
 * (DESIGN.md § Actions are symbols): the first press arms it, the second
 * runs the revocation, and the sibling control keeps the passkey.
 */

import type { LocalPasskey } from "@opensesame/app-core/lib/local-credentials.js";
import { IconTrash, IconX } from "../../components/Icons.js";

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
              {key.prfCapable
                ? " · This passkey supports encrypted vault unlock."
                : ""}
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

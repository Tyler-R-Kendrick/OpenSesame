/**
 * Settings → Vaults: manage the vaults on this device (ADR 0089).
 *
 * The one place a vault is created with a choice and the only place one is
 * destroyed. The list is the same rows the front door and the `@tomb` prompt
 * render; here they gain a delete that is never on the personal vault and
 * never on the one that is open, and arms in place before it does anything.
 *
 * Creating carries the one decision that matters — share this vault's key or
 * seal the new one with its own — and says what each buys, where the old
 * switcher forked the key silently.
 */

import {
  type DeviceVault,
  removeVault,
  sealNewVault,
  switchVault,
} from "@opensesame/app-core/lib/vaults.js";
import { useState } from "react";
import { IconPlus, IconTrash, IconX } from "../../components/Icons.js";
import { VaultList } from "../../components/VaultList.js";
import { useVault } from "../../lib/vault/hooks.js";
import { GuideTarget } from "../../tutorial/registry/react.jsx";

import { useDeviceVaults } from "../../bindings/vaults.js";
export function VaultsPanel() {
  const { status, guest } = useVault();
  const vaults = useDeviceVaults();
  // A guest's key was never wrapped to disk, so there is nothing to share.
  const canShareKey = status === "unlocked" && !guest;
  const [name, setName] = useState("");
  const [shareKey, setShareKey] = useState(true);
  const [arming, setArming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run<T>(task: () => Promise<T>): void {
    setError(null);
    setBusy(true);
    void task()
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  }

  const deletable = (vault: DeviceVault) =>
    vault.kind === "project" && vault.state !== "open";

  return (
    <section className="panel" id="vaults">
      <div className="panel__head">
        <div>
          <h2>Vaults on this device</h2>
        </div>
      </div>
      <div className="panel__body">
        <GuideTarget id="vaults.list">
          <VaultList
            vaults={vaults}
            disabled={busy}
            onPick={(vault) => run(() => switchVault(vault.id))}
            trailing={(vault) =>
              deletable(vault) ? (
                <button
                  type="button"
                  className="icon-btn vault-row__delete"
                  aria-label={`Delete vault ${vault.label}`}
                  title="Delete this vault from this device"
                  disabled={busy}
                  onClick={() => setArming(vault.id)}
                >
                  <IconTrash size={16} />
                </button>
              ) : null
            }
          />
        </GuideTarget>

        {arming ? (
          <div className="unlock__danger" role="alertdialog">
            <p>
              Delete{" "}
              <strong>
                {vaults.find((vault) => vault.id === arming)?.label ?? arming}
              </strong>{" "}
              from this browser? It is locked, so nothing in it can be read
              first. This only clears the file.
            </p>
            <div className="actions">
              <button
                type="button"
                className="icon-btn icon-btn--sm icon-btn--danger is-armed"
                disabled={busy}
                aria-label="Delete this vault"
                title="Delete this vault"
                onClick={() => {
                  const id = arming;
                  setArming(null);
                  run(() => removeVault(id));
                }}
              >
                <IconTrash size={16} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Keep it"
                title="Keep it"
                onClick={() => setArming(null)}
              >
                <IconX size={16} />
              </button>
            </div>
          </div>
        ) : null}

        <form
          className="vaults__new"
          onSubmit={(event) => {
            event.preventDefault();
            const draft = name;
            const share = shareKey && canShareKey;
            setName("");
            run(() => sealNewVault(draft, { shareKey: share }));
          }}
        >
          <label htmlFor="vaults-new-name">Seal a new vault</label>
          <div className="field-inline">
            <input
              id="vaults-new-name"
              type="text"
              value={name}
              placeholder="Name"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
            <button
              type="submit"
              className="icon-btn"
              disabled={busy || name.trim().length === 0}
              aria-label="Create vault"
              title="Create vault"
            >
              <IconPlus size={16} />
            </button>
          </div>
          {canShareKey ? (
            <>
              <label className="vaults__share">
                <input
                  type="checkbox"
                  checked={shareKey}
                  onChange={(event) => setShareKey(event.target.checked)}
                />
                <span>Open it with this vault's key</span>
              </label>
              <p className="hint">
                {shareKey
                  ? "It opens whenever this one is open, with no extra prompt."
                  : "Off: it gets its own passkey, PIN or password, and its name stays sealed inside it."}
              </p>
            </>
          ) : null}
        </form>

        {error ? (
          <p className="note note--err" role="alert">
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Settings → Vaults: manage the vaults on this device (ADR 0089).
 *
 * The one place a vault is created with a choice and the only place one is
 * destroyed. The list is the same rows the front door and the `@tomb` prompt
 * render; here they gain a delete that is never on the personal vault and
 * never on the one that is open, and opens its own ceremony before it does
 * anything.
 *
 * Creating is a ceremony in a sheet (`NewVaultSheet`): it carries the one
 * decision that matters — share this vault's key or seal the new one with
 * its own — and says what each buys, where the old switcher forked the key
 * silently.
 */

import {
  type DeviceVault,
  removeVault,
  sealNewVault,
  switchVault,
} from "@opensesame/app-core/lib/vaults.js";
import { useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { VaultList } from "../../components/VaultList.js";
import { useVault } from "../../lib/vault/hooks.js";
import { GuideTarget } from "../../tutorial/registry/react.jsx";

import { useDeviceVaults } from "../../bindings/vaults.js";
import { DeleteVaultSheet } from "./DeleteVaultSheet.js";
import { NewVaultSheet } from "./NewVaultSheet.js";

export function VaultsPanel() {
  const { status, guest } = useVault();
  const vaults = useDeviceVaults();
  // A guest's key was never wrapped to disk, so there is nothing to share.
  const canShareKey = status === "unlocked" && !guest;
  const [creating, setCreating] = useState(false);
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
        <div className="actions">
          {error ? <StatusMark tone="err" label={error} /> : null}
          <IconKey
            small
            label="Seal a new vault"
            disabled={busy}
            aria-haspopup="dialog"
            onClick={() => setCreating(true)}
          >
            <IconPlus size={16} />
          </IconKey>
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
      </div>
      {arming ? (
        <DeleteVaultSheet
          label={vaults.find((vault) => vault.id === arming)?.label ?? arming}
          busy={busy}
          onDelete={() => {
            const id = arming;
            setArming(null);
            run(() => removeVault(id));
          }}
          onClose={() => setArming(null)}
        />
      ) : null}
      {creating ? (
        <NewVaultSheet
          canShareKey={canShareKey}
          busy={busy}
          onSeal={(name, shareKey) => {
            setCreating(false);
            run(() => sealNewVault(name, { shareKey }));
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </section>
  );
}

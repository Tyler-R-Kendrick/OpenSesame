/**
 * The front door of a device that holds more than one vault (ADR 0089).
 *
 * Before anything is unlocked there is a choice to make, and the old screen
 * made it silently — the Unlock form opened on whichever tomb the boot pointer
 * named, and the others were reachable only after unlocking that one. This
 * screen puts the choice first: every vault on the device, the guest road as
 * a peer beside them, and a way to seal a new one. Picking a vault lands on
 * its own Unlock form; the `‹ Vaults` crumb there leads back.
 *
 * Names stay honest: a project's name is sealed inside it, so its row says
 * `project · 4f2a` and "name is inside the vault" — nothing typed as a name
 * ever appears here before unlock.
 */

import { useEffect, useRef, useState } from "react";
import { IconMark, IconPlus } from "../components/Icons.js";
import { VaultList } from "../components/VaultList.js";
import { firstControl, landFocus } from "../lib/focus.js";
import type { FederatedProviderSummary } from "../lib/providers.js";
import {
  type DeviceVault,
  sealNewVault,
  switchVault,
  useDeviceVaults,
} from "../lib/vaults.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { SignInPanel } from "./unlock/SignInPanel.js";

type Props = {
  providers: FederatedProviderSummary[];
  /** A vault was picked and the store has moved to it: show its unlock form. */
  onPicked: () => void;
};

export function VaultsScreen({ providers, onPicked }: Props) {
  useSupportRoute("/unlock");
  // Re-derived when the projects view or the store emits, so a vault sealed
  // a moment ago appears without a reload.
  const vaults = useDeviceVaults();
  const [tab, setTab] = useState<"device" | "signin">("device");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The front door is the first screen a device with several vaults shows, so
  // it lands the keyboard on the first vault that can be opened — Enter opens
  // it, arrows and Tab walk the rest. Sealing lands on the name. The sign-in
  // tab's panel lands its own.
  useEffect(() => {
    if (tab !== "device") return;
    if (naming) {
      landFocus(nameRef.current);
      return;
    }
    landFocus(firstControl(listRef.current));
  }, [tab, naming]);

  function run(task: () => Promise<unknown>): void {
    setError(null);
    setBusy(true);
    void task()
      .then(() => onPicked())
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  }

  function pick(vault: DeviceVault): void {
    run(() => switchVault(vault.id));
  }

  function seal(): void {
    // No key to share before unlock: the new tomb gets its own seal ceremony.
    run(() => sealNewVault(name, { shareKey: false }));
  }

  return (
    <div className="unlock">
      <div className="unlock__card">
        <div className="unlock__brand">
          <p className="unlock__wordmark">
            <IconMark size={16} />
            opensesame
          </p>
          <h1>Vaults</h1>
          <p>
            Everything sealed on this device, and the two roads that need no
            key. Pick one to open it.
          </p>
        </div>

        <div
          className="unlock__methods"
          role="tablist"
          aria-label="Vaults or sign in"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "device"}
            className={
              tab === "device"
                ? "unlock__method unlock__method--active"
                : "unlock__method"
            }
            onClick={() => setTab("device")}
          >
            On this device
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "signin"}
            className={
              tab === "signin"
                ? "unlock__method unlock__method--active"
                : "unlock__method"
            }
            onClick={() => setTab("signin")}
          >
            Sign in
          </button>
        </div>

        {tab === "signin" ? (
          <SignInPanel placement="secondary" providers={providers} />
        ) : (
          <div className="vaults" ref={listRef}>
            <GuideTarget id="vaults.list">
              <VaultList vaults={vaults} disabled={busy} onPick={pick} />
            </GuideTarget>

            {naming ? (
              <form
                className="vaults__new"
                onSubmit={(event) => {
                  event.preventDefault();
                  seal();
                }}
              >
                <label htmlFor="vaults-new-name">Seal a new vault</label>
                <div className="identifier__row">
                  <input
                    id="vaults-new-name"
                    ref={nameRef}
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
                    className="btn"
                    disabled={busy || name.trim().length === 0}
                  >
                    <IconPlus size={16} />
                    Create
                  </button>
                </div>
                <p className="hint">
                  A separate key, a separate store. Its name is sealed inside it
                  once you set a passkey, PIN or password.
                </p>
              </form>
            ) : (
              <button
                type="button"
                className="vault-row__body vault-row__body--road"
                disabled={busy}
                onClick={() => setNaming(true)}
              >
                <span
                  className="vault-row__mark vault-row__mark--guest"
                  aria-hidden="true"
                >
                  <IconPlus size={18} />
                </span>
                <span className="vault-row__text">
                  <span className="vault-row__name">Seal a new vault</span>
                  <span className="vault-row__meta">
                    a separate key, a separate store
                  </span>
                </span>
              </button>
            )}

            {error ? (
              <p className="note note--err" role="alert">
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Who is unlocking, as a dropdown beside the Unlock / Sign in title.
 *
 * The trigger names the account for the vault about to unlock — the guest
 * slug (`guest-N`) when the last lock was guest, the federated claimer on
 * personal/project, else the vault label. A leftover Google session must
 * not label a guest unlock.
 * The menu lists every vault on this device, Sign in (to swap identity), and
 * Sign out.
 */

import { useState } from "react";
import {
  IconCheck,
  IconChevronRight,
  IconUser,
} from "../../components/Icons.js";
import { type Account, useAccount } from "../../lib/account.js";
import { guestVaultLabel } from "../../lib/local-guest.js";
import { signOut, switchAccount } from "../../lib/session-exit.js";
import { type DeviceVault, useDeviceVaults } from "../../lib/vaults.js";
import { GUEST_TOMB } from "../../lib/vfs.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { brandFor } from "./ProviderBrand.js";

/** Label for the unlock trigger: follows the vault being unlocked, not a stale claim. */
export function unlockAccountLabel(
  currentVaultId: string,
  account: Account | null,
  vaultLabel: string | undefined,
): string {
  if (currentVaultId === GUEST_TOMB) {
    return guestVaultLabel();
  }
  // Federated / brokered identity for this durable vault only — never a
  // provisional guest principal left over from another road.
  if (account && !account.guest) return account.name;
  return vaultLabel ?? "personal";
}

type Props = {
  disabled?: boolean;
  currentVaultId: string;
  signingIn: boolean;
  /** Offer a way back to the device vault list (ADR 0089). */
  showAllVaults?: boolean;
  onOpenVaults?: () => void;
  onSignIn: () => void;
  onUnlock: () => void;
  onPickVault: (vault: DeviceVault) => void;
};

export function UnlockUserMenu({
  disabled,
  currentVaultId,
  signingIn,
  showAllVaults = false,
  onOpenVaults,
  onSignIn,
  onUnlock,
  onPickVault,
}: Props) {
  const account = useAccount();
  const vaults = useDeviceVaults();
  const current = vaults.find((vault) => vault.id === currentVaultId);
  const [open, setOpen] = useState(false);
  const ref = useGuideTarget<HTMLButtonElement>("unlock.account");
  const label = unlockAccountLabel(currentVaultId, account, current?.label);
  const showAccount =
    currentVaultId !== GUEST_TOMB && account !== null && !account.guest;
  const brand =
    showAccount && account.providerId ? brandFor(account.providerId) : null;

  function close(): void {
    setOpen(false);
  }

  return (
    <div className="unlock-user">
      <button
        ref={ref}
        type="button"
        className="unlock-user__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${label}`}
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className="unlock-user__mark" aria-hidden="true">
          {brand ? <brand.Icon size={14} /> : <IconUser size={14} />}
        </span>
        <span className="unlock-user__name">{label}</span>
        <IconChevronRight size={12} className="unlock-user__caret" />
      </button>
      {open ? (
        <Menu
          account={account}
          showWho={showAccount}
          brand={brand}
          vaults={vaults}
          currentVaultId={currentVaultId}
          signingIn={signingIn}
          showAllVaults={showAllVaults}
          onOpenVaults={onOpenVaults}
          onClose={close}
          onSignIn={onSignIn}
          onUnlock={onUnlock}
          onPickVault={onPickVault}
        />
      ) : null}
    </div>
  );
}

type MenuProps = {
  account: ReturnType<typeof useAccount>;
  /** Federated claimer header — never a provisional guest principal. */
  showWho: boolean;
  brand: ReturnType<typeof brandFor>;
  vaults: DeviceVault[];
  currentVaultId: string;
  signingIn: boolean;
  showAllVaults: boolean;
  onOpenVaults: (() => void) | undefined;
  onClose: () => void;
  onSignIn: () => void;
  onUnlock: () => void;
  onPickVault: (vault: DeviceVault) => void;
};

function Menu({
  account,
  showWho,
  brand,
  vaults,
  currentVaultId,
  signingIn,
  showAllVaults,
  onOpenVaults,
  onClose,
  onSignIn,
  onUnlock,
  onPickVault,
}: MenuProps) {
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors Escape */}
      <div
        className="account-switcher__backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="account-switcher__menu"
        role="menu"
        aria-label="Users on this device"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        {showWho && account ? (
          <div className="account-switcher__who">
            <span className="who__mark" aria-hidden="true">
              {brand ? <brand.Icon size={16} /> : <IconUser size={16} />}
            </span>
            <span className="who__body">
              <span className="who__name">{account.name}</span>
              <span className="who__sub">{account.detail}</span>
            </span>
          </div>
        ) : null}
        <p className="account-switcher__label">On this device</p>
        {vaults.map((vault) => {
          const active = vault.id === currentVaultId && !signingIn;
          return (
            <button
              key={vault.id}
              type="button"
              role="menuitem"
              className={`account-switcher__item${active ? " is-active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => {
                onClose();
                if (vault.id === currentVaultId) onUnlock();
                else onPickVault(vault);
              }}
            >
              <span className="account-switcher__item-name">{vault.label}</span>
              {active ? <IconCheck size={14} /> : null}
            </button>
          );
        })}
        {showAllVaults && onOpenVaults ? (
          <button
            type="button"
            role="menuitem"
            className="account-switcher__item"
            onClick={() => {
              onClose();
              onOpenVaults();
            }}
          >
            <span className="account-switcher__item-name">All vaults</span>
          </button>
        ) : null}
        <div className="account-switcher__exits">
          <button
            type="button"
            role="menuitem"
            className="account-switcher__exit"
            onClick={() => {
              onClose();
              if (account) switchAccount();
              onSignIn();
            }}
          >
            <IconUser size={14} />
            Sign in
          </button>
          {account ? (
            <button
              type="button"
              role="menuitem"
              className="account-switcher__exit"
              onClick={() => {
                onClose();
                signOut();
                onSignIn();
              }}
            >
              Sign out
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

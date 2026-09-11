/**
 * Who locked this screen, as a dropdown on the unlock card.
 *
 * The trigger names the signed-in account, or the current vault when nobody
 * is signed in. The menu lists every vault on this device, Sign in (to swap
 * identity), and Sign out. The Unlock/Sign in tabs used to split those
 * ceremonies; this is the one control for both.
 */

import { useState } from "react";
import {
  IconCheck,
  IconChevronRight,
  IconUser,
} from "../../components/Icons.js";
import { useAccount } from "../../lib/account.js";
import { signOut, switchAccount } from "../../lib/session-exit.js";
import {
  type DeviceVault,
  useDeviceVaults,
} from "../../lib/vaults.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { brandFor } from "./ProviderBrand.js";

type Props = {
  disabled?: boolean;
  currentVaultId: string;
  signingIn: boolean;
  onSignIn: () => void;
  onUnlock: () => void;
  onPickVault: (vault: DeviceVault) => void;
};

export function UnlockUserMenu({
  disabled,
  currentVaultId,
  signingIn,
  onSignIn,
  onUnlock,
  onPickVault,
}: Props) {
  const account = useAccount();
  const vaults = useDeviceVaults();
  const current = vaults.find((vault) => vault.id === currentVaultId);
  const [open, setOpen] = useState(false);
  const ref = useGuideTarget<HTMLButtonElement>("unlock.account");
  const label = account?.name ?? current?.label ?? "personal";
  const brand = account?.providerId ? brandFor(account.providerId) : null;

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
          brand={brand}
          vaults={vaults}
          currentVaultId={currentVaultId}
          signingIn={signingIn}
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
  brand: ReturnType<typeof brandFor>;
  vaults: DeviceVault[];
  currentVaultId: string;
  signingIn: boolean;
  onClose: () => void;
  onSignIn: () => void;
  onUnlock: () => void;
  onPickVault: (vault: DeviceVault) => void;
};

function Menu({
  account,
  brand,
  vaults,
  currentVaultId,
  signingIn,
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
        {account ? (
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

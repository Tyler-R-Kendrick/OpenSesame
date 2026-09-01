/**
 * The one list of vaults on this device (ADR 0089).
 *
 * Rendered by the front door before any unlock, by the `@tomb` prompt inside
 * a vault, and by the Manage panel — the same row everywhere, so a person
 * learns it once: a mark for the kind, the label, one line of truth (when it
 * was sealed, how it opens), and a state chip. A row is the control: pressing
 * it is the switch, and the chip says what that will cost before they do.
 *
 * Nothing here reads the DOM or a secret. Labels come from `vaultLabel`, which
 * never shows a sealed name before unlock.
 */

import type { ReactNode } from "react";
import { type DeviceVault, describeSealedAt } from "../lib/vaults.js";
import {
  IconCheck,
  IconChevronRight,
  IconFolder,
  IconUser,
  IconVault,
} from "./Icons.js";

type Props = {
  vaults: readonly DeviceVault[];
  /** `screen` is the full-size row; `menu` the tighter popover row. */
  density?: "screen" | "menu";
  disabled?: boolean;
  /** Pressing a row that is not already open. */
  onPick: (vault: DeviceVault) => void;
  /** Anything to hang off the end of a row — the Manage panel's delete. */
  trailing?: (vault: DeviceVault) => ReactNode;
};

/** The second line: what a person needs to know before pressing the row. */
export function describeVaultRow(vault: DeviceVault): string {
  if (vault.kind === "guest") {
    return "no key · this tab only · nothing here is touched";
  }
  const parts: string[] = [];
  const sealed = describeSealedAt(vault.sealedAt);
  if (sealed) parts.push(sealed);
  if (vault.state === "empty") parts.push("not sealed yet");
  else if (vault.sharedKey) parts.push("opens without a prompt");
  else if (!vault.named) parts.push("name is inside the vault");
  return parts.join(" · ");
}

function Mark({ vault }: { vault: DeviceVault }) {
  const size = 18;
  if (vault.kind === "guest") return <IconUser size={size} />;
  if (vault.kind === "personal") return <IconVault size={size} />;
  return <IconFolder size={size} />;
}

function StateChip({ vault }: { vault: DeviceVault }) {
  if (vault.state === "open") {
    return (
      <span className="chip chip--accent">
        <IconCheck size={12} />
        open
      </span>
    );
  }
  if (vault.kind === "guest") return null;
  return (
    <span className="chip">{vault.state === "empty" ? "new" : "locked"}</span>
  );
}

export function VaultList({
  vaults,
  density = "screen",
  disabled = false,
  onPick,
  trailing,
}: Props) {
  return (
    <div className={`vault-list vault-list--${density}`}>
      {vaults.map((vault) => {
        const open = vault.state === "open";
        const meta = describeVaultRow(vault);
        const body = (
          <>
            <span
              className={`vault-row__mark${
                vault.kind === "guest" ? " vault-row__mark--guest" : ""
              }`}
              aria-hidden="true"
            >
              <Mark vault={vault} />
            </span>
            <span className="vault-row__text">
              <span className="vault-row__name">{vault.label}</span>
              {meta ? <span className="vault-row__meta">{meta}</span> : null}
            </span>
            <StateChip vault={vault} />
          </>
        );
        return (
          <div
            key={vault.id}
            className={`vault-row${open ? " vault-row--open" : ""}`}
          >
            {open ? (
              <div className="vault-row__body" aria-current="true">
                {body}
              </div>
            ) : (
              <button
                type="button"
                className="vault-row__body"
                disabled={disabled}
                onClick={() => onPick(vault)}
              >
                {body}
                <IconChevronRight size={16} className="vault-row__chevron" />
              </button>
            )}
            {trailing?.(vault)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Account switcher — who this device is signed in as, the org profiles on
 * that principal, and the roads out.
 *
 * The `who@` segment of the prompt opens it. At the top it names the account
 * the way the unlock screen does (`lib/account.ts`); in the middle are the
 * profiles it always had; at the bottom the three exits the shell never
 * offered: attach another account, switch to a different one, sign out. All
 * three land on the unlock screen's sign-in panel, the one surface that offers
 * every configured way in (`lib/session-exit.ts`).
 *
 * Adding an organization looks up the tenant slug, then starts the method it
 * advertises: an OIDC round-trip run in this tab when the tenant published an
 * issuer, and otherwise — native SAML, LDAP, anything with no browser leg —
 * the same flow run for us by the Identity API (ADR 0056, D7/D8).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { personGlyphId } from "@opensesame/app-core/lib/account.js";
import { guestVaultLabel } from "@opensesame/app-core/lib/local-guest.js";
import {
  GUEST_PROFILE_ID,
  type OrgMembership,
  activeOrgProfileId,
  listOrgMemberships,
  setActiveOrgProfileId,
  subscribeOrgProfile,
} from "@opensesame/app-core/lib/orgs.js";
import {
  attachAccount,
  signOut,
  switchAccount,
} from "@opensesame/app-core/lib/session-exit.js";
import { isTouchPointer } from "../lib/gestures.js";
import { brandFor } from "../screens/unlock/ProviderBrand.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AddOrganization } from "./AddOrganization.js";
import { GlyphMark } from "./GlyphMark.js";
import { IconCheck, IconPlus, IconUser } from "./Icons.js";
import { glyphIsDrawn } from "./prompt-glyph.js";
import { useHold } from "./use-hold.js";

import { useAccount } from "../bindings/account.js";
import { useIdentitySession } from "../bindings/identity.js";
function guestLabel(hasSession: boolean, assurance?: string): string {
  if (!hasSession) return guestVaultLabel();
  if (assurance === "provisional" || !assurance) {
    return guestVaultLabel();
  }
  return "account";
}

function AccountSwitcherDefault() {
  const session = useIdentitySession();
  const account = useAccount();
  const segRef = useGuideTarget<HTMLButtonElement>("shell.account");
  const activeId = useSyncExternalStore(
    subscribeOrgProfile,
    activeOrgProfileId,
  );
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);

  useEffect(() => {
    if (!session || !open) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await listOrgMemberships();
        if (!cancelled) setMemberships(next);
      } catch {
        if (!cancelled) setMemberships([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, open]);

  const activeOrg = memberships.find((org) => org.id === activeId);
  // The prompt's first segment: the org profile when one is active, else the
  // account — the person's name where the assertion carries one, otherwise
  // the provider's account ("Google account"), and guest-N for a provisional
  // principal nobody vouches for. On a deployment with no Identity API the
  // broker's assertion is the whole identity (ADR 0090), so it is never
  // called a guest.
  const label =
    activeOrg?.displayName ?? account?.name ?? guestLabel(Boolean(session));
  const brand = account?.providerId ? brandFor(account.providerId) : null;
  // What the prompt wears in place of the name on a phone: the organization's
  // face while one is active, else the person's.
  const personId = personGlyphId(session, account);
  const promptGlyph = activeOrg
    ? ({ kind: "org", id: activeOrg.id } as const)
    : ({ kind: "person", id: personId } as const);

  // Closing unmounts the menu, and the add-organization flow with it.
  function close(): void {
    setOpen(false);
  }

  function select(id: string): void {
    setActiveOrgProfileId(id);
    close();
  }

  // Held, the segment does what pressing it does — the menu, which names every
  // profile — and the lift that ends the hold does not close it again.
  const hold = useHold(
    useCallback(() => setOpen(true), []),
    glyphIsDrawn,
  );
  const bindSegment = useCallback(
    (element: HTMLButtonElement | null) => {
      segRef(element);
      hold.bind(element);
    },
    [segRef, hold.bind],
  );

  return (
    <div className="account-switcher">
      <button
        ref={bindSegment}
        type="button"
        className="prompt__seg prompt__seg--glyph"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title="Switch account"
        onClick={() => {
          if (hold.consumeHold()) return;
          if (open) close();
          else setOpen(true);
        }}
        onContextMenu={(event) => {
          // A finger held here is asking for the switcher, not for the
          // session menu the prompt answers a right-click with.
          if (!isTouchPointer() || !glyphIsDrawn(event.currentTarget)) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <span className="prompt__name">{label}</span>
        <GlyphMark className="prompt__glyph" {...promptGlyph} />
      </button>

      {open ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors Escape, handled on the menu */}
          <div
            className="account-switcher__backdrop"
            onClick={() => {
              if (!hold.consumeHold()) close();
            }}
            aria-hidden="true"
          />
          <div
            className="account-switcher__menu"
            aria-label="Accounts"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
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
            <p className="account-switcher__label">Accounts</p>
            <button
              type="button"
              className={`account-switcher__item${
                !activeOrg ? " is-active" : ""
              }`}
              aria-current={!activeOrg ? "true" : undefined}
              onClick={() => select(GUEST_PROFILE_ID)}
            >
              <GlyphMark kind="person" id={personId} />
              <span className="account-switcher__item-name">
                {guestLabel(Boolean(session))}
              </span>
              {!activeOrg ? <IconCheck size={14} /> : null}
            </button>
            {memberships.map((org) => (
              <button
                key={org.id}
                type="button"
                className={`account-switcher__item${
                  org.id === activeId ? " is-active" : ""
                }`}
                aria-current={org.id === activeId ? "true" : undefined}
                onClick={() => select(org.id)}
              >
                <GlyphMark kind="org" id={org.id} />
                <span className="account-switcher__item-name">
                  {org.displayName}
                </span>
                {org.id === activeId ? <IconCheck size={14} /> : null}
              </button>
            ))}

            <AddOrganization />

            {/* The roads out. Each one lands on the unlock screen's Sign in
                tab, which says what just happened. */}
            <div className="account-switcher__exits">
              {account && !account.guest ? (
                <button
                  type="button"
                  className="account-switcher__exit"
                  onClick={() => {
                    close();
                    attachAccount();
                  }}
                >
                  <IconPlus size={14} />
                  Add an account…
                </button>
              ) : (
                <button
                  type="button"
                  className="account-switcher__exit"
                  onClick={() => {
                    close();
                    attachAccount();
                  }}
                >
                  <IconUser size={14} />
                  Sign in…
                </button>
              )}
              {account ? (
                <>
                  <button
                    type="button"
                    className="account-switcher__exit"
                    onClick={() => {
                      close();
                      switchAccount();
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 8h13l-3-3M20 16H7l3 3" />
                    </svg>
                    Switch account…
                  </button>
                  <button
                    type="button"
                    className="account-switcher__exit"
                    onClick={() => {
                      close();
                      signOut();
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
                    </svg>
                    Sign out
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export const accountSwitcherSeams = {
  AccountSwitcher: AccountSwitcherDefault,
};

export function AccountSwitcher() {
  const Impl = accountSwitcherSeams.AccountSwitcher;
  return <Impl />;
}

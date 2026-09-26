import {
  type AccountFactor,
  type AccountFactorList,
  accountFactorsOffered,
  listAccountFactors,
} from "@opensesame/app-core/lib/account-factors.js";
import { describeAccount } from "@opensesame/app-core/lib/account.js";
import { subscribeIdentitySession } from "@opensesame/app-core/lib/identity.js";
import { subscribeSettings } from "@opensesame/app-core/lib/settings.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlus, IconTrash } from "../../../components/Icons.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { ACCOUNT_TITLE } from "./AccountFactorCeremony.js";
import { MethodRow } from "./MethodRow.js";
import type { SheetRequest } from "./MethodSheet.js";

function subscribe(listener: () => void): () => void {
  const offIdentity = subscribeIdentitySession(listener);
  const offSettings = subscribeSettings(listener);
  return () => {
    offIdentity();
    offSettings();
  };
}

/** Whether an Identity API is configured and a session is held, live. */
function useOffered(): boolean {
  return useSyncExternalStore(subscribe, () => accountFactorsOffered());
}

function added(factor: AccountFactor): string {
  const tail = factor.id.slice(-4);
  if (!factor.createdAt) return `Key ${tail}`;
  const day = new Date(factor.createdAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Added ${day} · key ${tail}`;
}

/**
 * Settings › Security's rows for the Identity account's own factors (ADR
 * 0140 D10): one row per passkey and for the authenticator app, one action
 * each, in the same list and the same sheet as the vault's keys (ADR 0091
 * §8). The panel says whose they are — the account that is signed in, not
 * the vault — and is not drawn at all without an Identity API and a session,
 * so a deployment that has neither reads nothing about it (ADR 0090).
 */
export function AccountFactorsPanel({
  busy,
  closed,
  onOpen,
}: {
  busy: boolean;
  /** Changes whenever the sheet closes: read the list again. */
  closed: number;
  onOpen: (request: SheetRequest) => void;
}) {
  const offered = useOffered();
  const guideRef = useGuideTarget<HTMLElement>("settings.account-factors");
  const { list, refusal } = useFactorList(offered, closed);
  if (!offered) return null;
  const account = describeAccount();
  return (
    <section
      className="panel set__security"
      aria-label="Your account"
      ref={guideRef}
    >
      <div className="panel__head">
        <div>
          <h2>Your account</h2>
          <p className="hint">
            {account ? `Signed in as ${account.name}. ` : ""}What your sign-in
            service asks for after sign-in. None of these open this vault.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {refusal ? <p className="hint">{refusal}</p> : null}
        {list ? <AccountRows list={list} busy={busy} onOpen={onOpen} /> : null}
      </div>
    </section>
  );
}

/** Read on open and after every sheet closes; `closed` is that signal. */
function useFactorList(offered: boolean, closed: number) {
  const [list, setList] = useState<AccountFactorList | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    if (!offered) return;
    void closed;
    let live = true;
    listAccountFactors().then(
      (next) => {
        if (!live) return;
        setList(next);
        setRefusal(null);
      },
      (error: unknown) => {
        if (!live) return;
        setList(null);
        setRefusal(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [offered, closed]);
  return { list, refusal };
}

function rowKey(
  on: boolean,
  busy: boolean,
  open: () => void,
): ReturnType<typeof IconKey> {
  return (
    <IconKey label={on ? "Remove" : "Add"} small disabled={busy} onClick={open}>
      {on ? <IconTrash size={16} /> : <IconPlus size={16} />}
    </IconKey>
  );
}

/** One row per passkey, one to add another, one for the authenticator app. */
function AccountRows({
  list,
  busy,
  onOpen,
}: {
  list: AccountFactorList;
  busy: boolean;
  onOpen: (request: SheetRequest) => void;
}) {
  const passkeys = list.factors.filter((f) => f.kind === "passkey");
  const totp = list.factors.find((f) => f.kind === "totp");
  const can = (kind: "passkey" | "totp") => list.enrollable.includes(kind);
  return (
    <>
      {passkeys.map((factor) => (
        <MethodRow
          key={factor.id}
          kind="account-passkey"
          label={ACCOUNT_TITLE["account-passkey"]}
          state="On"
          on
          sub={added(factor)}
          action={rowKey(true, busy, () =>
            onOpen({
              kind: "account-passkey",
              view: "remove",
              factor: { id: factor.id, name: `Passkey · ${added(factor)}` },
            }),
          )}
        />
      ))}
      {can("passkey") ? (
        <MethodRow
          kind="account-passkey"
          label={
            passkeys.length > 0
              ? "Another account passkey"
              : ACCOUNT_TITLE["account-passkey"]
          }
          state="Off"
          on={false}
          sub="Face, fingerprint or a security key, for your account."
          action={rowKey(false, busy, () =>
            onOpen({ kind: "account-passkey", view: "add" }),
          )}
        />
      ) : null}
      {totp || can("totp") ? (
        <MethodRow
          kind="account-totp"
          label={ACCOUNT_TITLE["account-totp"]}
          state={totp ? "On" : "Off"}
          on={Boolean(totp)}
          sub={
            totp
              ? "Codes from the app on your phone, for your account."
              : "Codes from an app on your phone, for your account."
          }
          action={rowKey(Boolean(totp), busy, () =>
            onOpen(
              totp
                ? {
                    kind: "account-totp",
                    view: "remove",
                    factor: {
                      id: totp.id,
                      name: "Authenticator app · your account",
                    },
                  }
                : { kind: "account-totp", view: "add" },
            ),
          )}
        />
      ) : null}
    </>
  );
}

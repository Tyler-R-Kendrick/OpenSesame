import {
  ACCOUNT_PASSKEY_UNCHECKED_WORDS,
  type PasskeyCheckMiss,
  enrollAccountPasskey,
  hostAccountPasskeyAuthenticator,
  removeAccountFactor,
} from "@opensesame/app-core/lib/account-factors.js";
import { useEffect, useRef, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { firstControl, landFocus } from "../../../lib/focus.js";
import { AccountTotpCeremony } from "./AccountTotpCeremony.js";
import type { Run } from "./run.js";

/**
 * The Identity account's factors in the one Security sheet (ADR 0140 D10,
 * ADR 0091 §8): a CeremonyShell card per act — add a passkey, set up an
 * authenticator app, remove one — never a form under a row. Every card says
 * whose factor it is: the account's, asked for by the sign-in service, and
 * never a key to this vault.
 */

export type AccountMethodKind = "account-passkey" | "account-totp";
type View = "add" | "change" | "remove";
type Setter = (foot: string | null) => void;

export function isAccountMethod(kind: string): kind is AccountMethodKind {
  return kind === "account-passkey" || kind === "account-totp";
}

export const ACCOUNT_TITLE = {
  "account-passkey": "Account passkey",
  "account-totp": "Account authenticator app",
} satisfies Record<AccountMethodKind, string>;

export const ACCOUNT_SUBTITLE = {
  "account-passkey":
    "Proves it is you to your sign-in service. It does not open this vault.",
  "account-totp":
    "Codes your sign-in service asks for. It does not open this vault.",
} satisfies Record<AccountMethodKind, string>;

export function accountFoot(view: View): string {
  return view === "remove"
    ? "Only your account changes. The vault and its keys are untouched."
    : "Your sign-in service keeps this factor. The vault key never leaves this device.";
}

export function AccountFactorCeremony({
  kind,
  view,
  factor,
  busy,
  run,
  onDone,
  setFoot,
}: {
  kind: AccountMethodKind;
  view: View;
  factor: { id: string; name: string } | undefined;
  busy: boolean;
  run: Run;
  onDone: () => void;
  setFoot: Setter;
}) {
  if (view === "remove" && factor) {
    const passkey = kind === "account-passkey";
    return (
      <CeremonyShell
        ok={false}
        top={passkey ? "Remove this passkey?" : "Remove the authenticator?"}
        name={factor.name}
        facts={[
          {
            key: "After",
            value: passkey
              ? "your sign-in service stops accepting it"
              : "your sign-in service stops asking for its codes",
          },
          { key: "Vault", value: "untouched; its keys keep working" },
        ]}
        primary={{
          label: passkey ? "Remove passkey" : "Remove authenticator",
          tone: "danger",
          busy,
          onClick: () =>
            void run(async () => {
              await removeAccountFactor(factor.id);
              onDone();
            }, `${ACCOUNT_TITLE[kind]} removed.`),
        }}
        secondary={{ label: "Keep it", onClick: onDone }}
      />
    );
  }
  if (kind === "account-passkey") {
    return <AccountPasskeyCard busy={busy} run={run} onDone={onDone} />;
  }
  return (
    <AccountTotpCeremony
      busy={busy}
      run={run}
      onDone={onDone}
      setFoot={setFoot}
    />
  );
}

function AccountPasskeyCard({
  busy,
  run,
  onDone,
}: {
  busy: boolean;
  run: Run;
  onDone: () => void;
}) {
  const [missed, setMissed] = useState<PasskeyCheckMiss | null>(null);
  if (missed) {
    return <PasskeySavedCard missed={missed} busy={busy} onDone={onDone} />;
  }
  if (!hostAccountPasskeyAuthenticator.available()) {
    return (
      <CeremonyShell
        ok={false}
        name="This browser cannot make a passkey"
        facts={[{ key: "Use", value: "a browser with passkeys" }]}
      />
    );
  }
  return (
    <CeremonyShell
      ok
      name="Passkey · your account"
      facts={[
        { key: "Proves", value: "it is you, to your sign-in service" },
        {
          key: "Asked",
          value: "when your sign-in service wants a second step",
        },
        { key: "Vault", value: "untouched; this does not open it" },
      ]}
      primary={{
        label: "Create passkey",
        busy,
        onClick: () =>
          void run(async () => {
            const added = await enrollAccountPasskey();
            // Saved but not tried to the end: the card says so and stays.
            if (added.kind === "registered_unverified") setMissed(added.reason);
            else onDone();
          }, "Passkey added to your account."),
      }}
    >
      <p className="hint">
        The browser asks for your face, fingerprint or device PIN when you press
        Create. Nothing is typed here.
      </p>
    </CeremonyShell>
  );
}

/** What the first try came to, as a fact, and what to do next. */
const TRIED = {
  cancelled: "dismissed",
  assert_refused: "turned down by your sign-in service",
  assert_failed: "did not finish",
} satisfies Record<PasskeyCheckMiss, string>;

const NEXT = {
  cancelled: "keep it; do not add another",
  assert_refused: "remove it here, not add another",
  assert_failed: "keep it; do not add another",
} satisfies Record<PasskeyCheckMiss, string>;

/**
 * A passkey the service saved but whose first try did not finish (plan step
 * 11c). It is not a failure and is never rolled back: the mark is a warning
 * whose sentence steers away from a second passkey, announced in a live
 * region, and the keyboard lands on Done, since the key that pressed Create
 * is gone. It waits for the run to settle and then a frame, so the sheet's
 * own landing on Close, which runs again when the panel redraws, goes first.
 */
function PasskeySavedCard({
  missed,
  busy,
  onDone,
}: {
  missed: PasskeyCheckMiss;
  busy: boolean;
  onDone: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (busy) return;
    const frame = requestAnimationFrame(() => {
      landFocus(firstControl(root.current));
    });
    return () => cancelAnimationFrame(frame);
  }, [busy]);
  return (
    <div ref={root}>
      <CeremonyShell
        ok={false}
        name="Passkey · your account"
        facts={[
          { key: "Saved", value: "on your account" },
          { key: "First try", value: TRIED[missed] },
          { key: "Next", value: NEXT[missed] },
        ]}
        primary={{ label: "Done", onClick: onDone }}
      >
        <output aria-live="polite">
          <StatusMark
            tone="warn"
            label={ACCOUNT_PASSKEY_UNCHECKED_WORDS[missed]}
          />
        </output>
      </CeremonyShell>
    </div>
  );
}

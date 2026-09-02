import { type FormEvent, type ReactNode, useState } from "react";
import {
  type CeremonyAlt,
  CeremonyAlts,
  CeremonyShell,
} from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import {
  IconLock,
  IconPasskey,
  IconShield,
  IconTrash,
} from "../../../components/Icons.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import { estimateStrength } from "../../../lib/vault/password.js";
import {
  MAX_PIN_LENGTH,
  type UnlockMethodId,
  type WebauthnHostCheck,
  pinPolicyProblems,
} from "../../../lib/vault/unlock-methods.js";
import type { Run } from "./run.js";

export type KeyKind = UnlockMethodId;
export type KeyView = "add" | "change" | "remove";

export const KEY_NOUN = {
  passkey: "passkey",
  pin: "PIN",
  password: "password",
} satisfies Record<KeyKind, string>;

export const KEY_TITLE = {
  passkey: "Passkey",
  pin: "PIN",
  password: "Password",
} satisfies Record<KeyKind, string>;

export const KEY_SUBTITLE = {
  passkey: "Face, fingerprint or the device PIN, through this browser.",
  pin: "Four to twelve digits, held on this device.",
  password: "Twelve characters or more. The reminder you save shows at unlock.",
} satisfies Record<KeyKind, string>;

export function keyIcon(kind: KeyKind, size = 16): ReactNode {
  return kind === "passkey" ? (
    <IconPasskey size={size} />
  ) : kind === "pin" ? (
    <IconLock size={size} />
  ) : (
    <IconShield size={size} />
  );
}

const ENROLL_PASSKEY_PARAM = "enroll-passkey";

/**
 * The card for one key (CeremonyShell): what it guards, when it is asked
 * for, the fields, and the one action inside the card. The same card is
 * step 1 of the authenticator ceremony on a keyless vault, so the PIN form
 * exists exactly once (docs/design/auth-flow/AddKey.dc.html).
 */
export function KeyCard({
  kind,
  view,
  enrolled,
  host,
  busy,
  run,
  onDone,
  /** In the authenticator sheet: say why a key comes first. */
  reason,
}: {
  kind: KeyKind;
  view: KeyView;
  /** Which keys the vault has now — decides the last-key rule and "after". */
  enrolled: UnlockMethodId[];
  host: WebauthnHostCheck;
  busy: boolean;
  run: Run;
  onDone: () => void;
  reason?: "authenticator";
}) {
  const store = useVaultStore();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const lastKey = view === "remove" && enrolled.length < 2;
  const others = enrolled.filter((id) => id !== kind);
  const noun = KEY_NOUN[kind];

  if (view === "remove") {
    const after = lastKey
      ? "nothing opens this vault"
      : `unlock with the ${others.map((id) => KEY_NOUN[id]).join(" or ")} only`;
    return (
      <CeremonyShell
        ok={false}
        top={`Remove this ${noun}?`}
        name={removeName(kind)}
        facts={[
          { key: "After", value: after },
          { key: "Vault", value: "untouched; nothing inside changes" },
        ]}
        primary={{
          label: `Remove ${noun}`,
          tone: "danger",
          disabled: lastKey,
          busy,
          onClick: () =>
            void run(async () => {
              if (kind === "passkey") await store.removePasskey();
              else if (kind === "pin") await store.removePin();
              else await store.removePassword();
              onDone();
            }, `${KEY_TITLE[kind]} unlock removed.`),
        }}
        secondary={{ label: "Keep it", onClick: onDone }}
      >
        {lastKey ? (
          <p className="hint">
            This is the only key. Add another below first; then this one can go.
          </p>
        ) : null}
      </CeremonyShell>
    );
  }

  if (kind === "passkey") {
    if (!host.ok) {
      return (
        <CeremonyShell
          ok={false}
          top="Passkeys need a hostname"
          name={`${host.hostname} is a raw IP`}
          facts={
            host.fixUrl
              ? [
                  { key: "Same vault", value: "localhost reads the same data" },
                  { key: "Then", value: "creation resumes on its own" },
                ]
              : [
                  {
                    key: "Use",
                    value: "a DNS hostname, such as Tailscale MagicDNS",
                  },
                ]
          }
          primary={
            host.fixUrl
              ? {
                  label: "Continue on localhost",
                  busy,
                  onClick: () => {
                    const url = new URL(host.fixUrl ?? "");
                    url.searchParams.set(ENROLL_PASSKEY_PARAM, "1");
                    window.location.assign(url);
                  },
                }
              : undefined
          }
        >
          <p className="hint">{host.reason}</p>
        </CeremonyShell>
      );
    }
    return (
      <CeremonyShell
        ok
        top={view === "change" ? "Enrolled" : undefined}
        name="Passkey · this browser"
        facts={[
          { key: "Guards", value: "the vault key, held by the authenticator" },
          {
            key: "Asked",
            value:
              reason === "authenticator"
                ? "at unlock, as step 1; the code follows it"
                : "at unlock, as step 1",
          },
          { key: "Where", value: host.hostname },
        ]}
        primary={{
          label: "Create passkey",
          busy,
          onClick: () =>
            void run(async () => {
              await store.enrollPasskey();
              onDone();
            }, "Passkey unlock enrolled."),
        }}
      >
        <p className="hint">
          The browser asks for your face, fingerprint or device PIN when you
          press Create. Nothing is typed here.
        </p>
      </CeremonyShell>
    );
  }

  const isPin = kind === "pin";
  const problem = isPin
    ? first.length > 0
      ? (pinPolicyProblems(first)[0] ?? null)
      : null
    : null;
  const strength = isPin ? null : estimateStrength(first);
  const strongEnough = isPin
    ? first.length > 0 && problem === null
    : first.length >= 12 && (strength?.score ?? 0) >= 2;
  const mismatch = second.length > 0 && first !== second;
  const ready = strongEnough && second.length > 0 && first === second;
  const verb =
    view === "change" ? `Change ${noun}` : isPin ? "Set PIN" : "Set password";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    void run(
      async () => {
        if (isPin) await store.enrollPin(first);
        else await store.enrollPassword(first);
        setFirst("");
        setSecond("");
        onDone();
      },
      view === "change"
        ? `${KEY_TITLE[kind]} changed.`
        : isPin
          ? "PIN unlock enrolled. You can unlock with this PIN next time."
          : "Password unlock enrolled.",
    );
  }

  return (
    <form onSubmit={submit} aria-label={`${verb} form`}>
      <CeremonyShell
        ok
        top={view === "change" ? "Enrolled" : undefined}
        name={isPin ? "PIN · this device" : "Master password"}
        facts={[
          {
            key: reason === "authenticator" ? "Why" : "Guards",
            value:
              reason === "authenticator"
                ? "a code guards a key, and this vault has none yet"
                : "the vault key on this device",
          },
          {
            key: "Asked",
            value:
              reason === "authenticator"
                ? "at unlock, as step 1; the code follows it"
                : "at unlock, as step 1",
          },
        ]}
        primary={{
          label: verb,
          submit: true,
          disabled: !ready,
          busy,
          onClick: () => {},
        }}
      >
        <FieldShell
          label={
            view === "change"
              ? isPin
                ? "New PIN"
                : "New password"
              : isPin
                ? "PIN"
                : "Password"
          }
          type="password"
          value={first}
          onValueChange={setFirst}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          status={
            first.length === 0 ? null : problem ? (
              <span className="chip chip--err">{problem}</span>
            ) : strength ? (
              <span
                className={strongEnough ? "chip chip--ok" : "chip chip--warn"}
              >
                {strength.label}
              </span>
            ) : null
          }
        />
        <FieldShell
          label={
            view === "change"
              ? isPin
                ? "Confirm new PIN"
                : "Confirm new password"
              : isPin
                ? "Confirm PIN"
                : "Confirm password"
          }
          type="password"
          value={second}
          onValueChange={setSecond}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          status={
            mismatch ? (
              <span className="chip chip--err">Does not match</span>
            ) : ready ? (
              <span className="chip chip--ok">Matches</span>
            ) : null
          }
        />
      </CeremonyShell>
    </form>
  );
}

function removeName(kind: KeyKind): string {
  return kind === "passkey"
    ? "Passkey · this browser"
    : kind === "pin"
      ? "PIN · this device"
      : "Master password";
}

/**
 * A key's whole sheet body: its card, then the other keys as alternatives
 * that expand the same card in place — "Use a passkey instead" while adding,
 * "Add a passkey" while changing or removing (the road the last-key rule
 * points at). Never a second dialect of form.
 */
export function KeyCeremony({
  kind,
  view,
  enrolled,
  host,
  busy,
  run,
  onDone,
  reason,
}: {
  kind: KeyKind;
  view: KeyView;
  enrolled: UnlockMethodId[];
  host: WebauthnHostCheck;
  busy: boolean;
  run: Run;
  onDone: () => void;
  reason?: "authenticator";
}) {
  const others = (["passkey", "pin", "password"] as const).filter(
    (id) => id !== kind && !enrolled.includes(id),
  );
  const alts: CeremonyAlt[] = [];
  if (view === "change") {
    // The road the last-key rule points at lives beside the removal, in the
    // same sheet: the confirmation card expands here, under the change form.
    alts.push({
      id: "remove",
      label: `Remove this ${KEY_NOUN[kind]}`,
      icon: <IconTrash size={16} />,
      render: () => (
        <KeyCard
          kind={kind}
          view="remove"
          enrolled={enrolled}
          host={host}
          busy={busy}
          run={run}
          onDone={onDone}
        />
      ),
    });
  }
  alts.push(
    ...others.map(
      (id): CeremonyAlt => ({
        id,
        label:
          view === "add"
            ? `Use a ${KEY_NOUN[id]} instead`
            : `Add a ${KEY_NOUN[id]}`,
        icon: keyIcon(id),
        render: () => (
          <KeyCard
            kind={id}
            view="add"
            enrolled={enrolled}
            host={host}
            busy={busy}
            run={run}
            onDone={onDone}
            reason={reason}
          />
        ),
      }),
    ),
  );
  return (
    <>
      <KeyCard
        kind={kind}
        view={view}
        enrolled={enrolled}
        host={host}
        busy={busy}
        run={run}
        onDone={onDone}
        reason={reason}
      />
      <CeremonyAlts alts={alts} />
    </>
  );
}

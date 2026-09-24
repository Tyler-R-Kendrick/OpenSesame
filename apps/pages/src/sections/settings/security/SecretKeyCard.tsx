import {
  defaultPassphraseOptions,
  estimateStrength,
  generate,
} from "@opensesame/app-core/lib/vault/password.js";
import { pinPolicyProblems } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type FormEvent, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import {
  IconEye,
  IconEyeOff,
  IconLock,
  IconRefresh,
} from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import { KEY_NOUN, KEY_TITLE, type KeyView, keyIcon } from "./key-kinds.js";
import type { Run } from "./run.js";

type SecretKind = "pin" | "password";

function newLabel(isPin: boolean, change: boolean, confirm: boolean): string {
  const noun = isPin ? "PIN" : "password";
  if (change) return confirm ? `Confirm new ${noun}` : `New ${noun}`;
  if (confirm) return `Confirm ${noun}`;
  return isPin ? "PIN" : "Password";
}

/**
 * The PIN or password card — the one form either is set or changed in
 * (AGENTS.md: never a second PIN or password form). Changing the master
 * password asks for the current one first, so an unattended unlocked tab
 * cannot re-key the vault under a password its owner never knew.
 */
export function SecretKeyCard({
  kind,
  view,
  busy,
  run,
  onDone,
  reason,
}: {
  kind: SecretKind;
  view: KeyView;
  busy: boolean;
  run: Run;
  onDone: () => void;
  reason?: "authenticator";
}) {
  const store = useVaultStore();
  const [current, setCurrent] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [shown, setShown] = useState(false);
  const isPin = kind === "pin";
  const change = view === "change";
  const needsCurrent = change && !isPin;
  const problem =
    isPin && first.length > 0 ? (pinPolicyProblems(first)[0] ?? null) : null;
  const strength = isPin ? null : estimateStrength(first);
  const strongEnough = isPin
    ? first.length > 0 && problem === null
    : first.length >= 12 && (strength?.score ?? 0) >= 2;
  const mismatch = second.length > 0 && first !== second;
  const ready =
    strongEnough &&
    second.length > 0 &&
    first === second &&
    (!needsCurrent || current.length > 0);
  const verb = change
    ? `Change ${KEY_NOUN[kind]}`
    : isPin
      ? "Set PIN"
      : "Set password";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    void run(
      async () => {
        if (isPin) await store.enrollPin(first);
        else if (needsCurrent) await store.changeMasterPassword(current, first);
        else await store.enrollPassword(first);
        setCurrent("");
        setFirst("");
        setSecond("");
        setShown(false);
        onDone();
      },
      change
        ? `${KEY_TITLE[kind]} changed. The vault key is unchanged, so no item was re-encrypted.`
        : isPin
          ? "PIN unlock enrolled. You can unlock with this PIN next time."
          : "Password unlock enrolled.",
    );
  }

  const authenticator = reason === "authenticator";
  return (
    <form onSubmit={submit} aria-label={`${verb} form`}>
      <CeremonyShell
        ok
        top={change ? "Enrolled" : undefined}
        name={isPin ? "PIN · this device" : "Master password"}
        facts={[
          {
            key: authenticator ? "Why" : "Guards",
            value: authenticator
              ? "a code guards a key, and this vault has none yet"
              : "the vault key on this device",
          },
          {
            key: "Asked",
            value: authenticator
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
        {needsCurrent ? (
          <FieldShell
            label="Current password"
            type="password"
            value={current}
            onValueChange={setCurrent}
            autoComplete="current-password"
            lead={<IconLock size={16} />}
            mono
            disabled={busy}
          />
        ) : null}
        <FieldShell
          label={newLabel(isPin, change, false)}
          type={shown ? "text" : "password"}
          value={first}
          onValueChange={setFirst}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          tail={
            isPin ? undefined : (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Suggest a strong password"
                  title="Suggest a strong password"
                  disabled={busy}
                  onClick={() => {
                    const suggestion = generate(defaultPassphraseOptions);
                    setFirst(suggestion);
                    setSecond(suggestion);
                    setShown(true);
                  }}
                >
                  <IconRefresh size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={shown ? "Hide password" : "Show password"}
                  title={shown ? "Hide password" : "Show password"}
                  aria-pressed={shown}
                  onClick={() => setShown((value) => !value)}
                >
                  {shown ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </>
            )
          }
          status={
            first.length === 0 ? null : problem ? (
              <StatusMark tone="err" label={problem} />
            ) : strength ? (
              <StatusMark
                tone={strongEnough ? "ok" : "warn"}
                label={strength.label}
              />
            ) : null
          }
        />
        <FieldShell
          label={newLabel(isPin, change, true)}
          type="password"
          value={second}
          onValueChange={setSecond}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          status={
            mismatch ? (
              <StatusMark tone="err" label="Does not match" />
            ) : ready ? (
              <StatusMark tone="ok" label="Matches" />
            ) : null
          }
        />
      </CeremonyShell>
    </form>
  );
}

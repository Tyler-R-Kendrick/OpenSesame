import {
  defaultPassphraseOptions,
  estimateStrength,
  generate,
} from "@opensesame/app-core/lib/vault/password.js";
import { pinPolicyProblems } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type FormEvent, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconKey } from "../../../components/IconKey.js";
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

function verbFor(kind: SecretKind, change: boolean): string {
  if (change) return `Change ${KEY_NOUN[kind]}`;
  return kind === "pin" ? "Set PIN" : "Set password";
}

function doneMessage(kind: SecretKind, change: boolean): string {
  if (change) {
    return `${KEY_TITLE[kind]} changed. The vault key is unchanged, so no item was re-encrypted.`;
  }
  return kind === "pin"
    ? "PIN unlock enrolled. You can unlock with this PIN next time."
    : "Password unlock enrolled.";
}

/** What the fields say about the secret: strong enough, and confirmed. */
function checkSecret(
  isPin: boolean,
  first: string,
  second: string,
  currentOk: boolean,
) {
  const problem =
    isPin && first.length > 0 ? (pinPolicyProblems(first)[0] ?? null) : null;
  const strength = isPin ? null : estimateStrength(first);
  const strongEnough = isPin
    ? first.length > 0 && problem === null
    : first.length >= 12 && (strength?.score ?? 0) >= 2;
  const matches = second.length > 0 && first === second;
  return {
    problem,
    strength,
    strongEnough,
    mismatch: second.length > 0 && first !== second,
    ready: strongEnough && matches && currentOk,
  };
}

function useSecretForm(kind: SecretKind, view: KeyView) {
  const store = useVaultStore();
  const [current, setCurrent] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [shown, setShown] = useState(false);
  const isPin = kind === "pin";
  const change = view === "change";
  const needsCurrent = change && !isPin;
  const check = checkSecret(
    isPin,
    first,
    second,
    !needsCurrent || current.length > 0,
  );
  async function save() {
    if (isPin) await store.enrollPin(first);
    else if (needsCurrent) await store.changeMasterPassword(current, first);
    else await store.enrollPassword(first);
    setCurrent("");
    setFirst("");
    setSecond("");
    setShown(false);
  }
  function suggest() {
    const suggestion = generate(defaultPassphraseOptions);
    setFirst(suggestion);
    setSecond(suggestion);
    setShown(true);
  }
  return {
    current,
    setCurrent,
    first,
    setFirst,
    second,
    setSecond,
    shown,
    setShown,
    isPin,
    change,
    needsCurrent,
    check,
    save,
    suggest,
  };
}

type SecretForm = ReturnType<typeof useSecretForm>;

function facts(authenticator: boolean) {
  return [
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
  ];
}

/** The master password's suggest and reveal keys, ending its field. */
function PasswordKeys({ form, busy }: { form: SecretForm; busy: boolean }) {
  return (
    <>
      <IconKey
        label="Suggest a strong password"
        disabled={busy}
        onClick={form.suggest}
      >
        <IconRefresh size={16} />
      </IconKey>
      <IconKey
        label={form.shown ? "Hide password" : "Show password"}
        aria-pressed={form.shown}
        onClick={() => form.setShown((value) => !value)}
      >
        {form.shown ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </IconKey>
    </>
  );
}

function strengthMark(form: SecretForm) {
  const { problem, strength, strongEnough } = form.check;
  if (form.first.length === 0) return null;
  if (problem) return <StatusMark tone="err" label={problem} />;
  if (!strength) return null;
  return (
    <StatusMark tone={strongEnough ? "ok" : "warn"} label={strength.label} />
  );
}

function matchMark(form: SecretForm) {
  if (form.check.mismatch) {
    return <StatusMark tone="err" label="Does not match" />;
  }
  return form.check.ready ? <StatusMark tone="ok" label="Matches" /> : null;
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
  const form = useSecretForm(kind, view);
  const verb = verbFor(kind, form.change);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.check.ready) return;
    void run(
      async () => {
        await form.save();
        onDone();
      },
      doneMessage(kind, form.change),
    );
  }

  return (
    <form onSubmit={submit} aria-label={`${verb} form`}>
      <CeremonyShell
        ok
        top={form.change ? "Enrolled" : undefined}
        name={form.isPin ? "PIN · this device" : "Master password"}
        facts={facts(reason === "authenticator")}
        primary={{
          label: verb,
          submit: true,
          disabled: !form.check.ready,
          busy,
          onClick: () => {},
        }}
      >
        {form.needsCurrent ? (
          <FieldShell
            label="Current password"
            type="password"
            value={form.current}
            onValueChange={form.setCurrent}
            autoComplete="current-password"
            lead={<IconLock size={16} />}
            mono
            disabled={busy}
          />
        ) : null}
        <FieldShell
          label={newLabel(form.isPin, form.change, false)}
          type={form.shown ? "text" : "password"}
          value={form.first}
          onValueChange={form.setFirst}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          tail={
            form.isPin ? undefined : <PasswordKeys form={form} busy={busy} />
          }
          status={strengthMark(form)}
        />
        <FieldShell
          label={newLabel(form.isPin, form.change, true)}
          type="password"
          value={form.second}
          onValueChange={form.setSecond}
          autoComplete="new-password"
          lead={keyIcon(kind)}
          mono
          disabled={busy}
          status={matchMark(form)}
        />
      </CeremonyShell>
    </form>
  );
}

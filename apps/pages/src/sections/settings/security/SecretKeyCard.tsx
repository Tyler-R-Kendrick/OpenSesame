import { pinPolicyProblems } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { type FormEvent, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVaultStore } from "../../../lib/vault/hooks.js";
import { type KeyView, keyIcon } from "./key-kinds.js";
import type { Run } from "./run.js";

function newLabel(change: boolean, confirm: boolean): string {
  if (change) return confirm ? "Confirm new PIN" : "New PIN";
  return confirm ? "Confirm PIN" : "PIN";
}

function verbFor(change: boolean): string {
  return change ? "Change PIN" : "Set PIN";
}

function doneMessage(change: boolean): string {
  return change
    ? "PIN changed. The vault key is unchanged, so no item was re-encrypted."
    : "PIN unlock enrolled. You can unlock with this PIN next time.";
}

function usePinForm() {
  const store = useVaultStore();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const problem =
    first.length > 0 ? (pinPolicyProblems(first)[0] ?? null) : null;
  const strongEnough = first.length > 0 && problem === null;
  const matches = second.length > 0 && first === second;
  async function save() {
    await store.enrollPin(first);
    setFirst("");
    setSecond("");
  }
  return {
    first,
    setFirst,
    second,
    setSecond,
    problem,
    mismatch: second.length > 0 && first !== second,
    ready: strongEnough && matches,
    save,
  };
}

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

/**
 * The PIN card — the one form a PIN is set or changed in (AGENTS.md: never a
 * second PIN form). There is no password card: a master password is never
 * enrolled or changed from here (ADR 0180), only removed, in KeyCeremony.
 */
export function SecretKeyCard({
  view,
  busy,
  run,
  onDone,
  reason,
}: {
  view: KeyView;
  busy: boolean;
  run: Run;
  onDone: () => void;
  reason?: "authenticator";
}) {
  const form = usePinForm();
  const change = view === "change";
  const verb = verbFor(change);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.ready) return;
    void run(async () => {
      await form.save();
      onDone();
    }, doneMessage(change));
  }

  return (
    <form onSubmit={submit} aria-label={`${verb} form`}>
      <CeremonyShell
        ok
        top={change ? "Enrolled" : undefined}
        name="PIN · this device"
        facts={facts(reason === "authenticator")}
        primary={{
          label: verb,
          submit: true,
          disabled: !form.ready,
          busy,
          onClick: () => {},
        }}
      >
        <FieldShell
          label={newLabel(change, false)}
          type="password"
          value={form.first}
          onValueChange={form.setFirst}
          autoComplete="new-password"
          lead={keyIcon("pin")}
          mono
          disabled={busy}
          status={
            form.problem ? <StatusMark tone="err" label={form.problem} /> : null
          }
        />
        <FieldShell
          label={newLabel(change, true)}
          type="password"
          value={form.second}
          onValueChange={form.setSecond}
          autoComplete="new-password"
          lead={keyIcon("pin")}
          mono
          disabled={busy}
          status={
            form.mismatch ? (
              <StatusMark tone="err" label="Does not match" />
            ) : form.ready ? (
              <StatusMark tone="ok" label="Matches" />
            ) : null
          }
        />
      </CeremonyShell>
    </form>
  );
}

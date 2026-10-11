/**
 * The first half of asking a circle to approve a share: who it is for, what
 * it is of, what they may do with it and for how long. The request is made
 * only by the key, and what goes into it is the share ledger's own grant, so
 * the share that is written later is the share the contacts read now.
 */

import { readLocalDirectory } from "@opensesame/app-core/lib/local-directory.js";
import {
  type GrantIdentity,
  grantIdentities,
} from "@opensesame/app-core/lib/local-share-grants.js";
import {
  type AskView,
  askToShare,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Grant } from "@opensesame/app-core/lib/quorum/types.js";
import { useEffect, useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { IconArrowRight } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { Choices, PickField } from "./Choices.js";
import {
  ASK_KINDS,
  type AskKind,
  DURATIONS,
  type Target,
  grantOf,
  policiesFor,
  targetsOf,
} from "./ask-model.js";

/** The people of this vault's directory a share can be given to. */
function usePeople(tomb: string): GrantIdentity[] | null {
  const [people, setPeople] = useState<GrantIdentity[] | null>(null);
  useEffect(() => {
    let live = true;
    readLocalDirectory(tomb)
      .then((directory) => {
        if (live) {
          setPeople(
            grantIdentities(directory.entries).filter(
              (identity) => identity.kind === "person",
            ),
          );
        }
      })
      .catch(() => {
        if (live) setPeople([]);
      });
    return () => {
      live = false;
    };
  }, [tomb]);
  return people;
}

/** The row chosen, or the first when nothing has been chosen yet. */
function chosenOf<T>(
  rows: readonly T[] | null,
  matches: (row: T) => boolean,
): T | undefined {
  return rows?.find(matches) ?? rows?.[0];
}

/** What is chosen so far, with the first of each list standing in until a choice is made. */
function useAskForm(tomb: string) {
  const vault = useVault();
  const people = usePeople(tomb);
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<AskKind>("item");
  const [target, setTarget] = useState("");
  const [policy, setPolicy] = useState("");
  const [seconds, setSeconds] = useState<number>(DURATIONS[0]?.value ?? 3600);
  const targets = targetsOf(vault, kind);
  const policies = policiesFor(kind);
  const person = chosenOf(people, (p) => p.id === who);
  const thing: Target | undefined = chosenOf(targets, (t) => t.id === target);
  const allowed = chosenOf(policies, (p) => p.value === policy);
  const grant: Grant | null =
    person && thing && allowed
      ? grantOf({
          principalId: person.id,
          kind,
          target: thing,
          policy: allowed.value,
          durationSeconds: seconds,
        })
      : null;
  return {
    people,
    person,
    kind,
    targets,
    thing,
    policies,
    allowed,
    seconds,
    grant,
    setWho,
    setTarget,
    setPolicy,
    setSeconds,
    setKind: (next: AskKind) => {
      setKind(next);
      setTarget("");
      setPolicy("");
    },
  };
}

function AskFields({ form }: { form: ReturnType<typeof useAskForm> }) {
  const { people, targets, kind } = form;
  return (
    <>
      {people !== null && people.length === 0 ? (
        <StatusMark tone="idle" label="No people in the directory." />
      ) : (
        <PickField
          id="tcc-ask-person"
          label="Person"
          value={form.person?.id ?? ""}
          options={(people ?? []).map((p) => ({ value: p.id, label: p.name }))}
          onChange={form.setWho}
        />
      )}
      <Choices
        label="Share"
        options={ASK_KINDS}
        value={kind}
        onChange={form.setKind}
      />
      {targets.length === 0 ? (
        <StatusMark
          tone="idle"
          label={
            kind === "item"
              ? "No items in this vault."
              : "No folders in this vault."
          }
        />
      ) : (
        <PickField
          id="tcc-ask-target"
          label={kind === "item" ? "Item" : "Folder"}
          value={form.thing?.id ?? ""}
          options={targets.map((t) => ({ value: t.id, label: t.label }))}
          onChange={form.setTarget}
        />
      )}
      <Choices
        label="Policy"
        options={form.policies}
        value={form.allowed?.value ?? ""}
        onChange={form.setPolicy}
      />
      <Choices
        label="Duration"
        options={DURATIONS}
        value={form.seconds}
        onChange={form.setSeconds}
      />
    </>
  );
}

export function AskCompose({
  desk,
  circleId,
  onAsked,
}: {
  desk: Desk;
  circleId: string;
  onAsked: (view: AskView) => void;
}) {
  const form = useAskForm(desk.ports.tomb);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:ask-compose",
    "Ask the circle",
  );

  async function ask(): Promise<void> {
    const { grant } = form;
    if (busy || !grant) return;
    setBusy(true);
    const done = await failure.run(() =>
      askToShare(desk.ports, circleId, grant),
    );
    setBusy(false);
    if (done.ok) onAsked(done.value);
  }

  return (
    <form
      aria-label="Ask the circle"
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <CeremonyShell
        name="Share"
        primary={{
          label: "Ask the circle",
          icon: <IconArrowRight size={18} />,
          submit: true,
          busy,
          disabled: form.grant === null,
          onClick: () => undefined,
        }}
      >
        <AskFields form={form} />
        {failure.message ? (
          <StatusMark tone="err" label={failure.message} />
        ) : null}
      </CeremonyShell>
    </form>
  );
}

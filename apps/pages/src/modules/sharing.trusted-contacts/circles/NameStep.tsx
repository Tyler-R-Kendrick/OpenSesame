/**
 * Step one of a new circle: what to call it. Making the invitation is the
 * first thing that touches the desk; until then nothing is kept, so a
 * half-filled form needs no way out beyond the sheet's own.
 */

import {
  type Begun,
  beginCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconArrowRight } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { FieldMark } from "./Choices.js";
import { APPROVALS_ONLY, type Scope } from "./circle-model.js";

const NAME_MAX = 120;

/** What is typed, and whether it is enough to make an invitation from. */
function useNameForm(desk: Desk) {
  const [name, setName] = useState(() => `Circle ${desk.owned.length + 1}`);
  const nameMessage =
    name.trim().length > NAME_MAX
      ? `A name is up to ${NAME_MAX} letters.`
      : null;
  const ready = name.trim() !== "" && nameMessage === null;
  return { name, setName, nameMessage, ready };
}

export function NameStep({
  desk,
  onBegun,
}: {
  desk: Desk;
  onBegun: (begun: Begun, scope: Scope) => void;
}) {
  const form = useNameForm(desk);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:circle-begin",
    "Start a circle",
  );

  async function make(): Promise<void> {
    if (busy || !form.ready) return;
    setBusy(true);
    const done = await failure.run(() =>
      beginCircle(desk.ports, {
        label: form.name.trim(),
        collection: APPROVALS_ONLY,
        recovers: false,
      }),
    );
    setBusy(false);
    if (done.ok) {
      onBegun(done.value, { protects: "approvals", folder: "" });
    }
  }

  return (
    <form
      aria-label="Name the circle"
      onSubmit={(event) => {
        event.preventDefault();
        void make();
      }}
    >
      <CeremonyShell
        name="Circle"
        primary={{
          label: "Make the invitation",
          icon: <IconArrowRight size={18} />,
          submit: true,
          busy,
          disabled: !form.ready,
          onClick: () => undefined,
        }}
      >
        <FieldShell
          id="tcc-name"
          label="Name"
          autoComplete="off"
          value={form.name}
          onValueChange={(next) => {
            form.setName(next);
            failure.clear();
          }}
          status={<FieldMark message={form.nameMessage} />}
        />
        {failure.message ? (
          <StatusMark tone="err" label={failure.message} />
        ) : null}
      </CeremonyShell>
    </form>
  );
}

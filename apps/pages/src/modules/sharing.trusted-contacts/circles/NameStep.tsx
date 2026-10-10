/**
 * Step one of a new circle: what to call it and what it protects. Making the
 * invitation is the first thing that touches the desk; until then nothing is
 * kept, so a half-filled form needs no way out beyond the sheet's own.
 */

import {
  type Begun,
  beginCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Folder } from "@opensesame/vault-core";
import { useState } from "react";
import { CeremonyShell } from "../../../components/CeremonyShell.js";
import { FieldShell } from "../../../components/FieldShell.js";
import { IconArrowRight } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import { Choices, FieldMark } from "./Choices.js";
import {
  PROTECTS,
  type Protects,
  type Scope,
  collectionOf,
} from "./circle-model.js";
import { folderNamed } from "./circle-payload.js";

const NAME_MAX = 120;

/** What is typed, and whether it is enough to make an invitation from. */
function useNameForm(folders: readonly Folder[]) {
  const [name, setName] = useState("");
  const [protects, setProtects] = useState<Protects>("everything");
  const [folder, setFolder] = useState("");
  const named = folderNamed(folders, folder);
  const nameMessage =
    name.trim().length > NAME_MAX
      ? `A name is up to ${NAME_MAX} letters.`
      : null;
  const folderMessage =
    protects === "folder" && folder.trim() !== "" && !named
      ? "No folder has that name."
      : null;
  const ready =
    name.trim() !== "" &&
    nameMessage === null &&
    (protects !== "folder" || named !== undefined);
  return {
    name,
    setName,
    protects,
    setProtects,
    folder,
    setFolder,
    folderName: named?.name ?? "",
    nameMessage,
    folderMessage,
    ready,
  };
}

export function NameStep({
  desk,
  folders,
  onBegun,
}: {
  desk: Desk;
  folders: readonly Folder[];
  onBegun: (begun: Begun, scope: Scope) => void;
}) {
  const form = useNameForm(folders);
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
        collection: collectionOf(form.protects, form.folderName),
        recovers: form.protects !== "approvals",
      }),
    );
    setBusy(false);
    if (done.ok) {
      onBegun(done.value, { protects: form.protects, folder: form.folderName });
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
        <Choices
          label="What it protects"
          options={PROTECTS.map(({ id, label }) => ({ value: id, label }))}
          value={form.protects}
          onChange={form.setProtects}
        />
        {form.protects === "folder" ? (
          <FieldShell
            id="tcc-folder"
            label="Folder"
            mono
            autoComplete="off"
            value={form.folder}
            onValueChange={form.setFolder}
            status={<FieldMark message={form.folderMessage} />}
          />
        ) : null}
        {failure.message ? (
          <StatusMark tone="err" label={failure.message} />
        ) : null}
      </CeremonyShell>
    </form>
  );
}

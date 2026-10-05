/**
 * Add a device to the tailnet: mint a Tailscale auth key with the options a
 * person chose, through the daemon (ADR 0169), and show it once with the
 * command that joins a machine with it. The key is in this sheet's memory
 * only; closing the sheet forgets it, and the daemon never stored it.
 */

import {
  KEY_LIFETIMES,
  joinCommand,
  parseTags,
  relativeTo,
  validDescription,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import type { CreatedTailnetKey } from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconKey } from "../../components/IconKey.js";
import { IconCopy, IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCopySecret } from "../../lib/vault/hooks.js";
import { ErrorMark, SwitchRow } from "./SwitchRow.js";
import type { TailnetModel } from "./use-tailnet-admin.js";

type Options = {
  description: string;
  seconds: number;
  reusable: boolean;
  ephemeral: boolean;
  preauthorized: boolean;
  tags: string;
};

const START: Options = {
  description: "",
  seconds: 86_400,
  reusable: false,
  ephemeral: false,
  preauthorized: true,
  tags: "",
};

function CopyField({
  id,
  label,
  value,
}: { id: string; label: string; value: string }) {
  const copy = useCopySecret();
  const [said, setSaid] = useState("");
  return (
    <FieldShell
      id={id}
      label={label}
      mono
      readOnly
      value={value}
      status={said ? <StatusMark tone="ok" label={said} /> : null}
      tail={
        <IconKey
          label={`Copy the ${label.toLowerCase()}`}
          small
          onClick={() =>
            void copy(value).then((result) =>
              setSaid(
                result === "copied" ? "Copied" : "The clipboard is unavailable",
              ),
            )
          }
        >
          <IconCopy size={15} />
        </IconKey>
      }
    />
  );
}

function Minted({ created, now }: { created: CreatedTailnetKey; now: number }) {
  return (
    <>
      <CopyField id="tailnet-new-key" label="Auth key" value={created.key} />
      <CopyField
        id="tailnet-join-command"
        label="Join command"
        value={joinCommand(created.key)}
      />
      <p className="vexport__marks">
        <StatusMark
          tone="warn"
          label={`Shown once. Expires ${relativeTo(created.expires, now) ?? "as set"}.`}
        />
      </p>
    </>
  );
}

function TagsStatus({
  tags,
  tagsNeeded,
}: { tags: readonly string[] | null; tagsNeeded: boolean }) {
  if (tags === null)
    return (
      <StatusMark
        tone="err"
        label="Each tag is a lowercase name that starts with a letter"
      />
    );
  return tagsNeeded ? (
    <StatusMark
      tone="warn"
      label="The daemon's OAuth client mints tagged keys only"
    />
  ) : null;
}

function KeyOptions({
  options,
  set,
  tags,
  tagsNeeded,
}: {
  options: Options;
  set: (patch: Partial<Options>) => void;
  tags: readonly string[] | null;
  tagsNeeded: boolean;
}) {
  return (
    <>
      <FieldShell
        id="tailnet-key-description"
        label="Description"
        autoComplete="off"
        placeholder="lab runners"
        value={options.description}
        onValueChange={(description) => set({ description })}
        status={
          validDescription(options.description) ? null : (
            <StatusMark
              tone="err"
              label="At most 50 letters, digits, spaces and hyphens"
            />
          )
        }
      />
      <div className="tailnet-choices" role="radiogroup" aria-label="Key lasts">
        {KEY_LIFETIMES.map((choice) => (
          <button
            key={choice.seconds}
            type="button"
            className="tailnet-choice"
            aria-pressed={options.seconds === choice.seconds}
            onClick={() => set({ seconds: choice.seconds })}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <SwitchRow
        id="tailnet-key-reusable"
        label="Reusable"
        on={options.reusable}
        onChange={(reusable) => set({ reusable })}
      />
      <SwitchRow
        id="tailnet-key-ephemeral"
        label="Ephemeral device"
        on={options.ephemeral}
        onChange={(ephemeral) => set({ ephemeral })}
      />
      <SwitchRow
        id="tailnet-key-preauthorized"
        label="Pre-approved"
        on={options.preauthorized}
        onChange={(preauthorized) => set({ preauthorized })}
      />
      <FieldShell
        id="tailnet-key-tags"
        label="Tags"
        mono
        autoComplete="off"
        placeholder="tag:ci"
        value={options.tags}
        onValueChange={(text) => set({ tags: text })}
        status={<TagsStatus tags={tags} tagsNeeded={tagsNeeded} />}
      />
    </>
  );
}

function facts(options: Options) {
  return [
    {
      key: "Uses",
      value: options.reusable ? "any number of devices" : "one device",
    },
    {
      key: "Approval",
      value: options.preauthorized ? "none needed" : "waits for an admin",
    },
  ];
}

export function AddDeviceSheet({
  model,
  oauth,
  onClose,
}: {
  model: TailnetModel;
  /** An OAuth client mints only tagged keys. */
  oauth: boolean;
  onClose: () => void;
}) {
  const [options, setOptions] = useState(START);
  const [created, setCreated] = useState<CreatedTailnetKey | null>(null);
  const tags = parseTags(options.tags);
  const tagsNeeded = oauth && (tags?.length ?? 0) === 0;
  const ready =
    validDescription(options.description) &&
    tags !== null &&
    !tagsNeeded &&
    !model.busy;
  const set = (patch: Partial<Options>) => setOptions({ ...options, ...patch });

  const mint = () => {
    if (!ready || tags === null) return;
    let minted: CreatedTailnetKey | null = null;
    void model
      .run(async () => {
        minted = await model.admin.createKey({
          description: options.description.trim(),
          reusable: options.reusable,
          ephemeral: options.ephemeral,
          preauthorized: options.preauthorized,
          tags,
          expirySeconds: options.seconds,
        });
      })
      .then(() => setCreated(minted));
  };

  const close = () => {
    setCreated(null);
    onClose();
  };

  return (
    <CeremonySheet
      title="Add a device"
      mark={<IconPlus size={20} />}
      onClose={close}
    >
      <form
        aria-label="Add a device"
        onSubmit={(event) => {
          event.preventDefault();
          if (created) close();
          else mint();
        }}
      >
        <CeremonyShell
          ok={model.error === ""}
          top={created ? "Auth key minted" : undefined}
          name={created ? created.description || created.id : "A new auth key"}
          facts={facts(options)}
          primary={
            created
              ? { label: "Done", submit: true, onClick: close }
              : {
                  label: "Mint an auth key",
                  submit: true,
                  busy: model.busy,
                  disabled: !ready,
                  onClick: mint,
                }
          }
        >
          {created ? (
            <Minted created={created} now={model.loaded?.at ?? Date.now()} />
          ) : (
            <KeyOptions
              options={options}
              set={set}
              tags={tags}
              tagsNeeded={tagsNeeded}
            />
          )}
          <ErrorMark error={model.error} />
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}

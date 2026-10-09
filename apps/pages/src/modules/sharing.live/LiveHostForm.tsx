/**
 * Starting a live session (ADR 0150 §2): what it shares, how, for how long,
 * and who gets in. Nothing but the carriers the owner named leaves this
 * browser until someone is let in: the peer connection, its ICE servers and
 * address hints wait for admission.
 */

import { liveHostStartDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import { liveItemPickLabels } from "@opensesame/app-core/lib/live/item-pick-label.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import type { LiveTransport } from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { activeItems } from "@opensesame/vault-core";
import { useMemo, useState } from "react";
import { useDeviceVaults } from "../../bindings/vaults.js";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { liveUiSeams } from "./live-hooks.js";
import { useStartSession } from "./live-start.js";
import { useLiveTransport } from "./live-transport-hooks.js";

type Choice<T extends string | number> = Readonly<{ value: T; label: string }>;

const SCOPES: readonly Choice<"vault" | "items">[] = [
  { value: "vault", label: "The whole vault" },
  { value: "items", label: "Chosen items" },
];
const POLICIES: readonly Choice<SharePolicy>[] = [
  { value: "read", label: "Show values" },
  { value: "use", label: "Copy only" },
  { value: "edit", label: "Can edit" },
];
const ADMISSIONS: readonly Choice<Admission>[] = [
  { value: "invite", label: "Link and code" },
  { value: "open", label: "Anyone with the link" },
];
const DURATIONS: readonly Choice<number>[] = [
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
];

function Pick<T extends string | number>({
  id,
  name,
  value,
  options,
  onChange,
}: {
  id: string;
  name: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="sw">
      <label className="sw__name" htmlFor={id}>
        {name}
      </label>
      <select
        id={id}
        className="sw__select"
        value={String(value)}
        onChange={(event) => {
          const picked = options.find(
            (option) => String(option.value) === event.target.value,
          );
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ItemChoice({
  chosen,
  onChange,
}: {
  chosen: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { items } = useVault();
  const live = activeItems(items);
  const labels = useMemo(() => liveItemPickLabels(live), [live]);
  const vaults = useDeviceVaults();
  const vaultLabel = vaults.find(
    (vault) => vault.id === vaultStore.activeTomb(),
  )?.label;
  if (live.length === 0)
    return <StatusMark tone="idle" label="This vault has no items" />;
  return (
    <fieldset className="live-choose">
      <legend className="visually-hidden">Items to share</legend>
      {vaultLabel ? (
        <FieldRow label="Vault">
          <span className="frow__value">{vaultLabel}</span>
        </FieldRow>
      ) : null}
      {live.map((item) => (
        <label key={item.id} className="join__choice">
          <input
            type="checkbox"
            checked={chosen.has(item.id)}
            onChange={(event) => {
              const next = new Set(chosen);
              if (event.target.checked) next.add(item.id);
              else next.delete(item.id);
              onChange(next);
            }}
          />
          <span>{labels.get(item.id) ?? item.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** What the session will use beyond a direct route, in a few words. */
export function routesSummary(transport: LiveTransport): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) =>
    n === 0 ? null : `${n} ${n === 1 ? one : many}`;
  const turn = transport.ice.filter((server) =>
    server.urls.some((url) => url.startsWith("turn")),
  ).length;
  for (const part of [
    count(transport.addresses.length, "address", "addresses"),
    count(transport.ice.length - turn, "STUN server", "STUN servers"),
    count(turn, "TURN server", "TURN servers"),
    count(transport.carriers.length, "carrier", "carriers"),
  ])
    if (part) parts.push(part);
  if (parts.length === 0) return "Direct only";
  return `${transport.relay ? "Relay only" : "Direct"}, with ${parts.join(", ")}`;
}

export function LiveHostForm() {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"vault" | "items">("items");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [policy, setPolicy] = useState<SharePolicy>("use");
  const [admission, setAdmission] = useState<Admission>("invite");
  const [minutes, setMinutes] = useState(60);
  const { starting, failed, start } = useStartSession();
  const { transport, loaded, refused } = useLiveTransport();
  // A profile that is there and cannot be read is not "direct only": no
  // session starts until it is fixed, or the owner's routes would be dropped.
  const ready =
    loaded &&
    refused === null &&
    !starting &&
    title.trim().length > 0 &&
    (scope === "vault" || chosen.size > 0);

  return (
    <form
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        start({
          title: title.trim(),
          scope:
            scope === "vault"
              ? { kind: "vault" }
              : { kind: "items", ids: [...chosen] },
          policy,
          admission,
          minutes,
          peers: liveUiSeams.peers,
          transport,
          carriers: liveUiSeams.carriers,
        });
      }}
    >
      <FieldShell
        id="live-title"
        label="Session name"
        value={title}
        onValueChange={(next) => setTitle(next.slice(0, 64))}
      />
      <Pick
        id="live-scope"
        name="Share"
        value={scope}
        options={SCOPES}
        onChange={setScope}
      />
      {scope === "items" ? (
        <ItemChoice chosen={chosen} onChange={setChosen} />
      ) : null}
      <Pick
        id="live-policy"
        name="Values"
        value={policy}
        options={POLICIES}
        onChange={setPolicy}
      />
      <Pick
        id="live-admission"
        name="Who gets in"
        value={admission}
        options={ADMISSIONS}
        onChange={setAdmission}
      />
      <Pick
        id="live-minutes"
        name="For"
        value={minutes}
        options={DURATIONS}
        onChange={setMinutes}
      />
      {refused ? (
        <StatusMark tone="err" label={refused} />
      ) : (
        <StatusMark tone="idle" label={routesSummary(transport)} />
      )}
      {failed ? <StatusMark tone="err" label={failed} /> : null}
      <FormCommit
        label="Start the live session"
        disabled={!ready}
        disabledReason={
          !ready
            ? liveHostStartDisabledReason({
                loaded,
                refused,
                starting,
                title,
                scope,
                chosenCount: chosen.size,
              })
            : undefined
        }
        icon={<IconPlay size={18} />}
      />
    </form>
  );
}

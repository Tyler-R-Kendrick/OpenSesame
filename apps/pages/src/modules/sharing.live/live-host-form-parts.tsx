import type { Admission } from "@opensesame/app-core/lib/live/host.js";
import { liveItemPickLabels } from "@opensesame/app-core/lib/live/item-pick-label.js";
import type { SharePolicy } from "@opensesame/app-core/lib/live/messages.js";
import type { LiveTransport } from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { activeItems, listedItems } from "@opensesame/vault-core";
import { useMemo } from "react";
import { useDeviceVaults } from "../../bindings/vaults.js";
import { FieldRow } from "../../components/FieldRow.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";

type Choice<T extends string | number> = Readonly<{ value: T; label: string }>;

export const SCOPES: readonly Choice<"vault" | "items">[] = [
  { value: "vault", label: "The whole vault" },
  { value: "items", label: "Chosen items" },
];
export const POLICIES: readonly Choice<SharePolicy>[] = [
  { value: "read", label: "Show values" },
  { value: "use", label: "Copy only" },
  { value: "edit", label: "Can edit" },
];
export const ADMISSIONS: readonly Choice<Admission>[] = [
  { value: "invite", label: "Link and code" },
  { value: "open", label: "Anyone with the link" },
];
export const DURATIONS: readonly Choice<number>[] = [
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
];

export function Pick<T extends string | number>({
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

export function ItemChoice({
  chosen,
  onChange,
}: {
  chosen: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { items } = useVault();
  const live = listedItems(activeItems(items));
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

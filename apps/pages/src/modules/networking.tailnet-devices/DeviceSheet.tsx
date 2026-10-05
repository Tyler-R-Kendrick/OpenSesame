/**
 * One device's settings, in a sheet: its name, tags, approval, key expiry,
 * subnet routes and exit node. Saving sends only what changed, each through
 * the daemon (ADR 0169), and reads the tailnet again; the sheet closes on the
 * row it came from.
 */

import {
  EXIT_ROUTES,
  offersExitNode,
  parseTags,
  relativeTo,
  shortName,
  subnetRoutes,
  validName,
} from "@opensesame/app-core/lib/tailnet-admin/model.js";
import type { TailnetDevice } from "@opensesame/app-core/lib/tailnet-admin/wire.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconMonitor } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { byId } from "../../lib/use-focus-after.js";
import { editKeyId } from "./DeviceRow.js";
import { ErrorMark, SwitchRow } from "./SwitchRow.js";
import type { TailnetModel } from "./use-tailnet-admin.js";

type Draft = {
  name: string;
  tags: string;
  authorized: boolean;
  expiry: boolean;
  routes: readonly string[];
};

function draftOf(device: TailnetDevice): Draft {
  return {
    name: shortName(device),
    tags: device.tags.join(" "),
    authorized: device.authorized,
    expiry: !device.keyExpiryDisabled,
    routes: device.enabledRoutes,
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

function toggled(
  list: readonly string[],
  items: readonly string[],
  on: boolean,
) {
  const rest = list.filter((item) => !items.includes(item));
  return on ? [...rest, ...items] : rest;
}

/**
 * Send only what changed. Taking a device off the tailnet goes first, so a
 * refusal of a later change cannot leave it admitted; admitting one goes
 * last, so it joins already renamed, tagged and routed.
 */
async function saveDiff(
  admin: TailnetModel["admin"],
  device: TailnetDevice,
  draft: Draft,
  tags: readonly string[],
) {
  const before = draftOf(device);
  const id = device.id;
  const authorize = draft.authorized !== before.authorized;
  if (authorize && !draft.authorized) await admin.setAuthorized(id, false);
  if (draft.name !== before.name) await admin.rename(id, draft.name.trim());
  if (!same(tags, device.tags)) await admin.setTags(id, tags);
  if (draft.expiry !== before.expiry)
    await admin.setKeyExpiryDisabled(id, !draft.expiry);
  if (!same(draft.routes, before.routes))
    await admin.setRoutes(id, draft.routes);
  if (authorize && draft.authorized) await admin.setAuthorized(id, true);
}

function changedFrom(
  device: TailnetDevice,
  draft: Draft,
  tags: readonly string[],
) {
  const before = draftOf(device);
  return (
    draft.name !== before.name ||
    !same(tags, device.tags) ||
    draft.authorized !== before.authorized ||
    draft.expiry !== before.expiry ||
    !same(draft.routes, before.routes)
  );
}

function deviceFacts(device: TailnetDevice, now: number) {
  const expires = device.keyExpiryDisabled
    ? "never"
    : (relativeTo(device.expires, now) ?? "unknown");
  return [
    { key: "Addresses", value: device.addresses.join(", ") || "none" },
    { key: "System", value: `${device.os} ${device.clientVersion}`.trim() },
    { key: "Owner", value: device.user || "tagged" },
    { key: "Key expires", value: expires },
  ];
}

function RouteSwitches({
  device,
  draft,
  set,
}: {
  device: TailnetDevice;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
}) {
  return (
    <>
      {subnetRoutes(device).map((route) => (
        <SwitchRow
          key={route}
          id={`tailnet-route-${route.replace(/[^a-z0-9]/gi, "-")}`}
          label={`Route ${route}`}
          on={draft.routes.includes(route)}
          onChange={(on) => set({ routes: toggled(draft.routes, [route], on) })}
        />
      ))}
      {offersExitNode(device) ? (
        <SwitchRow
          id="tailnet-device-exit"
          label="Exit node"
          on={EXIT_ROUTES.every((r) => draft.routes.includes(r))}
          onChange={(on) =>
            set({ routes: toggled(draft.routes, EXIT_ROUTES, on) })
          }
        />
      ) : null}
    </>
  );
}

function DeviceFields({
  device,
  draft,
  set,
}: {
  device: TailnetDevice;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
}) {
  return (
    <>
      <FieldShell
        id="tailnet-device-name"
        label="Name"
        mono
        autoComplete="off"
        value={draft.name}
        onValueChange={(name) => set({ name })}
        status={
          validName(draft.name) ? null : (
            <StatusMark
              tone="err"
              label="One label of lowercase letters, digits and hyphens"
            />
          )
        }
      />
      <FieldShell
        id="tailnet-device-tags"
        label="Tags"
        mono
        autoComplete="off"
        placeholder="tag:web tag:ci"
        value={draft.tags}
        onValueChange={(text) => set({ tags: text })}
        status={
          parseTags(draft.tags) === null ? (
            <StatusMark
              tone="err"
              label="Each tag is a lowercase name that starts with a letter"
            />
          ) : null
        }
      />
      <SwitchRow
        id="tailnet-device-authorized"
        label="Approved on the tailnet"
        on={draft.authorized}
        onChange={(authorized) => set({ authorized })}
      />
      <SwitchRow
        id="tailnet-device-expiry"
        label="Key expires"
        on={draft.expiry}
        onChange={(expiry) => set({ expiry })}
      />
      <RouteSwitches device={device} draft={draft} set={set} />
    </>
  );
}

export function DeviceSheet({
  device,
  model,
  now,
  onClose,
}: {
  device: TailnetDevice;
  model: TailnetModel;
  now: number;
  onClose: () => void;
}) {
  const title = `Settings for ${shortName(device)}`;
  const [draft, setDraft] = useState(() => draftOf(device));
  const tags = parseTags(draft.tags);
  const ready =
    tags !== null &&
    changedFrom(device, draft, tags) &&
    validName(draft.name) &&
    !model.busy;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const save = () => {
    if (!ready || tags === null) return;
    void model
      .run(
        () => saveDiff(model.admin, device, draft, tags),
        byId(editKeyId(device.id)),
      )
      .then((done) => {
        if (done) onClose();
      });
  };

  return (
    <CeremonySheet
      title={title}
      mark={<IconMonitor size={20} />}
      onClose={onClose}
    >
      <form
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <CeremonyShell
          ok={model.error === ""}
          name={device.name || shortName(device)}
          facts={deviceFacts(device, now)}
          primary={{
            label: "Save changes",
            submit: true,
            busy: model.busy,
            disabled: !ready,
            onClick: save,
          }}
        >
          <DeviceFields device={device} draft={draft} set={set} />
          <ErrorMark error={model.error} />
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}

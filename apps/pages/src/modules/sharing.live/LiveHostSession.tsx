/**
 * A live session this tab is hosting (ADR 0150 §2–§5): the link and code to
 * pass along, the field joiners' request codes are pasted into, who is asking
 * and who is in, every value handed out, and the key that ends it for
 * everyone.
 *
 * The link is shown masked, like any bearer; the code goes another way (a
 * call, a message), so it is drawn in the clear.
 */

import type {
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import { formatLiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  currentHostCarriers,
  endHosting,
} from "@opensesame/app-core/lib/live/session.js";
import { Suspense, lazy, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconX } from "../../components/Icons.js";
import { QrCode } from "../../components/QrCode.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import { DeviceRequests } from "./LiveHostDevices.js";
import { GuestRows, RequestPaste } from "./LiveHostGuests.js";
import { CarrierMarks } from "./LiveJoinRoutes.js";
import {
  formatRemaining,
  liveUiSeams,
  useRemaining,
  useRendezvousReady,
} from "./live-hooks.js";

const LivePeerTrustExport = lazy(() => import("./LivePeerTrustExport.js"));

function Log({ host, state }: { host: LiveHost; state: HostState }) {
  const { items } = useVault();
  if (state.log.length === 0) return null;
  const names = new Map(state.guests.map((guest) => [guest.key, guest.name]));
  // A line is about an item of the vault, or — a device's call — a connection.
  const connections = host.devices?.offered() ?? [];
  const itemName = (id: string) =>
    items.find((item) => item.id === id)?.name ??
    connections.find((connection) => connection.id === id)?.label ??
    id;
  // Calls on one connection in one millisecond are lines that read alike: the
  // nth of a kind is told apart by its place among them.
  const kinds = new Map<string, number>();
  const lines = state.log.map((entry) => {
    const kind = `${entry.at}:${entry.guest}:${entry.what}:${entry.item}:${entry.field}`;
    const nth = (kinds.get(kind) ?? 0) + 1;
    kinds.set(kind, nth);
    return { entry, key: `${kind}:${nth}` };
  });
  return (
    <ul className="live-log" aria-label="Handed out">
      {lines.reverse().map(({ entry, key }) => (
        <li key={key}>
          <StatusMark
            tone={entry.what === "denied" ? "err" : "idle"}
            label={`${new Date(entry.at).toLocaleTimeString()} · ${names.get(entry.guest) ?? "?"} · ${entry.what} · ${itemName(entry.item)} ${entry.field}`}
          />
        </li>
      ))}
    </ul>
  );
}

export function LiveHostSession({
  host,
  state,
}: { host: LiveHost; state: HostState }) {
  const [endAsk, setEndAsk] = useState(false);
  const { copied, failed, copy } = useCopyFeedback();
  const automatic = useRendezvousReady(currentHostCarriers());
  const left = useRemaining(host.expiresAt);
  const link = formatLiveLink(liveUiSeams.joinUrl(), host.link);
  return (
    <div className="setup__stack">
      <div className="live-status">
        <StatusMark tone="ok" label="Live" />
        {state.locked ? (
          <StatusMark tone="warn" label="Locked: too many wrong codes" />
        ) : null}
        <span className="vault-row__meta">{formatRemaining(left)}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="End the session for everyone"
          title="End the session for everyone"
          onClick={() => setEndAsk(true)}
        >
          <IconX size={16} />
        </button>
      </div>
      {endAsk ? (
        <CeremonySheet
          title="End for everyone"
          mark={<IconX size={20} />}
          onClose={() => setEndAsk(false)}
        >
          <CeremonyShell
            name="Live session"
            facts={[
              { key: "Guests", value: "lose access immediately" },
              { key: "This tab", value: "stops hosting" },
            ]}
            primary={{
              label: "End for everyone",
              tone: "danger",
              onClick: () => {
                setEndAsk(false);
                endHosting();
              },
            }}
          />
        </CeremonySheet>
      ) : null}
      <QrCode value={link} label="Scan to join this live session" size={168} />
      <FieldRow
        label="Link"
        actions={
          <CopyButton
            value={link}
            label="the link"
            fieldKey="live-link"
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <span className="frow__value frow__value--mono live-link">{link}</span>
      </FieldRow>
      {host.code ? (
        <FieldRow
          label="Code"
          actions={
            <CopyButton
              value={host.code}
              label="the code"
              fieldKey="live-code"
              copied={copied}
              failed={failed}
              onCopy={copy}
            />
          }
        >
          <span className="frow__value live-code">{host.code}</span>
        </FieldRow>
      ) : null}
      <CarrierMarks rendezvous={currentHostCarriers()} />
      {automatic ? null : <RequestPaste host={host} />}
      <details className="live-advanced">
        <summary>Peer trust signal</summary>
        <Suspense fallback={null}>
          <LivePeerTrustExport />
        </Suspense>
      </details>
      <GuestRows host={host} guests={state.guests} />
      <DeviceRequests host={host} state={state} />
      <Log host={host} state={state} />
    </div>
  );
}

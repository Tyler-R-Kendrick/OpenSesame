/**
 * Settings › Live sessions › Routes (ADR 0150 §6): how this vault's live
 * sessions reach people who are not on the same network — the Form view of
 * `settings/live/transport.json`. Every route is optional; with none, a
 * session is direct only and contacts nothing.
 *
 * A row per address, ICE server and carrier, each with one key; one field to
 * add each kind. Credentials a TURN server needs are asked beside its URL;
 * a carrier's are written in the file.
 */

import type {
  CarrierKind,
  LiveTransport,
} from "@opensesame/app-core/lib/live/transport.js";
import {
  CARRIER_KINDS,
  isAddress,
  isCarrierUrl,
  isIceUrl,
} from "@opensesame/app-core/lib/live/transport.js";
import { useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlus, IconTrash } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { GuideTarget } from "../../tutorial/registry/react.jsx";
import { useLiveTransport } from "./live-transport-hooks.js";
import "./live.css";

const KIND_LABELS = {
  nostr: "Nostr relay",
  mqtt: "MQTT broker",
  nats: "NATS server",
  ntfy: "ntfy server",
  broadcast: "This browser's tabs",
} satisfies Record<CarrierKind, string>;

function RemoveKey({
  label,
  onRemove,
}: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={onRemove}
    >
      <IconTrash size={16} />
    </button>
  );
}

type Change = (next: LiveTransport) => Promise<string | null>;

function Addresses({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  const [draft, setDraft] = useState("");
  const value = draft.trim();
  return (
    <>
      {transport.addresses.map((address) => (
        <FieldRow
          key={address}
          label="Reachable at"
          actions={
            <RemoveKey
              label={`Remove ${address}`}
              onRemove={() =>
                void change({
                  ...transport,
                  addresses: transport.addresses.filter(
                    (entry) => entry !== address,
                  ),
                })
              }
            />
          }
        >
          <span className="frow__value frow__value--mono">{address}</span>
        </FieldRow>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!isAddress(value)) return;
          void change({
            ...transport,
            addresses: [...transport.addresses, value],
          }).then((refused) => refused === null && setDraft(""));
        }}
      >
        <FieldShell
          id="live-address"
          label="Tailnet, VPN or LAN address"
          mono
          placeholder="100.64.0.1"
          value={draft}
          onValueChange={setDraft}
          status={
            value && !isAddress(value) ? (
              <StatusMark tone="err" label="Not an IP address" />
            ) : null
          }
          tail={
            <button
              type="submit"
              className="icon-btn"
              aria-label="Add the address"
              title="Add the address"
              disabled={!isAddress(value)}
            >
              <IconPlus size={16} />
            </button>
          }
        />
      </form>
    </>
  );
}

function IceServers({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [credential, setCredential] = useState("");
  const value = url.trim();
  const turn = value.startsWith("turn");
  const ready =
    isIceUrl(value) && (!turn || (username !== "" && credential !== ""));
  return (
    <>
      {transport.ice.map((server, at) => (
        <FieldRow
          key={server.urls.join(" ")}
          label={
            server.urls.some((entry) => entry.startsWith("turn"))
              ? "TURN"
              : "STUN"
          }
          actions={
            <RemoveKey
              label={`Remove ${server.urls[0] ?? "the server"}`}
              onRemove={() =>
                void change({
                  ...transport,
                  ice: transport.ice.filter((_, index) => index !== at),
                  relay: transport.relay && transport.ice.length > 1,
                })
              }
            />
          }
        >
          <span className="frow__value frow__value--mono">
            {server.urls.join(" ")}
          </span>
        </FieldRow>
      ))}
      <form
        className="setup__stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const server = turn
            ? { urls: [value], username, credential }
            : { urls: [value] };
          void change({ ...transport, ice: [...transport.ice, server] }).then(
            (refused) => {
              if (refused !== null) return;
              setUrl("");
              setUsername("");
              setCredential("");
            },
          );
        }}
      >
        <FieldShell
          id="live-ice"
          label="STUN or TURN server"
          mono
          placeholder="turns:turn.example.com:443?transport=tcp"
          value={url}
          onValueChange={setUrl}
          status={
            value && !isIceUrl(value) ? (
              <StatusMark tone="err" label="Not a stun: or turn: URL" />
            ) : null
          }
        />
        {turn ? (
          <>
            <FieldShell
              id="live-ice-user"
              label="TURN username"
              autoComplete="off"
              value={username}
              onValueChange={setUsername}
            />
            <FieldShell
              id="live-ice-credential"
              label="TURN credential"
              type="password"
              autoComplete="off"
              value={credential}
              onValueChange={setCredential}
            />
          </>
        ) : null}
        <FormCommit
          label="Add the server"
          disabled={!ready}
          icon={<IconPlus size={18} />}
        />
      </form>
    </>
  );
}

function RelayOnly({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  const hasTurn = transport.ice.some((server) =>
    server.urls.some((url) => url.startsWith("turn")),
  );
  return (
    <label className="join__choice">
      <input
        type="checkbox"
        checked={transport.relay}
        disabled={!hasTurn}
        onChange={(event) =>
          void change({ ...transport, relay: event.target.checked })
        }
      />
      <span>Relay only, through TURN</span>
    </label>
  );
}

function Carriers({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  return (
    <>
      {transport.carriers.map((carrier, at) => (
        <FieldRow
          key={`${carrier.kind} ${carrier.url}`}
          label={KIND_LABELS[carrier.kind]}
          actions={
            <RemoveKey
              label={`Remove ${carrier.url || KIND_LABELS[carrier.kind]}`}
              onRemove={() =>
                void change({
                  ...transport,
                  carriers: transport.carriers.filter(
                    (_, index) => index !== at,
                  ),
                })
              }
            />
          }
        >
          <span className="frow__value frow__value--mono">
            {carrier.url || "—"}
          </span>
        </FieldRow>
      ))}
      <CarrierAdd transport={transport} change={change} />
    </>
  );
}

function CarrierAdd({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  const [kind, setKind] = useState<CarrierKind>("ntfy");
  const [url, setUrl] = useState("");
  const value = kind === "broadcast" ? "" : url.trim();
  const ready = isCarrierUrl(kind, value);
  return (
    <form
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void change({
          ...transport,
          carriers: [...transport.carriers, { kind, url: value }],
        }).then((refused) => refused === null && setUrl(""));
      }}
    >
      <div className="sw">
        <label className="sw__name" htmlFor="live-carrier-kind">
          Code carrier
        </label>
        <select
          id="live-carrier-kind"
          className="sw__select"
          value={kind}
          onChange={(event) => {
            const picked = CARRIER_KINDS.find(
              (entry) => entry === event.target.value,
            );
            if (picked) setKind(picked);
          }}
        >
          {CARRIER_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      {kind === "broadcast" ? null : (
        <FieldShell
          id="live-carrier-url"
          label={kind === "ntfy" ? "Server (https://)" : "Server (wss://)"}
          mono
          type="url"
          placeholder={
            kind === "ntfy"
              ? "https://ntfy.example.com"
              : "wss://relay.example.com"
          }
          value={url}
          onValueChange={setUrl}
          status={
            value && !ready ? (
              <StatusMark tone="err" label="Needs a secure address" />
            ) : null
          }
        />
      )}
      <FormCommit
        label="Add the carrier"
        disabled={!ready}
        icon={<IconPlus size={18} />}
      />
    </form>
  );
}

export function LiveRoutesPanel() {
  const { transport, loaded, change } = useLiveTransport();
  const [refused, setRefused] = useState("");
  const apply: Change = async (next) => {
    const outcome = await change(next);
    setRefused(outcome ?? "");
    return outcome;
  };
  return (
    <GuideTarget id="settings.live-routes">
      <section className="panel" id="live-routes">
        <div className="panel__head">
          <div>
            <h2>Routes</h2>
          </div>
        </div>
        <div className="panel__body setup__stack">
          {loaded ? (
            <>
              <Addresses transport={transport} change={apply} />
              <IceServers transport={transport} change={apply} />
              <RelayOnly transport={transport} change={apply} />
              <Carriers transport={transport} change={apply} />
              {refused ? <StatusMark tone="err" label={refused} /> : null}
            </>
          ) : (
            <StatusMark tone="idle" label="Reading this vault's routes" />
          )}
        </div>
      </section>
    </GuideTarget>
  );
}

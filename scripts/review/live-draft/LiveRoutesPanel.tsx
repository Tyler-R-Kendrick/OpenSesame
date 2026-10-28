/**
 * Routes, under the share sheet's Advanced (ADR 0150 §6): how this
 * vault's live sessions reach people who are not on the same network —
 * the Form view of `settings/live/transport.json`. Every route is
 * optional; with none, a session is direct only and contacts nothing.
 *
 * A row per address, ICE server and carrier, each with one key; one field to
 * add each kind. Credentials a TURN server needs are asked beside its URL;
 * a NATS server's sign-in and session route beside its URL (ADR 0167); any
 * other carrier's credentials, and a TURN server's REST `secret`, are written
 * in the file, which the key on the heading opens (ADR 0134).
 */

import {
  type LiveTransport,
  carriesCredentials,
  isAddress,
  isIceUrl,
} from "@opensesame/app-core/lib/live/transport.js";
import { TRANSPORT_FILE } from "@opensesame/app-core/sections/settings/live-transport-files.js";
import { useRef, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { OpenFileKey } from "../../sections/settings/files/OpenFileKey.js";
import { Carriers } from "./LiveCarriers.js";
import {
  type Change,
  RemoveKey,
  useRouteSaveGuard,
} from "./live-route-parts.js";
import {
  withAddress,
  withServer,
  withoutAddress,
  withoutServer,
} from "./live-transport-edits.js";
import { useLiveTransport } from "./live-transport-hooks.js";
import "./live.css";

function Addresses({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  const [draft, setDraft] = useState("");
  const draftRevision = useRef(0);
  const value = draft.trim();
  return (
    <>
      {transport.addresses.map((address, at) => (
        <FieldRow
          key={`${at}:${address}`}
          label="Reachable at"
          actions={
            <RemoveKey
              label={`Remove ${address}`}
              onRemove={() =>
                void change((now) => withoutAddress(now, address))
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
          const submittedRevision = draftRevision.current;
          void change((now) => withAddress(now, value)).then((refused) => {
            if (refused === null && draftRevision.current === submittedRevision)
              setDraft("");
          });
        }}
      >
        <FieldShell
          id="live-address"
          label="Tailnet, VPN or LAN address"
          mono
          placeholder="100.64.0.1"
          value={draft}
          onValueChange={(next) => {
            draftRevision.current += 1;
            setDraft(next);
          }}
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
  const draftRevision = useRef({ url: 0, username: 0, credential: 0 });
  const save = useRouteSaveGuard();
  const value = url.trim();
  const turn = value.startsWith("turn");
  const ready =
    isIceUrl(value) && (!turn || (username !== "" && credential !== ""));
  return (
    <>
      {transport.ice.map((server, at) => (
        <FieldRow
          key={`${at}:${server.urls.join(" ")}`}
          label={
            server.urls.some((entry) => entry.startsWith("turn"))
              ? "TURN"
              : "STUN"
          }
          actions={
            <RemoveKey
              label={`Remove ${server.urls[0] ?? "the server"}`}
              onRemove={() => void change((now) => withoutServer(now, server))}
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
          if (!ready || !save.begin()) return;
          const server = turn
            ? { urls: [value], username, credential }
            : { urls: [value] };
          const submittedRevision = { ...draftRevision.current };
          void change((now) => withServer(now, server))
            .then((refused) => {
              if (refused !== null) return;
              if (draftRevision.current.url === submittedRevision.url)
                setUrl("");
              if (draftRevision.current.username === submittedRevision.username)
                setUsername("");
              if (
                draftRevision.current.credential ===
                submittedRevision.credential
              )
                setCredential("");
            })
            .finally(save.finish);
        }}
      >
        <FieldShell
          id="live-ice"
          label="STUN or TURN server"
          mono
          placeholder="turns:turn.example.com:443?transport=tcp"
          value={url}
          onValueChange={(next) => {
            draftRevision.current.url += 1;
            setUrl(next);
          }}
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
              onValueChange={(next) => {
                draftRevision.current.username += 1;
                setUsername(next);
              }}
            />
            <FieldShell
              id="live-ice-credential"
              label="TURN credential"
              type="password"
              autoComplete="off"
              value={credential}
              onValueChange={(next) => {
                draftRevision.current.credential += 1;
                setCredential(next);
              }}
            />
          </>
        ) : null}
        <FormCommit
          label="Add the server"
          disabled={!ready || save.pending}
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
  // Relay only means nothing until there is a TURN server, so with none the
  // choice is not drawn (ADR 0158) — unless it is already on, when it has to
  // stay reachable to be turned off.
  if (!hasTurn && !transport.relay) return null;
  return (
    <label className="join__choice">
      <input
        type="checkbox"
        checked={transport.relay}
        onChange={(event) =>
          void change((now) => ({ ...now, relay: event.target.checked }))
        }
      />
      <span>Relay only, through TURN</span>
    </label>
  );
}

export function LiveRoutesPanel() {
  const { transport, loaded, refused, change } = useLiveTransport();
  const [edited, setEdited] = useState("");
  const apply: Change = async (edit) => {
    const outcome = await change(edit);
    setEdited(outcome ?? "");
    return outcome;
  };
  return (
    <div className="setup__stack" id="live-routes">
      <div className="live-routes__head">
        <h3>Routes</h3>
        {loaded ? (
          // Over a profile that will not read too: the file is where it is fixed.
          <div className="actions">
            <OpenFileKey path={TRANSPORT_FILE} name="transport.json" />
          </div>
        ) : null}
      </div>
      <div className="setup__stack">
        {!loaded ? (
          <StatusMark tone="idle" label="Reading this vault's routes" />
        ) : refused ? (
          <StatusMark tone="err" label={refused} />
        ) : (
          <>
            <Addresses transport={transport} change={apply} />
            <IceServers transport={transport} change={apply} />
            <RelayOnly transport={transport} change={apply} />
            <Carriers transport={transport} change={apply} />
            {carriesCredentials(transport) ? (
              <StatusMark
                tone="warn"
                label="Credentials in this profile travel in the link"
              />
            ) : null}
            {edited ? <StatusMark tone="err" label={edited} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

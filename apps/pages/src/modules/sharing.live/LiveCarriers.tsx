/** The code carriers of the Routes Form (ADR 0150 §6): a row each, one to add. */

import {
  CARRIER_KINDS,
  type CarrierKind,
  type LiveTransport,
  isCarrierUrl,
} from "@opensesame/app-core/lib/live/transport.js";
import { useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { type Change, KIND_LABELS, RemoveKey } from "./live-route-parts.js";
import { withCarrier, withoutCarrier } from "./live-transport-edits.js";

export function Carriers({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  return (
    <>
      {transport.carriers.map((carrier, at) => (
        <FieldRow
          key={`${at}:${carrier.kind} ${carrier.url}`}
          label={KIND_LABELS[carrier.kind]}
          actions={
            <RemoveKey
              label={`Remove ${carrier.url || KIND_LABELS[carrier.kind]}`}
              onRemove={() =>
                void change((now) => withoutCarrier(now, carrier))
              }
            />
          }
        >
          <span className="frow__value frow__value--mono">
            {carrier.url || "—"}
          </span>
        </FieldRow>
      ))}
      <CarrierAdd change={change} />
    </>
  );
}

function CarrierAdd({ change }: { change: Change }) {
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
        void change((now) => withCarrier(now, { kind, url: value })).then(
          (refused) => refused === null && setUrl(""),
        );
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

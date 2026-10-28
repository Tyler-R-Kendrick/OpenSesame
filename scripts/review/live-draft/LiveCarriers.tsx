/**
 * The code carriers of the Routes Form (ADR 0150 §6): a row each, one to add.
 * A NATS server also says how it signs in and whether the session itself may
 * cross it (ADR 0167, `LiveNatsFields.tsx`).
 */

import {
  CARRIER_KINDS,
  type CarrierKind,
  type LiveTransport,
  isCarrierUrl,
} from "@opensesame/app-core/lib/live/transport.js";
import { Fragment, useRef, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlus } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  EMPTY_NATS_DRAFT,
  NatsAddFields,
  type NatsDraft,
  NatsSessionChoice,
  natsDraftFields,
  natsDraftReady,
} from "./LiveNatsFields.js";
import {
  type Change,
  KIND_LABELS,
  RemoveKey,
  useRouteSaveGuard,
} from "./live-route-parts.js";
import { withCarrier, withoutCarrier } from "./live-transport-edits.js";

export function Carriers({
  transport,
  change,
}: { transport: LiveTransport; change: Change }) {
  return (
    <>
      {transport.carriers.map((carrier, at) => (
        <Fragment key={`${at}:${carrier.kind} ${carrier.url}`}>
          <FieldRow
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
          {/* Its own row: inside the server's, a phone squeezed it off the edge. */}
          {carrier.kind === "nats" ? (
            <NatsSessionChoice carrier={carrier} at={at} change={change} />
          ) : null}
        </Fragment>
      ))}
      <CarrierAdd change={change} />
    </>
  );
}

function CarrierAdd({ change }: { change: Change }) {
  const [kind, setKind] = useState<CarrierKind>("ntfy");
  const [url, setUrl] = useState("");
  const [nats, setNats] = useState<NatsDraft>(EMPTY_NATS_DRAFT);
  const urlRevision = useRef(0);
  const kindRevision = useRef(0);
  const natsRevision = useRef<Record<keyof NatsDraft, number>>({
    signIn: 0,
    account: 0,
    signingKey: 0,
    jwt: 0,
    seed: 0,
    session: 0,
  });
  const save = useRouteSaveGuard();
  const value = kind === "broadcast" ? "" : url.trim();
  const isNats = kind === "nats";
  const ready = isCarrierUrl(kind, value) && (!isNats || natsDraftReady(nats));
  return (
    <form
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !save.begin()) return;
        const extra = isNats ? natsDraftFields(nats) : {};
        const submittedURL = urlRevision.current;
        const submittedKind = kindRevision.current;
        const submittedNats = { ...natsRevision.current };
        void change((now) => withCarrier(now, { kind, url: value, ...extra }))
          .then((refused) => {
            const urlChanged = urlRevision.current !== submittedURL;
            const kindChanged = kindRevision.current !== submittedKind;
            const targetChanged = urlChanged || kindChanged;
            if (refused !== null && !targetChanged) return;
            if (!urlChanged && (refused === null || kindChanged)) setUrl("");
            // Clear a submitted secret unless this exact field was edited since
            // submit. A different destination alone must not reuse the old key.
            setNats((now) => {
              const edited = (field: keyof NatsDraft) =>
                natsRevision.current[field] !== submittedNats[field];
              const authEdited = (
                ["signIn", "account", "signingKey", "jwt", "seed"] as const
              ).some(edited);
              return {
                signIn: authEdited ? now.signIn : EMPTY_NATS_DRAFT.signIn,
                account: edited("account") ? now.account : "",
                signingKey: edited("signingKey") ? now.signingKey : "",
                jwt: edited("jwt") ? now.jwt : "",
                seed: edited("seed") ? now.seed : "",
                session:
                  refused !== null || edited("session")
                    ? now.session
                    : EMPTY_NATS_DRAFT.session,
              };
            });
          })
          .finally(save.finish);
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
            if (picked) {
              kindRevision.current += 1;
              setKind(picked);
            }
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
          onValueChange={(next) => {
            urlRevision.current += 1;
            setUrl(next);
          }}
          status={
            value && !ready ? (
              <StatusMark tone="err" label="Needs a secure address" />
            ) : null
          }
        />
      )}
      {isNats ? (
        <NatsAddFields
          draft={nats}
          edit={(patch) => {
            for (const field of Object.keys(patch) as (keyof NatsDraft)[])
              natsRevision.current[field] += 1;
            setNats((now) => ({ ...now, ...patch }));
          }}
        />
      ) : null}
      <FormCommit
        label="Add the carrier"
        disabled={!ready || save.pending}
        icon={<IconPlus size={18} />}
      />
    </form>
  );
}

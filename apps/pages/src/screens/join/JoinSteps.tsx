/**
 * The join ceremony's step bodies (ADR 0136). Each shows what the endpoint
 * said, as text, and asks for one thing. A failure is a `StatusMark` beside
 * the field it belongs to — never a box of prose (DESIGN.md › Status is a
 * symbol).
 */

import { lockedItems } from "@opensesame/app-core/lib/join/consent.js";
import type { JoinOffer } from "@opensesame/app-core/lib/join/wire.js";
import {
  JOIN_TITLE,
  endpointMark,
  joinErrorField,
  joinErrorText,
  joinExpiry,
} from "@opensesame/app-core/screens/join/join-model.js";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconLogin,
  IconNote,
  IconSecret,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { JoinCeremony } from "./useJoinCeremony.js";

type Props = { join: JoinCeremony; configured: string };
type Field = "endpoint" | "invite" | "code" | "session" | "note";

function fieldMark(join: JoinCeremony, field: Field) {
  if (!join.error || joinErrorField(join.error) !== field) return null;
  return <StatusMark tone="err" label={joinErrorText(join.error)} />;
}

function EndpointField({ join, configured }: Props) {
  const mark = endpointMark(join.endpoint.trim(), configured);
  const status =
    fieldMark(join, "endpoint") ??
    (mark === "other" ? (
      <StatusMark tone="warn" label="Not this deployment's own endpoint" />
    ) : null);
  return (
    <FieldShell
      id="join-endpoint"
      label="Endpoint"
      type="url"
      mono
      lead={<IconAuthority size={17} />}
      placeholder="https://vault.example.org"
      value={join.endpoint}
      disabled={join.busy || join.step !== "where"}
      status={status}
      onValueChange={join.setEndpoint}
    />
  );
}

function Where(props: Props) {
  const { join } = props;
  return (
    <>
      <fieldset className="preset join__group" aria-label="How you get in">
        {(
          [
            ["invite", "Invite", "a link and a code"],
            ["open", "Open session", "an endpoint anyone may ask"],
          ] as const
        ).map(([road, name, kind]) => (
          <button
            key={road}
            type="button"
            aria-pressed={join.road === road}
            className={join.road === road ? "preset__opt is-on" : "preset__opt"}
            disabled={join.busy}
            onClick={() => join.chooseRoad(road)}
          >
            <span className="preset__name">{name}</span>
            <span className="preset__kind">{kind}</span>
          </button>
        ))}
      </fieldset>
      <EndpointField {...props} />
      {join.road === "invite" ? (
        <FieldShell
          id="join-invite"
          label="Invite"
          type="text"
          mono
          lead={<IconSecret size={17} />}
          placeholder="Link or osc_dlg_ token"
          autoComplete="off"
          value={join.inviteText}
          disabled={join.busy}
          status={fieldMark(join, "invite")}
          onValueChange={join.setInviteText}
        />
      ) : null}
    </>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="wrote-list">
      {rows.map(([key, value]) => (
        <div className="wrote-list__row" key={key}>
          <dt className="wrote-list__key">{key}</dt>
          <dd className="wrote-list__val">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Offer({ join, offer }: { join: JoinCeremony; offer: JoinOffer }) {
  const locked = lockedItems(offer);
  return (
    <>
      <Facts
        rows={[
          ["Endpoint", join.endpoint],
          ["Offer ends", joinExpiry(offer.expiresAt)],
        ]}
      />
      <ul className="join__items" aria-label="Offered access">
        {offer.items.map((item) => {
          const fixed = locked.has(item.id);
          const detail = [item.actions.join(", "), item.resources.join(", ")]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={item.id} className="join__item">
              <label className="join__choice">
                <input
                  type="checkbox"
                  checked={join.selection.has(item.id)}
                  disabled={fixed || join.busy}
                  onChange={() => join.toggle(item.id)}
                />
                <span className="join__name">{item.displayName}</span>
                {fixed ? (
                  <StatusMark tone="idle" label="Required by the offer" />
                ) : null}
                {detail ? <span className="join__detail">{detail}</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Approve({ join }: { join: JoinCeremony }) {
  return (
    <Facts
      rows={[
        ["Endpoint", join.endpoint],
        ["Read this to the operator", join.prompt?.userCode ?? "—"],
      ]}
    />
  );
}

function Accept({ join }: { join: JoinCeremony }) {
  return (
    <FieldShell
      id="join-code"
      label="Code"
      type="text"
      mono
      lead={<IconLogin size={17} />}
      placeholder="BCDF-GHJK"
      autoComplete="one-time-code"
      value={join.code}
      disabled={join.busy}
      status={fieldMark(join, "code")}
      onValueChange={join.setCode}
    />
  );
}

function Ask({ join }: { join: JoinCeremony }) {
  const listed = join.sessions ?? [];
  return (
    <>
      {listed.length > 0 ? (
        <fieldset
          className="join__sessions join__group"
          aria-label="Open sessions"
        >
          {listed.map((session) => (
            <button
              key={session.id}
              type="button"
              aria-pressed={join.sessionId === session.id}
              className={
                join.sessionId === session.id
                  ? "preset__opt is-on"
                  : "preset__opt"
              }
              disabled={join.busy}
              onClick={() => join.setSessionId(session.id)}
            >
              <span className="preset__name">{session.displayName}</span>
            </button>
          ))}
        </fieldset>
      ) : null}
      <FieldShell
        id="join-session"
        label="Session"
        type="text"
        mono
        lead={<IconAuthority size={17} />}
        placeholder="session:…"
        value={join.sessionId}
        disabled={join.busy}
        status={fieldMark(join, "session")}
        onValueChange={join.setSessionId}
      />
      <FieldShell
        id="join-note"
        label="Note for the operator"
        type="text"
        lead={<IconNote size={17} />}
        value={join.note}
        disabled={join.busy}
        status={fieldMark(join, "note")}
        onValueChange={join.setNote}
      />
    </>
  );
}

function Done({ join }: { join: JoinCeremony }) {
  if (join.road === "open") {
    const decision = join.receipt?.decision ?? "pending";
    return (
      <Facts
        rows={[
          ["Endpoint", join.endpoint],
          ["Session", join.sessionId],
          [
            "Answer",
            decision === "pending" ? "waiting on the operator" : decision,
          ],
        ]}
      />
    );
  }
  return (
    <Facts
      rows={[
        ["Endpoint", join.endpoint],
        ["Connections", String(join.claimed)],
      ]}
    />
  );
}

export function JoinStepBody(props: Props) {
  const { join } = props;
  return (
    <>
      <div className="setup__head">
        <h1>
          {join.step === "done" && join.road === "open"
            ? "Asked"
            : JOIN_TITLE[join.step]}
        </h1>
      </div>
      <div className="setup__stack">
        {join.step === "where" ? <Where {...props} /> : null}
        {join.step === "review" ? (
          join.offer ? (
            <Offer join={join} offer={join.offer} />
          ) : (
            <Facts rows={[["Endpoint", join.endpoint]]} />
          )
        ) : null}
        {join.step === "approve" ? <Approve join={join} /> : null}
        {join.step === "verify" ? (
          <Facts rows={[["Endpoint", join.endpoint]]} />
        ) : null}
        {join.step === "accept" ? <Accept join={join} /> : null}
        {join.step === "ask" ? <Ask join={join} /> : null}
        {join.step === "done" ? <Done join={join} /> : null}
      </div>
    </>
  );
}

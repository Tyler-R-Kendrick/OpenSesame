import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  LIVE_SESSION_ENDED_TRAY,
  reportLiveOutcome,
} from "@opensesame/app-core/lib/live/outcome-notices.js";
import {
  currentGuestCarriers,
  leaveLive,
} from "@opensesame/app-core/lib/live/session.js";
import { rememberTrustedPeer } from "@opensesame/app-core/lib/peer-trust/peers.js";
import { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { FormCommit } from "../../components/FormCommit.js";
import { IconArrowRight } from "../../components/Icons.js";
import { IconInfo } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl } from "../../lib/focus.js";
import { useVault } from "../../lib/vault/hooks.js";
import { LiveCatalog } from "./LiveCatalog.js";
import { ReplyAddresses } from "./LiveJoinAddresses.js";
import {
  JoinPersonFields,
  JoinVaultSealFields,
  LiveLinkField,
  PeerTrustField,
} from "./LiveJoinFields.js";
import { RequestStep } from "./LiveJoinPairing.js";
import { CarrierMarks, RoutesChoice } from "./LiveJoinRoutes.js";
import { ConnectingProgress, standing } from "./LiveJoinStanding.js";
import { takeVaultEntry, useVaultEntryPending } from "./live-entry.js";
import { useLandWhenSettled } from "./live-focus.js";
import {
  type Standing,
  formatRemaining,
  useLiveGuest,
  useRemaining,
  useRendezvousReady,
} from "./live-hooks.js";
import { useAsk } from "./live-join-ask-state.js";
import { joinAskDisabledReason } from "./live-join-trust.js";

/** A fresh request after a timed-out attempt (ADR 0186). */
const ASK_AGAIN = "Ask to join again";

export function LiveJoinAskForm({ held }: { held: LiveLink | null }) {
  const vault = useVault();
  const askState = useAsk(held, vault.status);
  const {
    fields,
    link,
    needsCode,
    ready,
    busy,
    failed,
    alarm,
    sealProblem,
    ask,
  } = askState;
  const form = useRef<HTMLFormElement>(null);
  const disabledReason = joinAskDisabledReason({
    alarm,
    ready,
    busy,
    link,
    pasted: fields.pasted,
    needsCode: needsCode ?? false,
    code: fields.code,
    name: fields.name,
    sealProblem: sealProblem ?? undefined,
  });
  useLandWhenSettled(busy, () => form.current?.querySelector(".go"));

  return (
    <form
      ref={form}
      className="setup__stack"
      onSubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <JoinAskFields held={held} vaultStatus={vault.status} state={askState} />
      {failed && failed !== alarm ? (
        <StatusMark tone="err" label={failed} />
      ) : null}
      {alarm ? <StatusMark tone="err" label={alarm} /> : null}
      {!ready && !busy && disabledReason ? (
        <output className="live-help">{disabledReason}</output>
      ) : null}
      <FormCommit
        label="Ask to join"
        disabled={!ready || busy || alarm.length > 0}
        disabledReason={disabledReason}
        busy={busy}
        icon={<IconArrowRight size={18} />}
      />
    </form>
  );
}

function JoinAskFields({
  held,
  vaultStatus,
  state,
}: {
  held: LiveLink | null;
  vaultStatus: "empty" | "locked" | "unlocked";
  state: ReturnType<typeof useAsk>;
}) {
  const { fields, set, link, routes, needsCode, busy, pinProblems } = state;
  const {
    pasted,
    code,
    name,
    note,
    peerTrust,
    useRoutes,
    pin,
    confirm,
    accepted,
  } = fields;
  const {
    setPasted,
    setCode,
    setName,
    setNote,
    setPeerTrust,
    setUseRoutes,
    setPin,
    setConfirm,
    setAccepted,
  } = set;
  return (
    <>
      {held && link ? <StatusMark tone="ok" label="Link in hand" /> : null}
      {held && !link ? (
        <StatusMark tone="err" label="Not a live-session link" />
      ) : null}
      {held ? null : (
        <LiveLinkField
          pasted={pasted}
          link={link}
          busy={busy}
          setPasted={setPasted}
        />
      )}
      <JoinPersonFields
        needsCode={needsCode ?? false}
        code={code}
        name={name}
        note={note}
        busy={busy}
        setCode={setCode}
        setName={setName}
        setNote={setNote}
      />
      {vaultStatus === "empty" || vaultStatus === "locked" ? (
        <JoinVaultSealFields
          pin={pin}
          confirm={confirm}
          accepted={accepted}
          problems={pinProblems}
          busy={busy}
          setPin={setPin}
          setConfirm={setConfirm}
          setAccepted={setAccepted}
        />
      ) : null}
      {vaultStatus === "locked" ? (
        <p className="live-help">
          <IconInfo size={14} aria-hidden="true" /> A vault is locked on this
          device. Joining creates a new vault for this person; the old locked
          vault and its items stay on the device.
        </p>
      ) : null}
      <p className="live-help">
        <IconInfo size={14} aria-hidden="true" /> The owner sees the name you
        enter. Your own vault is separate; shared items stay live in this tab
        while the session is open.
      </p>
      <details className="live-advanced">
        <summary>Advanced</summary>
        {routes ? (
          <RoutesChoice
            routes={routes}
            checked={useRoutes}
            disabled={busy}
            onChange={setUseRoutes}
          />
        ) : null}
        <p className="live-help">
          <IconInfo size={14} aria-hidden="true" /> Peer trust is only for a
          code the owner gave you outside this link. Most people can leave it
          empty.
        </p>
        <PeerTrustField
          peerTrust={peerTrust}
          busy={busy}
          setPeerTrust={setPeerTrust}
        />
      </details>
    </>
  );
}

export function LiveJoinSession() {
  const { guest, status } = useLiveGuest();
  const vault = useVault();
  const navigate = useNavigate();
  const enterPending = useVaultEntryPending();
  const catalog = status?.at === "joined" ? status.catalog : null;
  const left = useRemaining(catalog?.expiresAt ?? null);
  const mark = status ? standing(status) : null;
  useEffect(() => {
    if (status?.at === "unreachable") {
      reportLiveOutcome("Live session", status.reason);
    }
    if (status?.at === "ended") {
      reportLiveOutcome("Live session", mark?.tray || LIVE_SESSION_ENDED_TRAY);
    }
  }, [status, mark?.tray]);
  useEffect(() => {
    if (status?.at !== "joined" || vault.status !== "unlocked") return;
    if (!enterPending || !takeVaultEntry()) return;
    navigate("/vault", { replace: true });
  }, [status?.at, vault.status, enterPending, navigate]);
  useEffect(() => {
    if (status?.at !== "joined" || !guest) return;
    const owner = guest.trustedOwner();
    if (!owner) return;
    void rememberTrustedPeer(owner).catch(() => undefined);
  }, [guest, status]);
  const opened = openedSession(guest, status, mark);
  if (!opened) return null;
  return (
    <div className="setup__stack" id="live-view">
      <div className="live-status" id="live-status" tabIndex={-1}>
        <StatusMark tone={opened.mark.tone} label={opened.mark.label} />
        <span className="live-status__label">{opened.mark.label}</span>
        <span className="vault-row__meta">
          {catalog ? formatRemaining(left) : opened.mark.tray}
        </span>
        {opened.status.at === "joined" && vault.status === "unlocked" ? (
          <Link className="btn btn--sm" to="/vault">
            Open my vault
          </Link>
        ) : null}
      </div>
      {opened.status.at === "request" ? (
        <RequestWaiting guest={opened.guest} status={opened.status} />
      ) : null}
      {opened.status.at === "addresses" ? (
        <ReplyAddresses guest={opened.guest} status={opened.status} />
      ) : null}
      {opened.status.at === "connecting" ? (
        <ConnectingProgress guest={opened.guest} status={opened.status} />
      ) : null}
      {opened.status.at === "connect_timeout" ? (
        <div className="go-row">
          <button
            type="button"
            className="go"
            aria-label={ASK_AGAIN}
            title={ASK_AGAIN}
            onClick={() =>
              void opened.guest.askAgain().catch(() => {
                leaveLive();
                reportLiveOutcome(
                  "Live session",
                  "This browser could not make a request code",
                );
              })
            }
          >
            <IconArrowRight size={18} />
          </button>
          <span className="go-verb" aria-hidden="true">
            {ASK_AGAIN}
          </span>
        </div>
      ) : null}
      {catalog ? (
        <LiveCatalog
          catalog={catalog}
          request={(what, item, field) =>
            opened.guest.request(what, item, field)
          }
          save={(item, field, value) => opened.guest.edit(item, field, value)}
        />
      ) : null}
    </div>
  );
}

function openedSession(
  guest: LiveGuest | null,
  status: GuestStatus | null,
  mark: Standing | null,
): { guest: LiveGuest; status: GuestStatus; mark: Standing } | null {
  if (!guest || !status || !mark) return null;
  return { guest, status, mark };
}

function RequestWaiting({
  guest,
  status,
}: {
  guest: LiveGuest;
  status: Extract<GuestStatus, { at: "request" }>;
}) {
  const automatic = useRendezvousReady(currentGuestCarriers());
  return (
    <>
      <CarrierMarks rendezvous={currentGuestCarriers()} />
      {automatic ? (
        <StatusMark
          tone="idle"
          label="The owner can see your request. Waiting for them to let you in."
        />
      ) : null}
      {status.sas ? (
        <details className="live-verify">
          <summary>Security code</summary>
          <p className="live-help">
            Compare this with the owner if you are on a call with them. It is
            not needed when the owner already recognises your request.
          </p>
          <span className="frow__value frow__value--mono live-sas">
            {status.sas}
          </span>
        </details>
      ) : null}
      {status.unverified ? <StatusMark tone="warn" label="Unverified" /> : null}
      {automatic ? null : <RequestStep guest={guest} code={status.code} />}
    </>
  );
}

export function liveJoinLandingFor(
  root: HTMLElement | null,
  at: GuestStatus["at"] | "ask" | undefined,
): Element | null {
  switch (at) {
    case "ask":
      return firstControl(root?.querySelector("form"));
    case "preparing":
    case "request":
      return firstControl(document.getElementById("live-view"));
    case "addresses":
      return document.getElementById("live-addresses-allow");
    case "connecting":
    case "connect_timeout":
    case "joined":
      return document.getElementById("live-status");
    case "ended":
    case "unreachable":
      return document.getElementById("live-start-over");
    default:
      return null;
  }
}

import { normalizeInviteCode } from "@opensesame/app-core/lib/join/invite.js";
import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import {
  type LiveLink,
  parseLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { cleanText } from "@opensesame/app-core/lib/live/messages.js";
import {
  LIVE_SESSION_ENDED_TRAY,
  reportLiveOutcome,
} from "@opensesame/app-core/lib/live/outcome-notices.js";
import { linkRoutes } from "@opensesame/app-core/lib/live/routes.js";
import {
  currentGuestCarriers,
  joinLive,
  leaveLive,
} from "@opensesame/app-core/lib/live/session.js";
import { rememberTrustedPeer } from "@opensesame/app-core/lib/peer-trust/peers.js";
import { useEffect, useRef, useState } from "react";
import { FieldRow } from "../../components/FieldRow.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconArrowRight } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl } from "../../lib/focus.js";
import { LiveCatalog } from "./LiveCatalog.js";
import {
  JoinPersonFields,
  LiveLinkField,
  PeerTrustField,
} from "./LiveJoinFields.js";
import { RequestStep } from "./LiveJoinPairing.js";
import { CarrierMarks, RoutesChoice } from "./LiveJoinRoutes.js";
import { ConnectingProgress, standing } from "./LiveJoinStanding.js";
import { useLandWhenSettled } from "./live-focus.js";
import {
  type Standing,
  formatRemaining,
  joinDraft,
  liveUiSeams,
  useDraftField,
  useLiveGuest,
  useRemaining,
} from "./live-hooks.js";
import {
  joinAskDisabledReason,
  joinTrustFields,
  liveTrustRefusal,
} from "./live-join-trust.js";

/** A fresh request after a timed-out attempt (ADR 0186). */
const ASK_AGAIN = "Ask to join again";

/** What the joiner has typed, and the ask it adds up to. */
function useAsk(held: LiveLink | null) {
  const [pasted, setPasted] = useDraftField("pasted");
  const [code, setCode] = useDraftField("code");
  const [name, setName] = useDraftField("name");
  const [note, setNote] = useDraftField("note");
  const [peerTrust, setPeerTrust] = useDraftField("peerTrust");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useDraftField("failed");
  const [alarm, setAlarm] = useState("");
  const [useRoutes, setRoutesState] = useState(joinDraft.useRoutes);
  const setUseRoutes = (next: boolean) => {
    joinDraft.useRoutes = next;
    setRoutesState(next);
  };
  const candidate = held ?? parseLiveLink(pasted);
  const routes = candidate ? linkRoutes(candidate) : null;
  const link = routes ? candidate : null;
  const needsCode = link?.admission === "invite";
  const normalized = needsCode ? normalizeInviteCode(code) : null;
  const cleanedName = cleanText(name);
  const ready =
    link !== null &&
    cleanedName.length > 0 &&
    (!needsCode || normalized !== null);

  async function ask(): Promise<void> {
    if (!link || !ready) return;
    setBusy(true);
    setFailed("");
    try {
      const trust = await joinTrustFields(cleanText(peerTrust));
      if (trust.blocked) {
        reportLiveOutcome("Live session", trust.blocked);
        setAlarm(trust.blocked);
        setFailed(trust.blocked);
        return;
      }
      await joinLive({
        link,
        code: normalized,
        name: cleanedName,
        note: cleanText(note),
        transport: liveUiSeams.transport,
        useRoutes,
        carriers: liveUiSeams.carriers,
        peerTrustSignal: trust.peerTrustSignal,
        unverifiedManual: trust.unverifiedManual,
        rememberedPeerFingerprint: trust.rememberedPeerFingerprint,
        minimumPeerTrustEpoch: trust.minimumPeerTrustEpoch,
      });
    } catch (error) {
      leaveLive();
      const refused = error instanceof Error ? liveTrustRefusal(error) : null;
      const words = refused ?? "This browser could not make a request code";
      reportLiveOutcome("Live session", words);
      setAlarm(refused === "This peer's key changed" ? refused : "");
      setFailed(words);
    } finally {
      setBusy(false);
    }
  }

  return {
    fields: { pasted, code, name, note, peerTrust, useRoutes },
    set: {
      setPasted,
      setCode,
      setName,
      setNote,
      setPeerTrust: (next: string) => {
        setPeerTrust(next);
        setAlarm("");
        setFailed("");
      },
      setUseRoutes,
    },
    link,
    routes,
    needsCode,
    ready,
    busy,
    failed,
    alarm,
    ask,
  };
}

export function LiveJoinAskForm({ held }: { held: LiveLink | null }) {
  const {
    fields,
    set,
    link,
    routes,
    needsCode,
    ready,
    busy,
    failed,
    alarm,
    ask,
  } = useAsk(held);
  const { pasted, code, name, note, peerTrust, useRoutes } = fields;
  const { setPasted, setCode, setName, setNote, setPeerTrust, setUseRoutes } =
    set;
  const form = useRef<HTMLFormElement>(null);
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
      <PeerTrustField
        peerTrust={peerTrust}
        busy={busy}
        setPeerTrust={setPeerTrust}
      />
      {routes ? (
        <RoutesChoice
          routes={routes}
          checked={useRoutes}
          disabled={busy}
          onChange={setUseRoutes}
        />
      ) : null}
      {failed && failed !== alarm ? (
        <StatusMark tone="err" label={failed} />
      ) : null}
      {alarm ? <StatusMark tone="err" label={alarm} /> : null}
      <FormCommit
        label="Ask to join"
        disabled={!ready || busy || alarm.length > 0}
        disabledReason={joinAskDisabledReason({
          alarm,
          ready,
          busy,
          link,
          pasted,
          needsCode: needsCode ?? false,
          code,
          name,
        })}
        busy={busy}
        icon={<IconArrowRight size={18} />}
      />
    </form>
  );
}

export function LiveJoinSession() {
  const { guest, status } = useLiveGuest();
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
        <span className="vault-row__meta">
          {catalog ? formatRemaining(left) : opened.mark.tray}
        </span>
      </div>
      {opened.status.at === "request" ? (
        <RequestWaiting guest={opened.guest} status={opened.status} />
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
  return (
    <>
      <CarrierMarks rendezvous={currentGuestCarriers()} />
      {status.sas ? (
        <FieldRow label="Short authentication string">
          <span className="frow__value frow__value--mono live-sas">
            {status.sas}
          </span>
        </FieldRow>
      ) : null}
      {status.unverified ? <StatusMark tone="warn" label="Unverified" /> : null}
      <RequestStep guest={guest} code={status.code} />
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

/**
 * Join-route form, in-session view, and focus landing helpers for `/live`.
 */

import { normalizeInviteCode } from "@opensesame/app-core/lib/join/invite.js";
import { liveJoinAskDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { GuestStatus } from "@opensesame/app-core/lib/live/guest.js";
import {
  type LiveLink,
  parseLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import {
  NAME_MAX,
  NOTE_MAX,
  cleanText,
} from "@opensesame/app-core/lib/live/messages.js";
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
import { useEffect, useRef, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import {
  IconArrowRight,
  IconSecret,
  IconShare,
  IconUser,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl } from "../../lib/focus.js";
import { LiveCatalog } from "./LiveCatalog.js";
import { RequestStep } from "./LiveJoinPairing.js";
import { CarrierMarks, RoutesChoice } from "./LiveJoinRoutes.js";
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

/** The glyph and sentence for where an ask stands. */
function standing(status: GuestStatus): Standing {
  switch (status.at) {
    case "preparing":
      return {
        tone: "idle",
        label: "Making your request code",
        tray: "Making your request code",
      };
    case "request":
      return {
        tone: "idle",
        label: "Waiting for the owner's reply code",
        tray: "Waiting for the owner's reply code",
      };
    case "connecting":
      return {
        tone: "idle",
        label: "Connecting to the owner's browser",
        tray: "Connecting to the owner's browser",
      };
    case "connect_timeout":
      return {
        tone: "err",
        label: "Connection timed out",
        tray: "Connection timed out — try again or check your network",
      };
    case "joined":
      return {
        tone: "ok",
        label: `Joined ${status.catalog.title}`,
        tray: `Joined ${status.catalog.title}`,
      };
    case "unreachable":
      return {
        tone: "err",
        label: "No route to the owner's browser",
        tray: "No route to the owner's browser",
      };
    default:
      return {
        tone: "idle",
        label: "The session ended",
        tray: "The session ended",
      };
  }
}

/** What the joiner has typed, and the ask it adds up to. */
function useAsk(held: LiveLink | null) {
  const [pasted, setPasted] = useDraftField("pasted");
  const [code, setCode] = useDraftField("code");
  const [name, setName] = useDraftField("name");
  const [note, setNote] = useDraftField("note");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useDraftField("failed");
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
      await joinLive({
        link,
        code: normalized,
        name: cleanedName,
        note: cleanText(note),
        peers: liveUiSeams.peers,
        useRoutes,
        carriers: liveUiSeams.carriers,
      });
    } catch {
      leaveLive();
      const words = "This browser could not make a request code";
      reportLiveOutcome("Live session", words);
      setFailed(words);
    } finally {
      setBusy(false);
    }
  }

  return {
    fields: { pasted, code, name, note, useRoutes },
    set: { setPasted, setCode, setName, setNote, setUseRoutes },
    link,
    routes,
    needsCode,
    ready,
    busy,
    failed,
    ask,
  };
}

export function LiveJoinAskForm({ held }: { held: LiveLink | null }) {
  const { fields, set, link, routes, needsCode, ready, busy, failed, ask } =
    useAsk(held);
  const { pasted, code, name, note, useRoutes } = fields;
  const { setPasted, setCode, setName, setNote, setUseRoutes } = set;
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
        <FieldShell
          id="live-link"
          label="Link"
          type="password"
          mono
          autoComplete="off"
          lead={<IconShare size={17} />}
          value={pasted}
          disabled={busy}
          status={
            pasted && !link ? (
              <StatusMark tone="err" label="Not a live-session link" />
            ) : null
          }
          onValueChange={setPasted}
        />
      )}
      {needsCode ? (
        <FieldShell
          id="live-code"
          label="Code"
          mono
          autoComplete="off"
          placeholder="XXXX-XXXX"
          lead={<IconSecret size={17} />}
          value={code}
          disabled={busy}
          onValueChange={setCode}
        />
      ) : null}
      <FieldShell
        id="live-name"
        label="Your name"
        autoComplete="nickname"
        lead={<IconUser size={17} />}
        value={name}
        disabled={busy}
        onValueChange={(next) => setName(next.slice(0, NAME_MAX))}
      />
      <FieldShell
        id="live-note"
        label="Note"
        placeholder="Optional"
        value={note}
        disabled={busy}
        onValueChange={(next) => setNote(next.slice(0, NOTE_MAX))}
      />
      {routes ? (
        <RoutesChoice
          routes={routes}
          checked={useRoutes}
          disabled={busy}
          onChange={setUseRoutes}
        />
      ) : null}
      {failed ? <StatusMark tone="err" label={failed} /> : null}
      <FormCommit
        label="Ask to join"
        disabled={!ready || busy}
        disabledReason={
          !ready && !busy
            ? liveJoinAskDisabledReason({
                link,
                pasted,
                needsCode: needsCode ?? false,
                code,
                name,
                busy,
              })
            : undefined
        }
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
      reportLiveOutcome("Live session", "No route to the owner's browser");
    }
    if (status?.at === "ended") {
      reportLiveOutcome("Live session", mark?.tray || LIVE_SESSION_ENDED_TRAY);
    }
  }, [status, mark?.tray]);
  if (!guest || !status || !mark) return null;
  return (
    <div className="setup__stack" id="live-view">
      <div className="live-status" id="live-status" tabIndex={-1}>
        <StatusMark tone={mark.tone} label={mark.label} />
        {catalog ? (
          <span className="vault-row__meta">{formatRemaining(left)}</span>
        ) : (
          <span className="vault-row__meta">{mark.tray}</span>
        )}
      </div>
      {status.at === "request" ? (
        <>
          <CarrierMarks rendezvous={currentGuestCarriers()} />
          <RequestStep guest={guest} code={status.code} />
        </>
      ) : null}
      {status.at === "connect_timeout" ? (
        <button
          type="button"
          className="go"
          aria-label="Try connecting again"
          title="Try connecting again"
          onClick={() => void guest.retryConnect()}
        >
          <IconArrowRight size={18} />
        </button>
      ) : null}
      {catalog ? (
        <LiveCatalog
          catalog={catalog}
          request={(what, item, field) => guest.request(what, item, field)}
          save={(item, field, value) => guest.edit(item, field, value)}
        />
      ) : null}
    </div>
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

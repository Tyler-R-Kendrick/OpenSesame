import { normalizeInviteCode } from "@opensesame/app-core/lib/join/invite.js";
import {
  type LiveLink,
  parseLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { cleanText } from "@opensesame/app-core/lib/live/messages.js";
import { reportLiveOutcome } from "@opensesame/app-core/lib/live/outcome-notices.js";
import { linkRoutes } from "@opensesame/app-core/lib/live/routes.js";
import { joinLive, leaveLive } from "@opensesame/app-core/lib/live/session.js";
import { useState } from "react";
import { joinDraft, liveUiSeams, useDraftField } from "./live-hooks.js";
import { joinTrustFields, liveTrustRefusal } from "./live-join-trust.js";

/** The in-memory join draft, with device-sealing fields kept only in this mount. */
function useAskDraft() {
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
  return {
    fields: {
      pasted,
      code,
      name,
      note,
      peerTrust,
      useRoutes,
    },
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
    busy,
    failed,
    alarm,
    setBusy,
    setFailed,
    setAlarm,
  };
}

type AskFields = ReturnType<typeof useAskDraft>["fields"];

function askReadiness(held: LiveLink | null, fields: AskFields) {
  const candidate = held ?? parseLiveLink(fields.pasted);
  const routes = candidate ? linkRoutes(candidate) : null;
  const link = routes ? candidate : null;
  const needsCode = link?.admission === "invite";
  const normalized = needsCode ? normalizeInviteCode(fields.code) : null;
  const cleanedName = cleanText(fields.name);
  const ready =
    link !== null &&
    cleanedName.length > 0 &&
    (!needsCode || normalized !== null);
  return { link, routes, needsCode, normalized, cleanedName, ready };
}

/** What the joiner has typed, and the ask it adds up to. */
export function useAsk(held: LiveLink | null) {
  const draft = useAskDraft();
  const { fields, setBusy, setFailed, setAlarm } = draft;
  const readiness = askReadiness(held, fields);
  const { link, ready, normalized, cleanedName } = readiness;
  async function ask(): Promise<void> {
    if (!link || !ready) return;
    setBusy(true);
    setFailed("");
    try {
      const trust = await joinTrustFields(cleanText(fields.peerTrust));
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
        note: cleanText(fields.note),
        transport: liveUiSeams.transport,
        useRoutes: fields.useRoutes,
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

  return { ...draft, ...readiness, ask };
}

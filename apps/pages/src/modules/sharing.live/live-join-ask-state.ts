import { normalizeInviteCode } from "@opensesame/app-core/lib/join/invite.js";
import {
  type LiveLink,
  parseLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { cleanText } from "@opensesame/app-core/lib/live/messages.js";
import { reportLiveOutcome } from "@opensesame/app-core/lib/live/outcome-notices.js";
import { linkRoutes } from "@opensesame/app-core/lib/live/routes.js";
import { joinLive, leaveLive } from "@opensesame/app-core/lib/live/session.js";
import { ensureOwnerPerson } from "@opensesame/app-core/lib/local-directory-bootstrap.js";
import { pinPolicyProblems } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { useState } from "react";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { joinDraft, liveUiSeams, useDraftField } from "./live-hooks.js";
import { joinTrustFields, liveTrustRefusal } from "./live-join-trust.js";

/** The in-memory join draft, with device-sealing fields kept only in this mount. */
function useAskDraft() {
  const [pasted, setPasted] = useDraftField("pasted");
  const [code, setCode] = useDraftField("code");
  const [name, setName] = useDraftField("name");
  const [note, setNote] = useDraftField("note");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
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
      pin,
      confirm,
      accepted,
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
      setPin,
      setConfirm,
      setAccepted,
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
export type VaultStatus = "empty" | "locked" | "unlocked";

function devicePinProblem(pin: string, confirm: string): string | null {
  return pin.length === 0
    ? null
    : (pinPolicyProblems(pin)[0] ??
        (confirm.length > 0 && pin !== confirm ? "PINs do not match." : null));
}

function deviceSealProblem(
  vaultStatus: VaultStatus,
  fields: AskFields,
  pinProblem: string | null,
): string | null {
  const { pin, confirm, accepted } = fields;
  // Joining a live session never needs the local vault key. A locked vault
  // stays locked; the owner's shared catalog is the session.
  if (vaultStatus !== "empty") return null;
  if (pin.length === 0) return "Choose a PIN for your own vault.";
  if (pinProblem !== null) return pinProblem;
  if (confirm.length === 0) return "Confirm your vault PIN.";
  if (pin !== confirm) return "PINs do not match.";
  return accepted ? null : "Acknowledge that your vault cannot be recovered.";
}

function askReadiness(
  held: LiveLink | null,
  fields: AskFields,
  vaultStatus: VaultStatus,
) {
  const candidate = held ?? parseLiveLink(fields.pasted);
  const routes = candidate ? linkRoutes(candidate) : null;
  const link = routes ? candidate : null;
  const needsCode = link?.admission === "invite";
  const normalized = needsCode ? normalizeInviteCode(fields.code) : null;
  const cleanedName = cleanText(fields.name);
  const pinProblems = pinPolicyProblems(fields.pin);
  const pinProblem = devicePinProblem(fields.pin, fields.confirm);
  const sealProblem = deviceSealProblem(vaultStatus, fields, pinProblem);
  const ready =
    link !== null &&
    cleanedName.length > 0 &&
    (!needsCode || normalized !== null) &&
    sealProblem === null;
  return {
    link,
    routes,
    needsCode,
    normalized,
    cleanedName,
    pinProblems,
    pinProblem,
    sealProblem,
    ready,
  };
}

/** What the joiner has typed, and the ask it adds up to. */
export function useAsk(held: LiveLink | null, vaultStatus: VaultStatus) {
  const store = useVaultStore();
  const draft = useAskDraft();
  const { fields, setBusy, setFailed, setAlarm } = draft;
  const readiness = askReadiness(held, fields, vaultStatus);
  const { link, ready, normalized, cleanedName } = readiness;
  async function ask(): Promise<void> {
    if (!link || !ready) return;
    setBusy(true);
    setFailed("");
    try {
      if (vaultStatus === "empty") {
        await store.createWithPin(fields.pin);
        await ensureOwnerPerson(store.activeTomb(), cleanedName);
      }
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

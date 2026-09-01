/**
 * First-run join: an invite (link + code) or a request into a public session.
 *
 * Designed against `docs/design/shared-sessions/` Invite and JoinRequest.
 * Presenting an invite does not need a session; accepting it, and asking to
 * join, do — the screen says so rather than offering a dead control.
 */

import { useEffect, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconArrowRight,
  IconAuthority,
  IconCheck,
  IconLogin,
  IconSecret,
} from "../../components/Icons.js";
import type { DelegationOffer } from "../../lib/access.js";
import { currentSession, hostBase } from "../../lib/identity.js";
import {
  type ParsedInvite,
  acceptInvite,
  askToJoin,
  parseInviteInput,
  presentInvite,
} from "../../lib/join-session.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { completeSetup } from "../../lib/setup.js";
import { normalizeApiBase } from "../../lib/urls.js";

export const joinSessionDependencies = {
  presentInvite,
  acceptInvite,
  askToJoin,
  currentSession,
  hostBase,
  loadSettings,
  saveSettings,
  completeSetup,
  parseInviteInput,
};

type Mode = "invite" | "ask";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : "That did not work.";
}

function commitHost(raw: string): string {
  const next = normalizeApiBase(raw.trim()) ?? raw.trim();
  const settings = joinSessionDependencies.loadSettings();
  if (next && next !== settings.hostApi) {
    joinSessionDependencies.saveSettings({ ...settings, hostApi: next });
  }
  return next;
}

export function JoinSession({
  initial,
  onDone,
}: {
  initial: ParsedInvite | null;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("invite");
  const [host, setHost] = useState(
    () => initial?.host ?? joinSessionDependencies.hostBase(),
  );
  const [invite, setInvite] = useState(initial?.token ?? "");
  const [code, setCode] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [note, setNote] = useState("");
  const [offer, setOffer] = useState<DelegationOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const signedIn = joinSessionDependencies.currentSession() !== null;

  useEffect(() => {
    if (!initial?.token) return;
    setInvite(initial.token);
    if (initial.host) setHost(initial.host);
  }, [initial]);

  const verb = (() => {
    if (busy) return "Working…";
    if (mode === "ask") return "Ask to join";
    if (offer) return signedIn ? "Accept" : "Sign in to accept";
    return "Look it up";
  })();

  async function finishJoin() {
    await joinSessionDependencies.completeSetup({
      ways: [],
      service: false,
      joined: true,
    });
    onDone();
  }

  async function onCommit() {
    setError(null);
    setPending(null);
    setBusy(true);
    try {
      if (mode === "ask") {
        const pointed = commitHost(host);
        if (!pointed) {
          throw new Error("Joining needs a Host. Paste its address.");
        }
        const receipt = await joinSessionDependencies.askToJoin(
          sessionId,
          note,
        );
        setPending(
          receipt.decision === "pending"
            ? "Asked. You are not in yet — the operator decides what you get."
            : `The Host answered: ${receipt.decision}.`,
        );
        await finishJoin();
        return;
      }

      const parsed = joinSessionDependencies.parseInviteInput(invite);
      const token = parsed?.token ?? invite.trim();
      const pointed = commitHost(parsed?.host ?? host);
      if (!pointed) {
        throw new Error("Joining needs a Host. Paste its address.");
      }
      if (parsed?.host) setHost(parsed.host);

      if (!offer) {
        const found = await joinSessionDependencies.presentInvite(
          pointed,
          token,
        );
        setOffer(found);
        return;
      }

      if (!signedIn) {
        await finishJoin();
        return;
      }

      await joinSessionDependencies.acceptInvite({
        claimToken: token,
        userCode: code,
        acceptedItemIds: offer.items.map((item) => item.id),
      });
      await finishJoin();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const blocked =
    busy ||
    (mode === "ask"
      ? !sessionId.trim() || !host.trim()
      : !invite.trim() ||
        !host.trim() ||
        (Boolean(offer) && signedIn && !code.trim()));

  return (
    <>
      <main className="setup__body" id="main">
        <div className="setup__head">
          <h1>{mode === "ask" ? "Ask to join" : "Join a session"}</h1>
          <p>
            {mode === "ask"
              ? "A public session advertises a name, never its contents. Asking does not connect you to anyone until an operator lets you in."
              : "The link alone opens nothing — type the code they read to you, or sent some other way."}
          </p>
        </div>

        <div className="preset" role="tablist" aria-label="How you get in">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "invite"}
            className={mode === "invite" ? "preset__opt is-on" : "preset__opt"}
            onClick={() => {
              setMode("invite");
              setError(null);
            }}
          >
            <span className="preset__name">I have an invite</span>
            <span className="preset__kind">link and a code</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "ask"}
            className={mode === "ask" ? "preset__opt is-on" : "preset__opt"}
            onClick={() => {
              setMode("ask");
              setError(null);
            }}
          >
            <span className="preset__name">Ask to join</span>
            <span className="preset__kind">a public session</span>
          </button>
        </div>

        <FieldShell
          id="join-host"
          label="Host"
          type="url"
          mono
          lead={<IconAuthority size={17} />}
          placeholder="https://host.example"
          value={host}
          disabled={busy}
          onValueChange={(next) => {
            setHost(next);
            setError(null);
          }}
          onCommit={commitHost}
          hint="Sharing needs a Host. The invite's origin is used when the paste is a link."
        />

        {mode === "invite" ? (
          <>
            <FieldShell
              id="join-invite"
              label="Invite"
              type="text"
              mono
              lead={<IconSecret size={17} />}
              placeholder="Link or token"
              value={invite}
              disabled={busy || Boolean(offer)}
              onValueChange={(next) => {
                setInvite(next);
                setOffer(null);
                setError(null);
                const parsed = joinSessionDependencies.parseInviteInput(next);
                if (parsed?.host) setHost(parsed.host);
              }}
              hint="Paste the link they sent, or the token from it."
            />
            <FieldShell
              id="join-code"
              label="Code"
              type="text"
              mono
              lead={<IconLogin size={17} />}
              placeholder="FKM 2RD"
              value={code}
              disabled={busy}
              onValueChange={(next) => {
                setCode(next);
                setError(null);
              }}
              hint="Six characters, from whoever sent you here. The link without it opens nothing."
            />
          </>
        ) : (
          <>
            <FieldShell
              id="join-session"
              label="Session"
              type="text"
              mono
              lead={<IconAuthority size={17} />}
              placeholder="Session id"
              value={sessionId}
              disabled={busy}
              onValueChange={(next) => {
                setSessionId(next);
                setError(null);
              }}
              hint="The public name's id. Private sessions are not listed, and guessing them answers the same as nothing."
            />
            <FieldShell
              id="join-note"
              label="Why you need in"
              type="text"
              value={note}
              disabled={busy}
              onValueChange={(next) => {
                setNote(next);
                setError(null);
              }}
              hint="The operator sees this and your account. Nothing else about you is sent."
            />
          </>
        )}

        {offer ? (
          <div className="found">
            <div className="found__top">
              <span className="found__name">
                {offer.items.length === 1
                  ? offer.items[0]?.displayName || "One grant"
                  : `${offer.items.length} grants`}
              </span>
              <span className="chip chip--ok">ready</span>
            </div>
            <dl>
              <dt>You would get</dt>
              <dd>
                {offer.items.map((item) => item.displayName).join(", ") ||
                  "what they offered"}
              </dd>
              <dt>Until</dt>
              <dd>{offer.expiresAt || "it lapses on its own"}</dd>
            </dl>
          </div>
        ) : null}

        {pending ? <output className="note note--ok">{pending}</output> : null}

        {error ? <output className="note note--err">{error}</output> : null}

        {!signedIn && (offer || mode === "ask") ? (
          <p className="hint">
            {mode === "ask"
              ? "Asking names you, so sign-in comes next. The request is not sent until you have an account."
              : "Accepting wraps the grant for your account alone. Sign in on the next screen, then this invite is waiting."}
          </p>
        ) : null}
      </main>

      <div className="setup__foot">
        <div className="go-row">
          <button
            type="button"
            className="go"
            disabled={blocked}
            aria-busy={busy}
            aria-label={verb}
            title={verb}
            onClick={() => void onCommit()}
          >
            {offer && signedIn ? (
              <IconCheck size={18} />
            ) : (
              <IconArrowRight size={18} />
            )}
          </button>
          <span className="go-verb" aria-hidden="true">
            {verb}
          </span>
        </div>
      </div>
    </>
  );
}

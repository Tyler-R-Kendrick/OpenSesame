import { briefOrigin } from "@opensesame/os-domain";
import { useState } from "react";

import type { ConnectorStatus } from "../lib/connectors.js";
import { defaultUpstream } from "../lib/federation.js";
import { beginSignIn } from "../lib/federation.js";
import { claimGuestAuth } from "../lib/guest-auth.js";
import {
  adoptToken,
  clearSession,
  identityBase,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { type CeremonyAlt, CeremonyShell } from "./CeremonyShell.js";
import { FieldShell } from "./FieldShell.js";
import { IconTerminal, IconUser } from "./Icons.js";
import { StatusNote } from "./StatusNote.js";

export const identityCeremonyDependencies = {
  useConnect,
  useIdentitySession,
  beginSignIn,
  defaultUpstream,
  claimGuestAuth,
  adoptToken,
  clearSession,
  identityBase,
};

type Flash = { tone: "ok" | "warn" | "err"; text: string } | null;

/**
 * How long this credential has left, in words.
 *
 * A pasted CLI token has no stated horizon — only the API knows it — and
 * inventing one would be worse than saying so: a countdown that is a guess
 * gets believed exactly as much as one that is not.
 */
export function expiryPhrase(
  expiresAt: string | undefined,
  now: number,
): string {
  if (!expiresAt) return "not stated";
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return "not stated";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 90) return `in ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

/**
 * The Identity ceremony.
 *
 * Signing in was already real here. What was missing is everything around it:
 * the sheet never said *which* principal you were, who issued the credential
 * or when it lapses — so a signed-in Identity glyph opened onto a page whose
 * only content was two buttons offering to sign in again.
 */
export function IdentityCeremony({
  connector,
  onClose,
}: {
  connector: ConnectorStatus;
  onClose: () => void;
}) {
  const session = identityCeremonyDependencies.useIdentitySession();
  const { connect, connecting, error } =
    identityCeremonyDependencies.useConnect();
  const upstream = identityCeremonyDependencies.defaultUpstream();
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<"guest" | "refresh" | null>(null);

  const issuer = briefOrigin(
    session?.issuerOrigin ?? identityCeremonyDependencies.identityBase(),
  );

  function refresh() {
    setBusy("refresh");
    setFlash(null);
    void (async () => {
      try {
        // Drop the credential first: `ensureIdentitySession` reuses a live one,
        // so refreshing without clearing would be a no-op that reports success.
        identityCeremonyDependencies.clearSession();
        await connect();
        setFlash({ tone: "ok", text: "Session refreshed." });
      } catch (caught) {
        setFlash({
          tone: "err",
          text: caught instanceof Error ? caught.message : "Refresh failed.",
        });
      } finally {
        setBusy(null);
      }
    })();
  }

  function startGuest() {
    setBusy("guest");
    setFlash(null);
    void (async () => {
      try {
        await connect();
        await identityCeremonyDependencies.claimGuestAuth();
        onClose();
      } catch (caught) {
        setFlash({
          tone: "err",
          text:
            caught instanceof Error ? caught.message : "Guest login failed.",
        });
      } finally {
        setBusy(null);
      }
    })();
  }

  const alts: CeremonyAlt[] = [
    // Only meaningful with a session to replace. Signed out, the two front
    // doors are both promoted into the card instead of hidden a click deep.
    ...(session
      ? [
          {
            id: "someone-else",
            label: "Sign in as someone else",
            icon: <IconUser size={18} />,
            render: () => (
              <>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      identityCeremonyDependencies.clearSession();
                      void identityCeremonyDependencies.beginSignIn(upstream);
                    }}
                  >
                    Sign in with {upstream.accountKind}
                  </button>
                </div>
              </>
            ),
          },
        ]
      : []),
    {
      id: "cli-token",
      label: "Use a token from the CLI",
      icon: <IconTerminal size={18} />,
      render: () => <AdoptTokenPanel onDone={setFlash} />,
    },
  ];

  return (
    <>
      <CeremonyShell
        ok={connector.tone === "live"}
        top={session ? "Session active" : "No session"}
        name={session?.principalId ?? "Not signed in"}
        facts={[
          { key: "Issuer", value: issuer || "not configured" },
          {
            key: "Expires",
            value: session ? expiryPhrase(session.expiresAt, Date.now()) : "—",
          },
        ]}
        primary={
          session
            ? {
                label: busy === "refresh" ? "Refreshing…" : "Refresh session",
                onClick: refresh,
                busy: busy === "refresh",
              }
            : {
                label: `Sign in with ${upstream.accountKind}`,
                onClick: () => {
                  void identityCeremonyDependencies.beginSignIn(upstream);
                },
                disabled: connecting || busy !== null,
              }
        }
        secondary={
          session
            ? undefined
            : {
                label:
                  busy === "guest" ? "Starting guest…" : "Continue as guest",
                busy: busy === "guest",
                disabled: connecting,
                onClick: startGuest,
              }
        }
        alts={alts}
      />
      {error ? <StatusNote message={{ tone: "warn", text: error }} /> : null}
      {flash ? <StatusNote message={flash} /> : null}
    </>
  );
}

/** `opensesame login` prints a bearer; this adopts it without a round trip. */
function AdoptTokenPanel({ onDone }: { onDone: (flash: Flash) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <>
      <FieldShell
        id="ceremony-adopt-token"
        label="Access token"
        type="password"
        mono
        autoComplete="off"
        lead={<IconTerminal size={17} />}
        placeholder="paste the bearer printed by opensesame login"
        value={token}
        onValueChange={setToken}
        hint="Held in this tab only. No cookie is sent alongside it."
      />
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || token.trim() === ""}
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            void (async () => {
              try {
                await identityCeremonyDependencies.adoptToken(token.trim());
                setToken("");
                onDone({ tone: "ok", text: "Token adopted." });
              } catch (caught) {
                onDone({
                  tone: "err",
                  text:
                    caught instanceof Error
                      ? caught.message
                      : "That token was not accepted.",
                });
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? "Adopting…" : "Use this token"}
        </button>
      </div>
    </>
  );
}

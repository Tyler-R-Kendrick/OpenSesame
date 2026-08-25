import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient } from "./api-client";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  parseSealedStore,
  persistSealedStore,
} from "./client-core";
import { type Session, createOpenSesame } from "./sdk-browser";

const hostApi = import.meta.env.VITE_HOST_API ?? "http://127.0.0.1:8787";
const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

function statusLabel(value: boolean | null, up: string, down: string): string {
  if (value === null) return "Checking…";
  return value ? up : down;
}

export function App() {
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [daemonOk, setDaemonOk] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState(() => createCursor("pwa-device"));
  const [persistOk, setPersistOk] = useState<string>("Checking…");
  const [persistErr, setPersistErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityErr, setIdentityErr] = useState<string | null>(null);

  const sesame = useMemo(
    () => createOpenSesame({ issuer, clientId: "opensesame-pwa" }),
    [],
  );

  useEffect(() => {
    void sesame.getSession().then(setSession);
  }, [sesame]);

  const signIn = useCallback(async () => {
    setIdentityBusy(true);
    setIdentityErr(null);
    try {
      // Sends the browser to the hosted login page, which runs whichever
      // upstream this deployment brokers and comes back to this origin.
      await sesame.signIn({ returnTo: "/" });
    } catch (e) {
      setIdentityErr(
        e instanceof Error
          ? e.message
          : "Could not start sign-in. Is the Identity API up?",
      );
      setIdentityBusy(false);
    }
  }, [sesame]);

  const continueAsGuest = useCallback(async () => {
    setIdentityBusy(true);
    setIdentityErr(null);
    try {
      // A provisional principal is the default on-ramp: no account needed.
      // Claiming later (linking an identity) keeps the same principal id.
      setSession(await sesame.continueAnonymously());
    } catch (e) {
      setIdentityErr(
        e instanceof Error
          ? e.message
          : "Could not start a guest session. Is the Identity API up?",
      );
    } finally {
      setIdentityBusy(false);
    }
  }, [sesame]);

  const signOut = useCallback(async () => {
    setIdentityBusy(true);
    setIdentityErr(null);
    try {
      await sesame.signOut();
      setSession(null);
    } finally {
      setIdentityBusy(false);
    }
  }, [sesame]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setHostOk(null);
    setDaemonOk(null);
    let client: ReturnType<typeof createApiClient>;
    try {
      // A build pointed somewhere this client will not send a bearer says so once,
      // rather than failing every call with a network error.
      client = createApiClient({ baseUrl: hostApi });
    } catch (e) {
      setHostOk(false);
      setPersistErr(true);
      setPersistOk(e instanceof Error ? e.message : "Host API misconfigured");
      setBusy(false);
      return;
    }
    try {
      const h = await client.health();
      setHostOk(h.ok);
      const d = await client.probeDaemon();
      setDaemonOk(d.available);
    } catch {
      // A network/CORS failure means unreachable, not "up": surface it instead
      // of leaking an unhandled rejection and sticking on "Checking…".
      setHostOk(false);
      setDaemonOk(false);
      setBusy(false);
      return;
    }
    const existing = await loadSealedStore(cursor.deviceId);
    const sealed =
      existing ??
      JSON.stringify({
        cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
        blobs: [],
      });
    try {
      assertNoPlaintextInSealedJson(sealed);
      await persistSealedStore(cursor.deviceId, sealed);
      setPersistOk("Sealed local store ready");
      setPersistErr(false);
      if (existing) {
        // Validated by the sealed-store schema, not by hand: this device id ends
        // up as a file name and as the identity this client syncs under.
        const parsed = parseSealedStore(existing);
        if (parsed) {
          setCursor({
            deviceId: parsed.cursor.device_id,
            epoch: parsed.cursor.epoch,
          });
        }
      }
    } catch (e) {
      setPersistErr(true);
      setPersistOk(
        e instanceof Error ? e.message : "Could not prepare local store",
      );
    }
    setBusy(false);
  }, [cursor.deviceId, cursor.epoch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main className="shell">
      <p className="brand">OpenSesame</p>
      <h1>Client PWA</h1>
      <p className="lede">
        Health for the Host API and optional local daemon, plus sealed OPFS sync
        persistence. This surface never shows raw credentials.
      </p>
      <section className="identity" aria-label="Identity">
        <h2>Identity</h2>
        {session ? (
          <output>
            {session.anonymous
              ? `Guest session active (${session.sub ?? "provisional principal"}). `
              : `Signed in as ${session.sub ?? "unknown"}. `}
            {session.anonymous
              ? "This session is provisional — claim it later in the console to keep the same principal id."
              : null}
          </output>
        ) : (
          <p>
            No session. Continue as a guest — no account needed. Claiming later
            attaches ownership without changing any ids.
          </p>
        )}
        <div className="actions">
          {session ? (
            <button
              type="button"
              disabled={identityBusy}
              aria-busy={identityBusy}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={identityBusy}
                aria-busy={identityBusy}
                onClick={() => void signIn()}
              >
                Sign in
              </button>
              <button
                type="button"
                disabled={identityBusy}
                aria-busy={identityBusy}
                onClick={() => void continueAsGuest()}
              >
                {identityBusy ? "Starting…" : "Continue as guest"}
              </button>
            </>
          )}
        </div>
        {identityErr ? (
          <p className="err" role="alert">
            {identityErr}
          </p>
        ) : null}
      </section>
      <ul className="status" aria-live="polite" aria-busy={busy}>
        <li className={hostOk === false ? "is-down" : hostOk ? "is-up" : ""}>
          <span className="label">Host API</span>
          <span className="value">
            {hostApi} — {statusLabel(hostOk, "up", "down")}
          </span>
        </li>
        <li className={daemonOk ? "is-up" : ""}>
          <span className="label">Daemon</span>
          <span className="value">
            {statusLabel(daemonOk, "available", "unavailable (optional)")}
          </span>
        </li>
        <li>
          <span className="label">Sync cursor</span>
          <span className="value">
            {cursor.deviceId} @ epoch {cursor.epoch}
          </span>
        </li>
        <li
          className={
            persistErr ? "is-down" : persistOk.includes("ready") ? "is-up" : ""
          }
        >
          <span className="label">Local store</span>
          <span className="value">{persistOk}</span>
        </li>
      </ul>
      {hostOk === false ? (
        <output className="hint">
          Host API is unreachable. Start the gateway on {hostApi}, then retry.
        </output>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void refresh()}
        >
          {busy ? "Checking…" : "Retry health check"}
        </button>
      </div>
    </main>
  );
}

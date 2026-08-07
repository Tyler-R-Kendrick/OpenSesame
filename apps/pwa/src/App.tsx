import { useCallback, useEffect, useState } from "react";
import { createApiClient } from "@opensesame/api-client";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  persistSealedStore,
} from "@opensesame/client-core";

const hostApi = import.meta.env.VITE_HOST_API ?? "http://127.0.0.1:8787";

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

  const refresh = useCallback(async () => {
    setBusy(true);
    setHostOk(null);
    setDaemonOk(null);
    const client = createApiClient({ baseUrl: hostApi });
    try {
      const h = await client.health();
      setHostOk(h.ok);
      const d = await client.probeDaemon();
      setDaemonOk(d.available);

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
          const parsed = JSON.parse(existing) as {
            cursor?: { device_id?: string; epoch?: number };
          };
          if (parsed.cursor?.device_id) {
            setCursor({
              deviceId: parsed.cursor.device_id,
              epoch: parsed.cursor.epoch ?? 0,
            });
          }
        }
      } catch (e) {
        setPersistErr(true);
        setPersistOk(
          e instanceof Error ? e.message : "Could not prepare local store",
        );
      }
    } finally {
      setBusy(false);
    }
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
        <li className={persistErr ? "is-down" : persistOk.includes("ready") ? "is-up" : ""}>
          <span className="label">Local store</span>
          <span className="value">{persistOk}</span>
        </li>
      </ul>
      {hostOk === false ? (
        <p className="hint" role="status">
          Host API is unreachable. Start the gateway on {hostApi}, then retry.
        </p>
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

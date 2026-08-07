import { useEffect, useState } from "react";
import { createApiClient } from "@opensesame/api-client";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  persistSealedStore,
} from "@opensesame/client-core";

const hostApi = import.meta.env.VITE_HOST_API ?? "http://127.0.0.1:8787";

export function App() {
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [daemonOk, setDaemonOk] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState(() => createCursor("pwa-device"));
  const [persistOk, setPersistOk] = useState<string>("…");

  useEffect(() => {
    const client = createApiClient({ baseUrl: hostApi });
    void (async () => {
      const h = await client.health();
      setHostOk(h.ok);
      const d = await client.probeDaemon();
      setDaemonOk(d.available);

      const existing = await loadSealedStore(cursor.deviceId);
      const sealed = existing ?? JSON.stringify({
        cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
        blobs: [],
      });
      try {
        assertNoPlaintextInSealedJson(sealed);
        await persistSealedStore(cursor.deviceId, sealed);
        setPersistOk("OPFS/local sealed store ready");
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
        setPersistOk(`persist error: ${e instanceof Error ? e.message : e}`);
      }
    })();
  }, [cursor.deviceId, cursor.epoch]);

  return (
    <main className="shell">
      <p className="brand">OpenSesame</p>
      <h1>Client PWA</h1>
      <p className="lede">
        Uses api-client against the Host API and client-core sealed sync persistence. Optionally
        connects to the local daemon.
      </p>
      <ul className="status">
        <li>Host API ({hostApi}): {hostOk === null ? "…" : hostOk ? "up" : "down"}</li>
        <li>Daemon: {daemonOk === null ? "…" : daemonOk ? "available" : "unavailable (ok)"}</li>
        <li>
          Sync cursor: {cursor.deviceId} @ epoch {cursor.epoch}
        </li>
        <li>Local store: {persistOk}</li>
      </ul>
    </main>
  );
}

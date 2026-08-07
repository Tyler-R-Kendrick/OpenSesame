import { useEffect, useState } from "react";
import { createApiClient } from "@opensesame/api-client";
import { createCursor } from "@opensesame/client-core";

const hostApi = import.meta.env.VITE_HOST_API ?? "http://127.0.0.1:8787";

export function App() {
  const [hostOk, setHostOk] = useState<boolean | null>(null);
  const [daemonOk, setDaemonOk] = useState<boolean | null>(null);
  const [cursor] = useState(() => createCursor("pwa-device"));

  useEffect(() => {
    const client = createApiClient({ baseUrl: hostApi });
    void (async () => {
      const h = await client.health();
      setHostOk(h.ok);
      const d = await client.probeDaemon();
      setDaemonOk(d.available);
    })();
  }, []);

  return (
    <main className="shell">
      <p className="brand">OpenSesame</p>
      <h1>Client PWA</h1>
      <p className="lede">
        Uses api-client against the Host API. Optionally connects to the local daemon.
      </p>
      <ul className="status">
        <li>Host API ({hostApi}): {hostOk === null ? "…" : hostOk ? "up" : "down"}</li>
        <li>Daemon: {daemonOk === null ? "…" : daemonOk ? "available" : "unavailable (ok)"}</li>
        <li>
          Sync cursor: {cursor.deviceId} @ epoch {cursor.epoch}
        </li>
      </ul>
    </main>
  );
}

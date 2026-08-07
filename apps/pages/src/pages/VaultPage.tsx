import { useEffect, useState } from "react";
import {
  assertNoPlaintextInSealedJson,
  createCursor,
  loadSealedStore,
  persistSealedStore,
} from "@opensesame/client-core";

export function VaultPage() {
  const [cursor, setCursor] = useState(() => createCursor("pages-device"));
  const [status, setStatus] = useState("Preparing sealed store…");
  const [kind, setKind] = useState<"info" | "ok" | "err">("info");
  const [busy, setBusy] = useState(false);

  async function ensureStore() {
    setBusy(true);
    setKind("info");
    setStatus("Writing sealed sync envelope…");
    try {
      const existing = await loadSealedStore(cursor.deviceId);
      const sealed =
        existing ??
        JSON.stringify({
          cursor: { device_id: cursor.deviceId, epoch: cursor.epoch },
          blobs: [],
        });
      assertNoPlaintextInSealedJson(sealed);
      await persistSealedStore(cursor.deviceId, sealed);
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
      setKind("ok");
      setStatus("Sealed store ready. Ciphertext only — no plaintext vault JSON.");
    } catch (e) {
      setKind("err");
      setStatus(e instanceof Error ? e.message : "Vault preparation failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void ensureStore();
  }, []);

  return (
    <section className="panel">
      <h1>Vault</h1>
      <p>
        Local sealed sync persistence via client-core. Prefer OPFS; fall back to
        in-memory when the browser blocks storage. Never uses localStorage for
        sealed payloads.
      </p>
      <ul className="status-list">
        <li>
          <span className="k">Device id</span>
          <span className="v">{cursor.deviceId}</span>
        </li>
        <li>
          <span className="k">Epoch</span>
          <span className="v">{cursor.epoch}</span>
        </li>
      </ul>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void ensureStore()}
        >
          {busy ? "Sealing…" : "Refresh sealed store"}
        </button>
      </div>
      <p
        className={kind === "ok" ? "ok" : kind === "err" ? "err" : "lede"}
        role={kind === "err" ? "alert" : "status"}
      >
        {status}
      </p>
    </section>
  );
}

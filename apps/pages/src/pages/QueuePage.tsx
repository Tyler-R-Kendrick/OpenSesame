import { useEffect, useState } from "react";
import {
  dequeue,
  loadQueue,
  type QueuedAction,
} from "../lib/queue.js";
import { loadSettings } from "../lib/settings.js";
import { createOpenSesame } from "@opensesame/sdk-browser";

export function QueuePage({ online }: { online: boolean }) {
  const [items, setItems] = useState<QueuedAction[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    setItems(loadQueue());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function flush() {
    if (!online) {
      setError("Go online to flush the outbox.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    const { identityApi } = loadSettings();
    const base = identityApi.replace(/\/$/, "");
    let done = 0;
    try {
      for (const item of loadQueue()) {
        if (item.kind === "device_approve") {
          const res = await fetch(`${base}/v1/device/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ user_code: item.userCode }),
          });
          if (!res.ok) {
            throw new Error(`device_approve failed (${res.status}) for ${item.userCode}`);
          }
        } else {
          const sesame = createOpenSesame({ issuer: identityApi });
          const claim = await sesame.presentClaim(item.claimToken);
          await sesame.completeClaim(claim.id, { acceptedItemIds: ["*"] });
        }
        dequeue(item.id);
        done += 1;
      }
      setStatus(`Flushed ${done} queued action(s).`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h1>Offline queue</h1>
      <p>
        Ceremony intents staged while offline. No secrets — only user codes and
        claim token references you already pasted.
      </p>
      {items.length === 0 ? (
        <p className="hint" role="status">
          Queue is empty.
        </p>
      ) : (
        <ul className="status-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="k">{item.kind}</span>
              <span className="v">
                {item.kind === "device_approve"
                  ? item.userCode
                  : `claim token …${item.claimToken.slice(-8)}`}{" "}
                · {new Date(item.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!online || busy || items.length === 0}
          aria-busy={busy}
          onClick={() => void flush()}
        >
          {busy ? "Flushing…" : "Flush queue"}
        </button>
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>
      {status ? (
        <p className="ok" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

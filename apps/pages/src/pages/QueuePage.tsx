import { createOpenSesame } from "@opensesame/sdk-browser";
import { useEffect, useState } from "react";
import {
  type QueuedAction,
  claimTokenLabel,
  dequeue,
  loadQueue,
  recordAttempt,
} from "../lib/queue.js";
import { loadSettings } from "../lib/settings.js";
import { credentialsFor } from "../lib/urls.js";

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
    let failed = 0;
    let firstError: string | null = null;
    for (const item of loadQueue()) {
      try {
        if (item.kind === "device_approve") {
          const res = await fetch(`${base}/v1/device/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: credentialsFor(base),
            body: JSON.stringify({ user_code: item.userCode }),
          });
          if (!res.ok) {
            throw new Error(
              `device_approve failed (${res.status}) for ${item.userCode}`,
            );
          }
        } else {
          const sesame = createOpenSesame({ issuer: identityApi });
          const claim = await sesame.presentClaim(item.claimToken);
          await sesame.completeClaim(claim.id, { acceptedItemIds: ["*"] });
        }
        dequeue(item.id);
        done += 1;
      } catch (e) {
        // One item that cannot succeed must not hold the rest of the outbox
        // hostage; it counts its attempts and eventually drops itself.
        recordAttempt(item.id);
        failed += 1;
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    }
    setStatus(`Flushed ${done} queued action(s).`);
    if (firstError)
      setError(failed > 1 ? `${firstError} (${failed} failed)` : firstError);
    refresh();
    setBusy(false);
  }

  return (
    <section className="panel">
      <h1>Offline queue</h1>
      <p>
        Ceremony intents staged while offline. A queued claim carries its token,
        so the queue is cleared as it flushes and entries expire after a day.
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
                  : claimTokenLabel(item.claimToken)}{" "}
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

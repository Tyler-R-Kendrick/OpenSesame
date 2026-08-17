import { useCallback, useEffect, useState } from "react";
import {
  deleteSyncTarget,
  formatSyncTargetSummary,
  listSyncTargets,
  syncTarget,
  type SyncTarget,
} from "../../lib/sync-targets.js";
import {
  ensureHostSession,
  hostLocalSessionEligible,
  useIdentitySession,
} from "../../lib/identity.js";
import { useOnline } from "../../lib/use-online.js";
import { IconAlert, IconCheck } from "../../components/Icons.js";

type Flash = { tone: "ok" | "err" | "warn"; text: string };

/**
 * Lists Host sync targets and triggers fan-out sync.
 * Never renders secret values — status metadata only (WP-C).
 */
export function SyncTargetsPanel() {
  const online = useOnline();
  const session = useIdentitySession();
  const [targets, setTargets] = useState<SyncTarget[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setFlash(null);
    try {
      if (hostLocalSessionEligible() || session) {
        await ensureHostSession().catch(() => undefined);
      }
      const next = await listSyncTargets();
      setTargets(next);
    } catch (error) {
      setFlash({
        tone: "err",
        text:
          error instanceof Error
            ? error.message
            : "Could not load sync targets",
      });
    } finally {
      setLoading(false);
    }
  }, [online, session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSync(target: SyncTarget) {
    setBusyId(target.id);
    setFlash(null);
    try {
      const outcome = await syncTarget(target.id);
      setTargets((prev) =>
        prev.map((row) => (row.id === outcome.target.id ? outcome.target : row)),
      );
      setFlash({
        tone: outcome.ok ? "ok" : "err",
        text: outcome.ok
          ? `Synced ${outcome.target.providerId} (${outcome.keysSynced} keys)`
          : (outcome.error ?? "Sync failed"),
      });
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Sync failed",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(target: SyncTarget) {
    setBusyId(target.id);
    setFlash(null);
    try {
      await deleteSyncTarget(target.id);
      setTargets((prev) => prev.filter((row) => row.id !== target.id));
      setFlash({ tone: "ok", text: "Sync target removed" });
    } catch (error) {
      setFlash({
        tone: "err",
        text: error instanceof Error ? error.message : "Delete failed",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="sync-targets-heading">
      <div className="panel__head">
        <div>
          <h2 id="sync-targets-heading">Sync targets</h2>
          <p>
            Fan-out project configs to PaaS connectors (Vercel, Railway) through
            Host ConnectionRef invoke. Secret values never appear here.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={!online || loading}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>

      {!online ? (
        <p className="note note--warn" role="status">
          <IconAlert /> Offline — sync requires Host.
        </p>
      ) : null}

      {flash ? (
        <p
          className={`note note--${flash.tone === "ok" ? "ok" : flash.tone === "warn" ? "warn" : "err"}`}
          role={flash.tone === "err" ? "alert" : "status"}
        >
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <span>{flash.text}</span>
        </p>
      ) : null}

      {targets.length === 0 && !loading ? (
        <p className="hint">
          No sync targets yet. Create them via Host API against an active
          Vercel or Railway connection (
          <code>POST /api/v1/sync-targets</code>).
        </p>
      ) : (
        <ul className="list">
          {targets.map((target) => (
            <li key={target.id} className="list__row">
              <div>
                <strong>{formatSyncTargetSummary(target)}</strong>
                <p className="hint">
                  config <code>{target.configId}</code>
                  {target.lastSyncedAt
                    ? ` · last ${target.lastSyncedAt}`
                    : null}
                </p>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busyId === target.id || !online}
                  onClick={() => void onSync(target)}
                >
                  {busyId === target.id ? "Syncing…" : "Sync"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busyId === target.id}
                  onClick={() => void onDelete(target)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

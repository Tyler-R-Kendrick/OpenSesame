import { useCallback, useEffect, useState } from "react";
import {
  formatChangelogSummary,
  listChangelog,
  type ChangelogEvent,
} from "../../lib/changelog.js";
import { useIdentitySession } from "../../lib/identity.js";
import { loadSettings } from "../../lib/settings.js";

type Flash = { tone: "ok" | "err"; text: string };

/**
 * Read-only secret/config change history.
 *
 * Shows metadata events (config ids, key names, sync target status) — never
 * secret values. Prefer Host project changelog; Identity audit is a fallback.
 */
export function ChangelogPanel() {
  const session = useIdentitySession();
  const [projectId, setProjectId] = useState(
    () => loadSettings().activeProjectId?.trim() ?? "",
  );
  const [events, setEvents] = useState<ChangelogEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setFlash(null);
    try {
      const rows = await listChangelog({
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        limit: 50,
      });
      setEvents(rows);
      setFlash({
        tone: "ok",
        text:
          rows.length === 0
            ? "No changelog events yet."
            : `Loaded ${rows.length} metadata event${rows.length === 1 ? "" : "s"}.`,
      });
    } catch (caught) {
      setEvents([]);
      setFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? caught.message
            : "Could not load changelog.",
      });
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    const active = loadSettings().activeProjectId?.trim();
    if (active && !projectId) setProjectId(active);
  }, [projectId]);

  return (
    <section className="panel" id="changelog">
      <div className="panel__head">
        <div>
          <h2>Change log</h2>
          <p>
            Durable secret/config history for a project — key names, versions,
            and sync outcomes only. Values stay out of the audit trail; sealed
            store git history remains local ciphertext history.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {!session ? (
          <p className="note">
            Connect an identity session to load changelog events.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Project id</span>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="project_…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? "Loading…" : "Refresh"}
              </button>
            </div>
            {flash ? (
              <p
                className={`note note--${flash.tone}`}
                role={flash.tone === "err" ? "alert" : "status"}
              >
                <span>{flash.text}</span>
              </p>
            ) : null}
            {events.length > 0 ? (
              <ul className="list">
                {events.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{formatChangelogSummary(event)}</strong>
                      <div className="muted">
                        {event.occurredAt}
                        {event.actorId ? ` · ${event.actorId}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Access › Sessions — Host shared sessions (ADR 0079).
 *
 * Opens a Host session and selects one to manage. Grant / join / revoke live
 * in `HostSessionManage.tsx`. Offline vault-share sessions stay beside this
 * panel for deployments with no Host.
 */

import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconRefresh } from "../../components/Icons.js";
import {
  type HostSessionBookmark,
  forgetHostSession,
  listHostSessionBookmarks,
  rememberHostSession,
} from "../../lib/host-shared-session-store.js";
import {
  type JoinRequestRow,
  type SessionVisibility,
  type SharedSessionDetail,
  getSharedSession,
  listJoinRequests,
  openSharedSession,
} from "../../lib/shared-sessions.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { HostSessionManage } from "./HostSessionManage.js";

function errorText(caught: Error): string {
  return caught.message || "Host session request failed.";
}

export function HostSharedSessionsPanel({ tomb }: { tomb: string }) {
  const [bookmarks, setBookmarks] = useState<HostSessionBookmark[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SharedSessionDetail | null>(null);
  const [requests, setRequests] = useState<JoinRequestRow[]>([]);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = useVaultStore()
    .getSnapshot()
    .items.filter((item) => item.deletedAt === null);

  const reloadBookmarks = useCallback(() => {
    void listHostSessionBookmarks(tomb)
      .then(setBookmarks)
      .catch(() => setBookmarks([]));
  }, [tomb]);

  const reloadSelected = useCallback(async (sessionId: string) => {
    const next = await getSharedSession(sessionId);
    setDetail(next);
    try {
      setRequests(await listJoinRequests(sessionId));
    } catch {
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    reloadBookmarks();
  }, [reloadBookmarks]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRequests([]);
      return;
    }
    void reloadSelected(selectedId).catch((caught) => {
      setError(
        caught instanceof Error
          ? errorText(caught)
          : "Host session request failed.",
      );
      setDetail(null);
    });
  }, [selectedId, reloadSelected]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? errorText(caught)
          : "Host session request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const itemLabels = Object.fromEntries(
    items.map((item) => [item.id, item.name]),
  );

  return (
    <section
      className="panel"
      id="host-shared-sessions"
      aria-label="Host shared sessions"
    >
      <div className="panel__head">
        <h2>Host shared sessions</h2>
        <fieldset className="vtree__keys" aria-label="Shared session commands">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Open shared session"
            title="Open shared session"
            disabled={busy}
            onClick={() => setDraft(true)}
          >
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Reload shared sessions"
            title="Reload shared sessions"
            disabled={busy}
            onClick={() => {
              setError("");
              reloadBookmarks();
              if (selectedId)
                void reloadSelected(selectedId).catch((caught) =>
                  setError(
                    caught instanceof Error
                      ? errorText(caught)
                      : "Host session request failed.",
                  ),
                );
            }}
          >
            <IconRefresh size={15} />
          </button>
        </fieldset>
      </div>
      <div className="panel__body">
        <p className="hint">
          A Host session is the live room for sharing this vault. Grants name a
          principal, a collection or rows, a role, and a TTL. Public sessions
          accept join requests; admitting one mints the grant. Stop a grant by
          withdrawing it — re-key the vault to make kept ciphertext unreadable.
        </p>
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {draft ? (
          <OpenSessionForm
            busy={busy}
            onCancel={() => setDraft(false)}
            onSave={(input) =>
              void run(async () => {
                const opened = await openSharedSession(
                  input.displayName,
                  input.visibility,
                );
                await rememberHostSession(tomb, {
                  sessionId: opened.id,
                  displayName: opened.displayName,
                  visibility: opened.visibility,
                });
                setDraft(false);
                reloadBookmarks();
                setSelectedId(opened.id);
              })
            }
          />
        ) : null}
        <ul className="identity-rows">
          {bookmarks.map((bookmark) => (
            <li
              key={bookmark.sessionId}
              className="identity-row"
              id={`host-session-${bookmark.sessionId}`}
            >
              <div className="identity-row__main">
                <div className="identity-row__id">
                  <h3>{bookmark.displayName}</h3>
                  <code className="identity-ref">
                    {bookmark.sessionId} · {bookmark.visibility}
                  </code>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busy}
                    onClick={() => setSelectedId(bookmark.sessionId)}
                  >
                    Manage
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await forgetHostSession(tomb, bookmark.sessionId);
                        if (selectedId === bookmark.sessionId)
                          setSelectedId(null);
                        reloadBookmarks();
                      })
                    }
                  >
                    Forget
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {detail && selectedId ? (
          <HostSessionManage
            tomb={tomb}
            detail={detail}
            requests={requests}
            busy={busy}
            items={items.map((item) => ({ id: item.id, label: item.name }))}
            itemLabels={itemLabels}
            onRefresh={() =>
              void reloadSelected(selectedId).catch((caught) =>
                setError(
                  caught instanceof Error
                    ? errorText(caught)
                    : "Host session request failed.",
                ),
              )
            }
            onRun={run}
          />
        ) : null}
      </div>
    </section>
  );
}

function OpenSessionForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (input: {
    displayName: string;
    visibility: SessionVisibility;
  }) => void;
}) {
  const [displayName, setDisplayName] = useState("Shared vault");
  const [visibility, setVisibility] = useState<SessionVisibility>("private");
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ displayName, visibility });
      }}
    >
      <label className="field">
        <span className="field__label">Session name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={120}
          required
        />
      </label>
      <fieldset className="preset" aria-label="Visibility">
        <button
          type="button"
          className={visibility === "private" ? "preset__on" : undefined}
          onClick={() => setVisibility("private")}
        >
          Private
        </button>
        <button
          type="button"
          className={visibility === "public" ? "preset__on" : undefined}
          onClick={() => setVisibility("public")}
        >
          Public
        </button>
      </fieldset>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--sm btn--primary"
          disabled={busy}
        >
          Open
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

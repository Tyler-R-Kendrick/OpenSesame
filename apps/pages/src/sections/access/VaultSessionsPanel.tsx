/**
 * Access › Sessions — vault-bound share sessions with a join code.
 * Start issues time-boxed grants; stop revokes them; restart reissues.
 */

import { useCallback, useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconArrowRight,
  IconPlus,
  IconRefresh,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

import { subscribeLocalIamChanges } from "@opensesame/app-core/lib/local-iam-events.js";
import {
  SHARE_DURATIONS,
  SHARE_POLICIES,
} from "@opensesame/app-core/lib/local-share-grants.js";
import {
  type LocalVaultSession,
  type SessionGrantSpec,
  createVaultSession,
  listVaultSessions,
  restartVaultSession,
  startVaultSession,
  stopVaultSession,
} from "@opensesame/app-core/lib/local-vault-sessions.js";
import { listDeviceVaults } from "@opensesame/app-core/lib/vaults.js";
import { useVaultStore } from "../../lib/vault/hooks.js";

export function VaultSessionsPanel({ tomb }: { tomb: string }) {
  const [sessions, setSessions] = useState<LocalVaultSession[]>([]);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = useVaultStore()
    .getSnapshot()
    .items.filter((item) => item.deletedAt === null);

  const reload = useCallback(() => {
    void listVaultSessions(tomb)
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [tomb]);

  useEffect(() => {
    const off = subscribeLocalIamChanges(reload);
    reload();
    return off;
  }, [reload]);

  async function run(action: () => Promise<LocalVaultSession | undefined>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setDraft(false);
      reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update sessions.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="panel"
      id="vault-share-sessions"
      aria-label="Vault share sessions"
    >
      <div className="panel__head">
        <h2>Vault share sessions</h2>
        <fieldset className="vtree__keys" aria-label="Session commands">
          <IconKey
            label="Start vault session"
            small
            disabled={busy}
            onClick={() => setDraft(true)}
          >
            <IconPlus size={15} />
          </IconKey>
          <IconKey
            label="Reload sessions"
            small
            disabled={busy}
            onClick={() => {
              setError("");
              reload();
            }}
          >
            <IconRefresh size={15} />
          </IconKey>
        </fieldset>
      </div>
      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            {error}
          </p>
        ) : null}
        {draft ? (
          <NewVaultSessionForm
            tomb={tomb}
            busy={busy}
            items={items.map((item) => ({ id: item.id, label: item.name }))}
            onCancel={() => setDraft(false)}
            onSave={(input) =>
              void run(() =>
                createVaultSession(tomb, { ...input, start: true }),
              )
            }
          />
        ) : null}
        <ul className="identity-rows">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              busy={busy}
              onStart={() =>
                void run(() => startVaultSession(tomb, session.id))
              }
              onStop={() => void run(() => stopVaultSession(tomb, session.id))}
              onRestart={() =>
                void run(() => restartVaultSession(tomb, session.id))
              }
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function SessionRow({
  session,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  session: LocalVaultSession;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  return (
    <li className="identity-row" id={`vault-session-${session.id}`}>
      <div className="identity-row__main">
        <div className="identity-row__id">
          <h3>{session.label}</h3>
          <code className="identity-ref">
            code {session.code} · {session.grants.length} grant
            {session.grants.length === 1 ? "" : "s"} · bound {session.boundTomb}
          </code>
        </div>
        <StatusMark
          tone={session.status === "stopped" ? "idle" : "ok"}
          label={session.status}
        />
        {session.expiresAt ? (
          <StatusMark
            tone="idle"
            label={`Until ${new Date(session.expiresAt).toLocaleString()}`}
          />
        ) : null}
        <div className="actions">
          {session.status === "stopped" ? (
            <IconKey
              label="Start session"
              small
              disabled={busy}
              onClick={onStart}
            >
              <IconArrowRight size={16} />
            </IconKey>
          ) : (
            <IconKey
              label="Stop session"
              small
              danger
              disabled={busy}
              onClick={onStop}
            >
              <IconX size={16} />
            </IconKey>
          )}
          <IconKey
            label="Restart session"
            small
            disabled={busy}
            onClick={onRestart}
          >
            <IconRefresh size={16} />
          </IconKey>
        </div>
      </div>
    </li>
  );
}

function NewVaultSessionForm({
  tomb,
  busy,
  items,
  onCancel,
  onSave,
}: {
  tomb: string;
  busy: boolean;
  items: { id: string; label: string }[];
  onCancel: () => void;
  onSave: (input: {
    label: string;
    durationSeconds: number;
    grants: SessionGrantSpec[];
  }) => void;
}) {
  const vault =
    listDeviceVaults().find((row) => row.id === tomb) ?? listDeviceVaults()[0];
  const [label, setLabel] = useState("Shared session");
  const [duration, setDuration] = useState<number>(SHARE_DURATIONS[0].seconds);
  const [subject, setSubject] = useState<"guest" | "member" | "operator">(
    "guest",
  );
  const [scope, setScope] = useState<"vault" | "item">("vault");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");

  function submit() {
    if (!vault) return;
    const grants: SessionGrantSpec[] = [];
    if (scope === "vault") {
      grants.push({
        subject: { kind: "accessRole", role: subject },
        resourceKind: "vault",
        resourceId: vault.id,
        resourceLabel: vault.label,
        policy: subject === "guest" ? "open" : "items",
      });
    } else if (itemId) {
      const item = items.find((row) => row.id === itemId);
      grants.push({
        subject: { kind: "accessRole", role: subject },
        resourceKind: "item",
        resourceId: itemId,
        resourceLabel: item?.label ?? itemId,
        policy: "read",
      });
    }
    onSave({ label, durationSeconds: duration, grants });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="field">
        <label className="label" htmlFor="vault-session-label">
          Session name
        </label>
        <input
          id="vault-session-label"
          required
          maxLength={128}
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="vault-session-subject">
          Grant to
        </label>
        <select
          id="vault-session-subject"
          value={subject}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "guest" || value === "member" || value === "operator")
              setSubject(value);
          }}
        >
          <option value="guest">Guest</option>
          <option value="member">Member</option>
          <option value="operator">Operator</option>
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="vault-session-scope">
          Scope
        </label>
        <select
          id="vault-session-scope"
          value={scope}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "vault" || value === "item") setScope(value);
          }}
        >
          <option value="vault">Whole vault</option>
          <option value="item">Selected row</option>
        </select>
      </div>
      {scope === "item" ? (
        <div className="field">
          <label className="label" htmlFor="vault-session-item">
            Row
          </label>
          <select
            id="vault-session-item"
            value={itemId}
            disabled={busy || items.length === 0}
            onChange={(event) => setItemId(event.target.value)}
          >
            {items.length === 0 ? (
              <option value="">No items in this vault</option>
            ) : (
              items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))
            )}
          </select>
          <p className="hint">
            Row policy: {SHARE_POLICIES.item[0]?.label ?? "Read"}
          </p>
        </div>
      ) : null}
      <div className="field">
        <label className="label" htmlFor="vault-session-ttl">
          Lifetime
        </label>
        <select
          id="vault-session-ttl"
          value={duration}
          disabled={busy}
          onChange={(event) => setDuration(Number(event.target.value))}
        >
          {SHARE_DURATIONS.map((entry) => (
            <option key={entry.seconds} value={entry.seconds}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <FormCommit label="Start session" disabled={busy}>
        <IconKey label="Cancel" disabled={busy} onClick={onCancel}>
          <IconX size={16} />
        </IconKey>
      </FormCommit>
    </form>
  );
}

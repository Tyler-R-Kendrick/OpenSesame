/**
 * Access › Sessions — vault-bound share sessions with a join code.
 * Start issues time-boxed grants; stop revokes them; restart reissues.
 */

import { useCallback, useEffect, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
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
import {
  AccessDetail,
  AccessFact,
  AccessRecords,
  useAccessRecord,
} from "./AccessRecords.js";

export function VaultSessionsPanel({ tomb }: { tomb: string }) {
  const [sessions, setSessions] = useState<LocalVaultSession[]>([]);
  const selection = useAccessRecord(
    "vault-share-sessions",
    "sessions",
    "vault-session-",
  );
  const draft = selection.creating;
  const setDraft = selection.setCreating;
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
      const result = await action();
      if (draft && result) selection.select(result.id);
      reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update sessions.",
      );
    } finally {
      setBusy(false);
    }
  }

  const selected = sessions.find((session) => session.id === selection.id);
  return (
    <AccessRecords
      title="Vault share sessions"
      selection={selection}
      rows={sessions.map((session) => ({
        id: session.id,
        label: session.label,
        extension: "session",
        to: selection.path(session.id),
      }))}
      commands={
        <>
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
        </>
      }
      status={
        <FailureNotice id="access:sessions" title="Sessions" message={error} />
      }
    >
      {draft ? (
        <AccessDetail title="New vault share session" kind="Session">
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
        </AccessDetail>
      ) : null}
      {!draft && selected ? (
        <SessionRow
          session={selected}
          busy={busy}
          onStart={() => void run(() => startVaultSession(tomb, selected.id))}
          onStop={() => void run(() => stopVaultSession(tomb, selected.id))}
          onRestart={() =>
            void run(() => restartVaultSession(tomb, selected.id))
          }
        />
      ) : null}
    </AccessRecords>
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
    <AccessDetail
      title={session.label}
      kind="Vault share session"
      actions={
        <>
          <StatusMark
            tone={session.status === "stopped" ? "idle" : "ok"}
            label={session.status}
          />
          <IconKey
            label={
              session.status === "stopped" ? "Start session" : "Stop session"
            }
            small
            disabled={busy}
            onClick={session.status === "stopped" ? onStart : onStop}
          >
            {session.status === "stopped" ? (
              <IconArrowRight size={16} />
            ) : (
              <IconX size={16} />
            )}
          </IconKey>
          <IconKey
            label="Restart session"
            small
            disabled={busy}
            onClick={onRestart}
          >
            <IconRefresh size={16} />
          </IconKey>
        </>
      }
    >
      <AccessFact label="Join code" value={session.code} />
      <AccessFact label="Grants" value={session.grants.length} />
      <AccessFact label="Vault" value={session.boundTomb} />
      <AccessFact
        label="Expires"
        value={
          session.expiresAt ? new Date(session.expiresAt).toLocaleString() : "—"
        }
      />
      <AccessFact label="Reference" value={session.id} />
    </AccessDetail>
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

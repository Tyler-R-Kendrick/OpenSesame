/**
 * Shared grant draft controls for Host session manage / admit.
 */

import { useState } from "react";
import {
  hostItemId,
  hostPrincipalId,
  hostVaultIdForTomb,
} from "../../lib/host-ids.js";
import { SHARE_DURATIONS } from "../../lib/local-share-grants.js";
import { activeProject } from "../../lib/projects.js";
import type { GrantInput, SessionRole } from "../../lib/shared-sessions.js";

export function useGrantDraft(items: { id: string; label: string }[]) {
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<SessionRole>("read");
  const [duration, setDuration] = useState<number>(
    SHARE_DURATIONS[1]?.seconds ?? 3600,
  );
  const [byRow, setByRow] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  async function buildGrant(
    requireSubject: boolean,
  ): Promise<GrantInput | null> {
    const vaultId = await hostVaultIdForTomb(activeProject().id);
    const expiresAt = new Date(Date.now() + duration * 1000).toISOString();
    const scope = byRow
      ? {
          kind: "rows" as const,
          vaultId,
          items: selected
            .map((id) => hostItemId(id))
            .filter((id): id is string => id !== null),
        }
      : { kind: "collection" as const, vaultId };
    if (scope.kind === "rows" && scope.items.length === 0) return null;
    if (!requireSubject) return { scope, role, expiresAt };
    const principal = hostPrincipalId(subject);
    if (!principal) return null;
    return { subjectPrincipalId: principal, scope, role, expiresAt };
  }

  return {
    subject,
    setSubject,
    role,
    setRole,
    duration,
    setDuration,
    byRow,
    setByRow,
    selected,
    setSelected,
    items,
    buildGrant,
  };
}

export function GrantFields({
  draft,
  showSubject,
}: {
  draft: ReturnType<typeof useGrantDraft>;
  showSubject: boolean;
}) {
  return (
    <>
      {showSubject ? (
        <label className="field">
          <span className="field__label">Principal id</span>
          <input
            value={draft.subject}
            onChange={(event) => draft.setSubject(event.target.value)}
            placeholder="principal:…"
            required
          />
        </label>
      ) : null}
      <fieldset className="preset" aria-label="Scope">
        <button
          type="button"
          className={!draft.byRow ? "preset__on" : undefined}
          onClick={() => draft.setByRow(false)}
        >
          Whole vault
        </button>
        <button
          type="button"
          className={draft.byRow ? "preset__on" : undefined}
          onClick={() => draft.setByRow(true)}
        >
          Chosen rows
        </button>
      </fieldset>
      {draft.byRow ? (
        <ul className="identity-rows">
          {draft.items.map((item) => {
            const on = draft.selected.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={on ? "preset__on" : undefined}
                  onClick={() =>
                    draft.setSelected((prev) =>
                      on
                        ? prev.filter((id) => id !== item.id)
                        : [...prev, item.id],
                    )
                  }
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <fieldset className="preset" aria-label="Role">
        <button
          type="button"
          className={draft.role === "read" ? "preset__on" : undefined}
          onClick={() => draft.setRole("read")}
        >
          Read
        </button>
        <button
          type="button"
          className={draft.role === "write" ? "preset__on" : undefined}
          onClick={() => draft.setRole("write")}
        >
          Write
        </button>
      </fieldset>
      <fieldset className="preset" aria-label="Until">
        {SHARE_DURATIONS.filter((entry) => entry.seconds <= 7 * 86400).map(
          (entry) => (
            <button
              key={entry.seconds}
              type="button"
              className={
                draft.duration === entry.seconds ? "preset__on" : undefined
              }
              onClick={() => draft.setDuration(entry.seconds)}
            >
              {entry.label}
            </button>
          ),
        )}
      </fieldset>
    </>
  );
}

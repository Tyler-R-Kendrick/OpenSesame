import { useCallback, useEffect, useRef, useState } from "react";
import { readLocalDirectory } from "../../lib/local-directory.js";
import {
  listRecordedLocalGrants,
  revokeRecordedLocalGrant,
} from "../../lib/local-grant-admin.js";
import { subscribeLocalIamChanges } from "../../lib/local-iam-events.js";
import {
  listLocalIdentitySessions,
  revokeLocalIdentitySession,
} from "../../lib/local-sessions.js";

export type LocalAuthorityRow = Readonly<{
  id: string;
  kind: "session" | "grant";
  name: string;
  detail: string;
  expiresAt: number;
}>;

async function readRows(tomb: string): Promise<LocalAuthorityRow[]> {
  const directory = await readLocalDirectory(tomb);
  const sessions = await listLocalIdentitySessions(tomb);
  const grants = await listRecordedLocalGrants(tomb);
  const names = new Map(
    directory.entries.map((entry) => [entry.id, entry.name]),
  );
  const name = (id: string) => names.get(id) ?? id;
  return [
    ...sessions.map(
      (session): LocalAuthorityRow => ({
        id: session.id,
        kind: "session",
        name: name(session.principalId),
        detail:
          session.authentication === "passkey"
            ? "Passkey session"
            : "Agent-key session",
        expiresAt: session.expiresAt,
      }),
    ),
    ...grants.map(
      (grant): LocalAuthorityRow => ({
        id: grant.id,
        kind: "grant",
        name: `${name(grant.principalId)} → ${name(grant.applicationId)}`,
        detail: `${name(grant.organizationId)} · ${grant.scopes.join(", ")}${grant.approvingPrincipalId ? ` · Approved by ${name(grant.approvingPrincipalId)}` : ""}`,
        expiresAt: grant.expiresAt,
      }),
    ),
  ];
}

export function useLocalAuthority(tomb: string) {
  const [rows, setRows] = useState<LocalAuthorityRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const alive = useRef(false);
  const mutating = useRef(false);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await readRows(tomb);
      if (!alive.current || request !== generation.current) return;
      setRows(next);
      setError("");
    } catch {
      if (!alive.current || request !== generation.current) return;
      setRows(null);
      setError(
        "Could not read local access records. Unlock this vault and reload.",
      );
    }
  }, [tomb]);
  useEffect(() => {
    alive.current = true;
    const refresh = () => void reload();
    const unsubscribe = subscribeLocalIamChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      alive.current = false;
      generation.current++;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  useEffect(() => {
    if (!rows?.length) return;
    const deadline = Math.min(...rows.map((row) => row.expiresAt));
    const timer = setTimeout(
      () => void reload(),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [rows, reload]);
  async function revoke(row: LocalAuthorityRow) {
    if (mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (row.kind === "session")
        await revokeLocalIdentitySession(tomb, row.id);
      else await revokeRecordedLocalGrant(tomb, row.id);
      if (!alive.current) return false;
      setMessage(
        row.kind === "session"
          ? "Local session revoked."
          : "Application grant revoked.",
      );
      await reload();
      return true;
    } catch {
      if (alive.current)
        setError("Revocation was not confirmed. Reload and retry.");
      return false;
    } finally {
      mutating.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return { rows, error, busy, message, reload, revoke };
}

/**
 * GitHub account, permissions, and repositories inside the connection card.
 * The Access grant is recorded for the access page; it is not listed here.
 */
import { useEffect, useState } from "react";
import type { Connection } from "../../lib/connections.js";
import {
  ensureGithubAccessGrant,
  loadGithubInstallationSnapshot,
  shouldEnsureGithubAccessGrant,
} from "../../lib/github-installation-access.js";
import { useVault } from "../../lib/vault/hooks.js";

type AccountRow = { id: string; login: string; type: string };
type PermissionRow = { name: string; access: string };

export function GithubCardDetails({ connection }: { connection: Connection }) {
  const { tomb } = useVault();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const initial = await loadGithubInstallationSnapshot(tomb, connection);
      if (shouldEnsureGithubAccessGrant(initial, connection)) {
        await ensureGithubAccessGrant(tomb, connection);
      }
      if (cancel) return;
      const nextAccounts = initial.installations.map((row) => ({
        id: row.id,
        login: row.accountLogin,
        type: row.accountType,
      }));
      if (nextAccounts.length === 0 && connection.accountLabel) {
        nextAccounts.push({
          id: connection.connectionId,
          login: connection.accountLabel,
          type: "",
        });
      }
      const scopes = connection.grantedScopes.length
        ? connection.grantedScopes
        : connection.requestedScopes;
      setAccounts(nextAccounts);
      setPermissions([
        ...initial.installations.flatMap((row) => row.permissions ?? []),
        ...scopes.map((name) => ({ name, access: "" })),
      ]);
      setRepos(
        initial.repos.length > 0
          ? initial.repos.map((repo) => repo.fullName)
          : initial.installations.flatMap((row) => row.repositories ?? []),
      );
    })();
    return () => {
      cancel = true;
    };
  }, [connection, tomb]);

  return (
    <>
      {accounts.map((row) => (
        <p
          key={row.id}
          className="conn-card__ref"
          data-testid="github-install-account"
        >
          {row.login}
          {row.type ? ` · ${row.type}` : ""}
        </p>
      ))}
      {permissions.length > 0 ? (
        <details>
          <summary>Permissions</summary>
          <ul className="conn-scopes" data-testid="github-install-permissions">
            {permissions.map((row) => (
              <li key={`${row.name}:${row.access}`}>
                <code>{row.name}</code>
                {row.access ? <span>{row.access}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {repos.length > 0 ? (
        <details>
          <summary>Repositories</summary>
          <ul data-testid="github-install-repos">
            {repos.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

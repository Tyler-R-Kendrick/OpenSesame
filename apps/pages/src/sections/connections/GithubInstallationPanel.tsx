import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  ensureGithubAccessGrant,
  loadGithubInstallationSnapshot,
  shouldEnsureGithubAccessGrant,
} from "@opensesame/app-core/lib/github-installation-access.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
/**
 * GitHub account, permissions, and repositories inside the connection card.
 * The Access grant is recorded for the access page; it is not listed here.
 */
import { useEffect, useRef, useState } from "react";
import { useVault } from "../../lib/vault/hooks.js";

/** The installation reads and the grant write; a test stands in for them. */
export const githubInstallationSeams = {
  load: loadGithubInstallationSnapshot,
  should: shouldEnsureGithubAccessGrant,
  ensure: ensureGithubAccessGrant,
};

type AccountRow = { id: string; login: string; type: string };
type PermissionRow = { name: string; access: string };

export function GithubCardDetails({
  connection,
  onFlash,
}: {
  connection: Connection;
  onFlash?: (flash: Flash) => void;
}) {
  const { tomb } = useVault();
  const flash = useRef(onFlash);
  flash.current = onFlash;
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [repos, setRepos] = useState<string[]>([]);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const initial = await githubInstallationSeams.load(tomb, connection);
        if (cancel) return;
        if (githubInstallationSeams.should(initial, connection)) {
          // The card can unmount while the snapshot is in flight. The guard
          // is checked again immediately before the write so a route change
          // never mints a standing grant for a page the person left.
          await githubInstallationSeams.ensure(tomb, connection, () => !cancel);
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
          initial.installations.flatMap((row) => row.repositories ?? []),
        );
      } catch (error) {
        // A locked or unreadable vault is a card-level failure, not an
        // unhandled rejection. Do not surface it after unmount.
        if (!cancel) flash.current?.({ tone: "err", text: errorText(error) });
      }
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

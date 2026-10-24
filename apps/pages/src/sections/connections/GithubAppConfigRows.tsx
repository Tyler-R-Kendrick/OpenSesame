import type { GithubAppPermission } from "@opensesame/app-core/lib/backup.js";
import { forgetLocalGithubApp } from "@opensesame/app-core/lib/github-app-manifest.js";
import type { GithubAppInstallView } from "@opensesame/app-core/lib/github-app-presence.js";
import { IconTrash } from "../../components/Icons.js";

/** What Remove does; a test stands in for it. */
export const githubAppForgetSeams = {
  forget: (): void => forgetLocalGithubApp(),
};

/** Unregister the local GitHub App — lives next to the connector title. */
export function GithubAppForgetButton() {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--sm"
      data-testid="github-app-forget"
      aria-label="Remove GitHub App from this device"
      title="Remove GitHub App from this device"
      onClick={() => {
        // Remove destroys the sealed private key and client secret. Ask first;
        // an accidental click cannot be undone.
        if (
          globalThis.confirm instanceof Function &&
          !globalThis.confirm(
            "Remove the GitHub App from this device? Its private key and client secret will be deleted.",
          )
        )
          return;
        githubAppForgetSeams.forget();
      }}
    >
      <IconTrash size={16} />
    </button>
  );
}

/** Always-visible labeled permission list for the post-install App summary. */
export function GithubAppPermissionBlock({
  label,
  testId,
  rows,
}: {
  label: string;
  testId: string;
  rows: GithubAppPermission[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="conn-github-fact">
      <span className="conn-github-presence__k">{label}</span>
      <ul className="conn-scopes" data-testid={testId}>
        {rows.map((row) => (
          <li key={`${row.name}:${row.access}`}>
            <code>{row.name}</code>
            {row.access ? <span>{row.access}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Install account rows for the post-install App summary. */
export function GithubAppInstallRows({
  installs,
}: {
  installs: GithubAppInstallView[];
}) {
  return (
    <>
      {installs.map((row) => (
        <div
          key={row.id}
          className="conn-github-fact"
          data-testid="github-app-install"
        >
          <span className="conn-github-presence__k">Installed</span>
          <span>
            {row.accountLogin}
            {row.accountType ? ` · ${row.accountType}` : ""}
            {row.repositorySelection
              ? ` · repos ${row.repositorySelection}`
              : ""}
          </span>
        </div>
      ))}
    </>
  );
}

/** Always-visible repository list for the post-install App summary. */
export function GithubAppRepoList({
  installs,
}: {
  installs: GithubAppInstallView[];
}) {
  const names = installs.flatMap((row) => row.repositories);
  if (names.length === 0) return null;
  return (
    <div className="conn-github-fact">
      <span className="conn-github-presence__k">Repositories</span>
      <ul data-testid="github-app-repos">
        {names.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

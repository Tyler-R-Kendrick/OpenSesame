import type { GithubAppPermission } from "@opensesame/app-core/lib/backup.js";
import { forgetLocalGithubApp } from "@opensesame/app-core/lib/github-app-manifest.js";
import type { GithubAppInstallView } from "@opensesame/app-core/lib/github-app-presence.js";
import { useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import { IconTrash, IconX } from "../../components/Icons.js";

/**
 * Unregister the local GitHub App — lives next to the connector title.
 * Removing destroys the sealed private key and client secret, so it asks
 * first the way every destructive key does (DESIGN.md): one press arms the
 * key, a second removes, and the keep beside it disarms and hands focus back.
 */
export function GithubAppForgetButton() {
  const [armed, setArmed] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconKey
        keyRef={primary}
        small
        armed={armed}
        data-testid="github-app-forget"
        label={
          armed
            ? "Confirm removing the GitHub App from this device"
            : "Remove GitHub App from this device"
        }
        onClick={() => (armed ? forgetLocalGithubApp() : setArmed(true))}
      >
        <IconTrash size={16} />
      </IconKey>
      {armed ? (
        <IconKey
          small
          label="Keep the GitHub App"
          onClick={() => {
            setArmed(false);
            primary.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
    </>
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

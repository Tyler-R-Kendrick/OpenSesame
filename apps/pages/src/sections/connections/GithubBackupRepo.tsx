/**
 * One backup field on the GitHub connection card. Type or pick a slug.
 * A name that already exists is bound; any other valid slug is created.
 * Once bound, the slug is a label until it is edited.
 */
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { IconEdit } from "../../components/Icons.js";
import {
  type BackupTargetView,
  type GithubInstallation,
  filterPrivateGithubRepos,
  getBackupStatus,
  listGithubInstallations,
  ownerRepoFromRemote,
  putBackupTarget,
} from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import {
  DEFAULT_PASSWORD_REPO_NAME,
  createGithubPasswordRepo,
  listGithubRepos,
} from "../../lib/github-history.js";
import type { Flash } from "./shared.js";

type RepoChoice = { fullName: string };

export function GithubBackupField({
  connection,
  online,
  onFlash,
  onReady,
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onReady?: (ready: boolean) => void;
}) {
  const listId = useId();
  const [target, setTarget] = useState<BackupTargetView | null>(null);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [draft, setDraft] = useState(DEFAULT_PASSWORD_REPO_NAME);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const onReadyRef = useRef(onReady);
  const flight = useRef(false);
  const skipBlur = useRef(false);
  const touched = useRef(false);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const status = await getBackupStatus().catch(() => null);
      const next = status?.target ?? null;
      const listed =
        connection.status === "active"
          ? filterPrivateGithubRepos(
              await listGithubRepos(connection.connectionId).catch(() => []),
            )
          : [];
      const installs = connection.integrationId
        ? await listGithubInstallations(connection.integrationId).catch(
            () => [],
          )
        : [];
      if (cancel) return;
      setTarget(next);
      setInstallationId(installId(next, installs));
      setRepos(
        choices(
          listed.map((repo) => repo.fullName),
          installs,
          next,
        ),
      );
      onReadyRef.current?.(isBound(next));
    })();
    return () => {
      cancel = true;
    };
  }, [connection]);

  async function bind(fullName: string) {
    const parsed = ownerRepoFromRemote(fullName);
    const install = installationId;
    if (!parsed || !install || !online) {
      onFlash({
        tone: "err",
        text: "Install the GitHub App, then choose a repository.",
      });
      return;
    }
    setBusy(true);
    try {
      const saved = connection.integrationId
        ? await putBackupTarget({
            connectionId: connection.connectionId,
            integrationId: connection.integrationId,
            installationId: install,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: "main",
            enabled: true,
          })
        : await putBackupTarget({
            connectionId: connection.connectionId,
            installationId: install,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: "main",
            enabled: true,
          });
      setTarget(saved);
      setEditing(false);
      setDraft("");
      onReadyRef.current?.(true);
      onFlash({ tone: "ok", text: `${saved.owner}/${saved.repo}` });
    } catch (caught) {
      onFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? plain(caught.message)
            : "Could not save the backup repository.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function commit(raw: string) {
    if (!online || flight.current) return;
    const slug = sanitizeRepoSlug(raw);
    const current = target ? `${target.owner}/${target.repo}` : "";
    if (
      !slug ||
      slug.endsWith("/") ||
      slug.toLowerCase() === current.toLowerCase()
    ) {
      setEditing(false);
      return;
    }
    const known = existingRepo(
      slug,
      repos.map((repo) => repo.fullName),
    );
    flight.current = true;
    try {
      if (known) {
        await bind(known);
        return;
      }
      const name = repoNameFromSlug(slug);
      if (!name) return;
      const created = await createGithubPasswordRepo(connection.connectionId, {
        name,
        private: true,
      });
      setRepos((currentRepos) =>
        choices(
          [created.fullName, ...currentRepos.map((row) => row.fullName)],
          [],
          target,
        ),
      );
      await bind(created.fullName);
    } catch (caught) {
      onFlash({
        tone: "err",
        text:
          caught instanceof Error
            ? plain(caught.message)
            : "Could not create the repository.",
      });
    } finally {
      flight.current = false;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void commit(readBackupField(event.currentTarget));
  }

  const selected = target ? `${target.owner}/${target.repo}` : "";
  const showField = !isBound(target) || editing;

  if (!showField) {
    return (
      <p className="conn-card__repo">
        <span className="conn-card__ref" data-testid="github-backup-repo">
          {selected}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Edit repository"
          title="Edit repository"
          onClick={() => {
            setDraft(selected);
            setEditing(true);
          }}
        >
          <IconEdit size={14} />
        </button>
      </p>
    );
  }

  return (
    <form className="conn-card__repo" onSubmit={onSubmit}>
      <input
        name="backup"
        aria-label="Backup repository"
        list={listId}
        value={draft}
        placeholder="owner/repo"
        disabled={!online || busy}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => {
          touched.current = true;
          setDraft(sanitizeRepoSlug(event.target.value));
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => {
          if (skipBlur.current) {
            skipBlur.current = false;
            return;
          }
          const value = sanitizeRepoSlug(event.currentTarget.value);
          if (
            !editing &&
            !touched.current &&
            value === DEFAULT_PASSWORD_REPO_NAME
          ) {
            return;
          }
          void commit(value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          skipBlur.current = true;
          setDraft("");
          setEditing(false);
        }}
      />
      <datalist id={listId}>
        {repos.map((repo) => (
          <option key={repo.fullName} value={repo.fullName} />
        ))}
      </datalist>
    </form>
  );
}

/** GitHub repository slugs: letters, numbers, `.`, `_`, `-`, and one `/`. */
export function sanitizeRepoSlug(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._/-]/gu, "");
  const slash = cleaned.indexOf("/");
  if (slash === -1) return cleanSegment(cleaned).slice(0, 100);
  const owner = cleanSegment(cleaned.slice(0, slash)).slice(0, 39);
  const repo = cleanSegment(cleaned.slice(slash + 1).replace(/\//gu, "")).slice(
    0,
    100,
  );
  return cleaned.endsWith("/") && repo === ""
    ? `${owner}/`
    : `${owner}/${repo}`;
}

export function repoNameFromSlug(slug: string): string | null {
  const name = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(name)) return null;
  if (name.endsWith(".") || name.toLowerCase().endsWith(".git")) return null;
  return name;
}

export function existingRepo(slug: string, repos: string[]): string | null {
  const needle = slug.trim().toLowerCase();
  if (!needle || needle.endsWith("/")) return null;
  const exact = repos.find((name) => name.toLowerCase() === needle);
  if (exact) return exact;
  if (needle.includes("/")) return null;
  const matches = repos.filter(
    (name) => name.split("/")[1]?.toLowerCase() === needle,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function readBackupField(form: HTMLFormElement): string {
  const field = form.elements.namedItem("backup");
  if (field instanceof HTMLInputElement) return field.value;
  return "";
}

function cleanSegment(value: string): string {
  return value.replace(/^[.-]+/u, "").replace(/\.git$/iu, "");
}

function isBound(target: BackupTargetView | null): boolean {
  return Boolean(target?.enabled && target.repo !== "");
}

function installId(
  target: BackupTargetView | null,
  rows: GithubInstallation[],
): string | null {
  if (target?.installationId) return target.installationId;
  return rows[0]?.id ?? null;
}

function choices(
  names: string[],
  installs: GithubInstallation[],
  target: BackupTargetView | null,
): RepoChoice[] {
  const seen = new Set<string>();
  const out: RepoChoice[] = [];
  const add = (fullName: string) => {
    if (!fullName || seen.has(fullName)) return;
    seen.add(fullName);
    out.push({ fullName });
  };
  for (const fullName of names) add(fullName);
  for (const row of installs) {
    for (const fullName of row.repositories) add(fullName);
  }
  if (target?.owner && target.repo) add(`${target.owner}/${target.repo}`);
  return out;
}

function plain(message: string): string {
  if (message.includes("Host")) return "Could not save the backup repository.";
  return message;
}

import { overlapCast } from "@opensesame/os-domain";
import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck } from "../../components/Icons.js";
import {
  identityFetch,
  isDeviceIdentityMode,
  useConnect,
  useIdentitySession,
} from "../../lib/identity.js";
import { usePlaneStatus } from "../../lib/planes.js";
import {
  loadSettings,
  saveSettings,
  shouldAutoConnect,
} from "../../lib/settings.js";
import { useOnline } from "../../lib/use-online.js";

export type ProjectSummary = {
  id: string;
  slug: string;
  displayName: string;
  state: string;
  sealedStoreTombName?: string | null;
  pagesVaultFolderId?: string | null;
  created?: boolean;
};

type Flash = { tone: "ok" | "err" | "warn"; text: string };

function readActiveProjectId(): string {
  return loadSettings().activeProjectId?.trim() ?? "";
}

function persistActiveProjectId(projectId: string): void {
  const current = loadSettings();
  saveSettings({ ...current, activeProjectId: projectId.trim() });
}

/**
 * Active project picker. Defaults to the personal project via
 * POST /v1/projects/personal/ensure — answered by the remote Identity API or
 * the device-native host from vault projects (ADR 0118).
 */
export function ActiveProjectPanel() {
  const online = useOnline();
  const plane = usePlaneStatus();
  const session = useIdentitySession();
  const { connect, connecting } = useConnect();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState(readActiveProjectId);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const deviceIdentity = isDeviceIdentityMode();

  const refresh = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setFlash(null);
    try {
      const ensureRes = await identityFetch("/v1/projects/personal/ensure", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `pages-personal-ensure-${session.principalId}`,
        },
        body: "{}",
      });
      if (!ensureRes.ok) {
        const err: { message?: string; error?: string; hint?: string } | null =
          overlapCast(await ensureRes.json().catch(() => null));
        throw new Error(
          err?.message ??
            err?.hint ??
            err?.error ??
            `Ensure failed (${ensureRes.status})`,
        );
      }
      const personal: ProjectSummary = overlapCast(await ensureRes.json());
      const listRes = await identityFetch("/v1/projects");
      if (!listRes.ok) {
        throw new Error(`List projects failed (${listRes.status})`);
      }
      const body: { projects?: ProjectSummary[] } = overlapCast(
        await listRes.json(),
      );
      const nextProjects: ProjectSummary[] = body.projects ?? [];
      setProjects(nextProjects);

      const preferred =
        (activeId && nextProjects.find((p) => p.id === activeId)?.id) ||
        personal.id ||
        nextProjects.find((p) => p.slug === "personal")?.id ||
        nextProjects[0]?.id ||
        "";
      if (preferred && preferred !== activeId) {
        setActiveId(preferred);
        persistActiveProjectId(preferred);
      } else if (!activeId && preferred) {
        setActiveId(preferred);
        persistActiveProjectId(preferred);
      }
      setFlash({
        tone: "ok",
        text: personal.created
          ? "Personal project ready."
          : "Using your personal project.",
      });
    } catch (caught) {
      setFlash({
        tone: "err",
        text:
          caught instanceof Error ? caught.message : "Could not load projects.",
      });
    } finally {
      setBusy(false);
    }
  }, [session, activeId]);

  // Intentionally once per session and plane readiness; refresh is user-triggered after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: readiness changes intentionally trigger refresh
  useEffect(() => {
    if (!session) return;
    if (deviceIdentity) {
      void refresh();
      return;
    }
    if (!online || plane.identity !== "connected") return;
    void refresh();
  }, [session?.principalId, online, plane.identity, deviceIdentity]);

  function selectProject(projectId: string) {
    setActiveId(projectId);
    persistActiveProjectId(projectId);
    setFlash({ tone: "ok", text: "Active project saved." });
  }

  const active = projects.find((p) => p.id === activeId);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Active project</h2>
        </div>
      </div>
      <div className="panel__body">
        <OfflineNote online={online} deviceIdentity={deviceIdentity} />
        {session ? (
          <ProjectPicker
            deviceIdentity={deviceIdentity}
            projects={projects}
            activeId={activeId}
            active={active}
            busy={busy}
            flash={flash}
            onSelect={selectProject}
            onRefresh={() => void refresh()}
          />
        ) : (
          <ConnectIdentityButton
            connecting={connecting}
            deviceIdentity={deviceIdentity}
            onConnect={() => void connect()}
          />
        )}
      </div>
    </section>
  );
}

function OfflineNote({
  online,
  deviceIdentity,
}: {
  online: boolean;
  deviceIdentity: boolean;
}) {
  if (online || deviceIdentity) return null;
  return (
    <output className="note note--warn">
      Offline — project list needs Identity.
    </output>
  );
}

function ConnectIdentityButton({
  connecting,
  deviceIdentity,
  onConnect,
}: {
  connecting: boolean;
  deviceIdentity: boolean;
  onConnect: () => void;
}) {
  const disabled = connecting || (!deviceIdentity && !shouldAutoConnect());
  return (
    <div className="actions">
      <button
        type="button"
        className="btn btn--primary"
        disabled={disabled}
        onClick={onConnect}
      >
        {connecting ? "Connecting…" : "Connect Identity"}
      </button>
    </div>
  );
}

function ProjectPicker({
  deviceIdentity,
  projects,
  activeId,
  active,
  busy,
  flash,
  onSelect,
  onRefresh,
}: {
  deviceIdentity: boolean;
  projects: ProjectSummary[];
  activeId: string;
  active: ProjectSummary | undefined;
  busy: boolean;
  flash: Flash | null;
  onSelect: (projectId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      {deviceIdentity ? (
        <p className="hint">
          Projects on this device — the same list Settings → Vaults uses.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="active-project">Project</label>
        <select
          id="active-project"
          value={activeId}
          disabled={busy || projects.length === 0}
          onChange={(event) => onSelect(event.target.value)}
        >
          {projects.length === 0 ? (
            <option value="">No projects yet</option>
          ) : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.displayName}
              {project.slug === "personal" ? " (personal)" : ""} —{" "}
              {project.slug}
            </option>
          ))}
        </select>
      </div>
      {active ? (
        <p className="hint">
          Tomb binding: <code>{active.sealedStoreTombName ?? "personal"}</code>
          {active.pagesVaultFolderId
            ? ` · Vault folder: ${active.pagesVaultFolderId}`
            : null}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? "Refreshing…" : "Refresh / ensure personal"}
        </button>
        {flash ? (
          <output
            className={`chip chip--${flash.tone === "ok" ? "ok" : "err"}`}
          >
            {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
            {flash.text}
          </output>
        ) : null}
      </div>
    </>
  );
}

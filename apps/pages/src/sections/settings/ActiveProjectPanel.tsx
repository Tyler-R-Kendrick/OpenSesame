import { overlapCast } from "@opensesame/os-domain";
import { useCallback, useEffect, useState } from "react";
import { IconLogin, IconRefresh } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
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
    <div className="conn-group" id="active-project">
      <h3 className="conn-group__label">
        Project
        {online || deviceIdentity ? null : (
          <StatusMark tone="warn" label="Offline" />
        )}
      </h3>
      {session ? (
        <div className="conn-tile">
          <div className="conn-tile__body">
            <ProjectPicker
              projects={projects}
              activeId={activeId}
              active={active}
              busy={busy}
              flash={flash}
              onSelect={selectProject}
              onRefresh={() => void refresh()}
            />
          </div>
        </div>
      ) : (
        <ul className="conn-grid">
          <li className="conn-tile">
            <ConnectIdentityButton
              connecting={connecting}
              deviceIdentity={deviceIdentity}
              onConnect={() => void connect()}
            />
          </li>
        </ul>
      )}
    </div>
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
    <button
      type="button"
      className="conn-tile__link"
      disabled={disabled}
      onClick={onConnect}
      aria-label="Connect Identity"
      title="Connect Identity"
    >
      <IconLogin size={16} />
      <span className="conn-tile__name">Identity</span>
    </button>
  );
}

function ProjectPicker({
  projects,
  activeId,
  active,
  busy,
  flash,
  onSelect,
  onRefresh,
}: {
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
      <div className="actions">
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          aria-label="Refresh projects"
          title="Refresh projects"
          onClick={onRefresh}
        >
          <IconRefresh size={16} />
        </button>
        {flash ? (
          <StatusMark
            tone={flash.tone === "ok" ? "ok" : "err"}
            label={flash.text}
          />
        ) : null}
      </div>
    </>
  );
}

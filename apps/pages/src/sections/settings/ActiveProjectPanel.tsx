import { useCallback, useEffect, useState } from "react";
import {
  identityFetch,
  useConnect,
  useIdentitySession,
} from "../../lib/identity.js";
import {
  loadSettings,
  saveSettings,
  shouldAutoConnect,
} from "../../lib/settings.js";
import { usePlaneStatus } from "../../lib/planes.js";
import { useOnline } from "../../lib/use-online.js";
import { IconCheck, IconAlert } from "../../components/Icons.js";

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
 * Active Host project picker. Defaults to the personal project via
 * POST /v1/projects/personal/ensure. Persists selection outside the vault.
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
        const err = (await ensureRes.json().catch(() => null)) as {
          message?: string;
          error?: string;
        } | null;
        throw new Error(
          err?.message ?? err?.error ?? `Ensure failed (${ensureRes.status})`,
        );
      }
      const personal = (await ensureRes.json()) as ProjectSummary;
      const listRes = await identityFetch("/v1/projects");
      if (!listRes.ok) {
        throw new Error(`List projects failed (${listRes.status})`);
      }
      const body = (await listRes.json()) as { projects: ProjectSummary[] };
      const nextProjects = body.projects ?? [];
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
          caught instanceof Error
            ? caught.message
            : "Could not load projects.",
      });
    } finally {
      setBusy(false);
    }
  }, [session, activeId]);

  useEffect(() => {
    if (!session || !online || plane.identity !== "connected") return;
    void refresh();
    // Intentionally once per session+plane readiness; refresh() is user-triggered after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.principalId, online, plane.identity]);

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
          <p>
            Secrets and env scope default to your personal project. Selection
            is stored with endpoint prefs (not inside the encrypted vault).
          </p>
        </div>
      </div>
      <div className="panel__body">
        {!online ? (
          <p className="note note--warn" role="status">
            Offline — project list needs Identity.
          </p>
        ) : null}
        {!session ? (
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={connecting || !shouldAutoConnect()}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect Identity"}
            </button>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="active-project">Project</label>
              <select
                id="active-project"
                value={activeId}
                disabled={busy || projects.length === 0}
                onChange={(event) => selectProject(event.target.value)}
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
                onClick={() => void refresh()}
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
        )}
      </div>
    </section>
  );
}

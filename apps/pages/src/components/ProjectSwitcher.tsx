/**
 * Project switcher — swaps the top-level scope everything else lives in.
 *
 * Swapping reloads the app: the active project decides which sealed vault,
 * approved-site list and broker policy every module reads, and a reload is
 * the one way to guarantee nothing unlocked from the previous project
 * survives into the next one.
 */

import { useState, useSyncExternalStore } from "react";
import {
  PERSONAL_PROJECT_ID,
  createProject,
  deleteProject,
  projectsState,
  setActiveProject,
  subscribeProjects,
} from "../lib/projects.js";
import { IconCheck, IconFolder, IconPlus, IconTrash } from "./Icons.js";

function ProjectSwitcherDefault() {
  const state = useSyncExternalStore(subscribeProjects, projectsState);
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active =
    state.projects.find((project) => project.id === state.activeId) ??
    state.projects[0];

  function close(): void {
    setOpen(false);
    setDraftName("");
    setConfirmingDelete(null);
    setError(null);
  }

  async function swap(id: string): Promise<void> {
    if (id === state.activeId) {
      close();
      return;
    }
    try {
      await setActiveProject(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    window.location.reload();
  }

  async function create(): Promise<void> {
    try {
      const project = await createProject(draftName);
      await setActiveProject(project.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    window.location.reload();
  }

  async function remove(id: string): Promise<void> {
    try {
      await deleteProject(id);
      setConfirmingDelete(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="project-switcher">
      <button
        type="button"
        className="project-switcher__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <IconFolder size={15} />
        <span className="project-switcher__name">
          {active?.name ?? "Personal"}
        </span>
        <span className="project-switcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors Escape, handled on the menu */}
          <div
            className="project-switcher__backdrop"
            onClick={close}
            aria-hidden="true"
          />
          <div
            className="project-switcher__menu"
            aria-label="Projects"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
          >
            <p className="project-switcher__label">Projects</p>
            {state.projects.map((project) => (
              <div key={project.id} className="project-switcher__row">
                <button
                  type="button"
                  aria-current={project.id === state.activeId}
                  className={`project-switcher__item${
                    project.id === state.activeId ? " is-active" : ""
                  }`}
                  onClick={() => void swap(project.id)}
                >
                  <span className="project-switcher__item-name">
                    {project.name}
                  </span>
                  {project.id === state.activeId ? (
                    <IconCheck size={14} />
                  ) : null}
                </button>
                {project.id !== PERSONAL_PROJECT_ID &&
                project.id !== state.activeId ? (
                  confirmingDelete === project.id ? (
                    <button
                      type="button"
                      className="project-switcher__delete is-armed"
                      onClick={() => void remove(project.id)}
                    >
                      Really delete?
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="project-switcher__delete"
                      aria-label={`Delete project ${project.name}`}
                      title="Delete project and its vault from this device"
                      onClick={() => setConfirmingDelete(project.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  )
                ) : null}
              </div>
            ))}

            <form
              className="project-switcher__new"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <input
                type="text"
                value={draftName}
                placeholder="New project name"
                aria-label="New project name"
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setError(null);
                }}
              />
              <button
                type="submit"
                aria-label="Create project"
                disabled={draftName.trim().length === 0}
              >
                <IconPlus size={14} />
              </button>
            </form>
            {error ? <p className="project-switcher__error">{error}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const projectSwitcherSeams = {
  ProjectSwitcher: ProjectSwitcherDefault,
};

export function ProjectSwitcher() {
  const Impl = projectSwitcherSeams.ProjectSwitcher;
  return <Impl />;
}

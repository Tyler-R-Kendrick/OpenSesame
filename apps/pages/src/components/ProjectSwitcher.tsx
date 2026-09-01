/**
 * The `@tomb` segment of the shell prompt — swaps the vault everything else
 * lives in (ADR 0089).
 *
 * The popover is the same list the front door shows, with names now that a
 * tomb is open. Its header says what a switch costs — it locks this vault —
 * because the store cannot carry a key into a tomb sealed with a different
 * one. The exception is a vault that shares this session's key: its row says
 * "opens without a prompt", and that is what happens.
 *
 * Swapping locks the previous vault and rehydrates the next project's keys
 * in this tab. A full reload would drop the in-memory Identity session
 * (guest included) and force a reconnect; locking the vault is enough to
 * keep the previous project's key from surviving into the next one.
 */

import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { settingsPath } from "../lib/crumbs.js";
import {
  createProject,
  projectsState,
  setActiveProject,
  subscribeProjects,
} from "../lib/projects.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  type DeviceVault,
  enterActiveProjectScope,
  switchToGuest,
  useDeviceVaults,
  vaultLabel,
} from "../lib/vaults.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { IconPlus } from "./Icons.js";
import { VaultList } from "./VaultList.js";

function ProjectSwitcherDefault() {
  const state = useSyncExternalStore(subscribeProjects, projectsState);
  const navigate = useNavigate();
  const promptRef = useGuideTarget<HTMLButtonElement>("prompt.tomb");
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const active =
    state.projects.find((project) => project.id === state.activeId) ??
    state.projects[0];
  const snapshot = vaultStore.getSnapshot();
  const guestOpen = snapshot.status === "unlocked" && snapshot.guest;
  const vaults = useDeviceVaults();

  function close(): void {
    setOpen(false);
    setDraftName("");
    setError(null);
  }

  async function swap(vault: DeviceVault): Promise<void> {
    if (vault.state === "open") {
      close();
      return;
    }
    try {
      if (vault.kind === "guest") {
        await switchToGuest();
      } else {
        await setActiveProject(vault.id);
        await afterProjectChange(vault.sharedKey);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    close();
  }

  async function create(): Promise<void> {
    try {
      // The prompt's quick-create keeps the old road: the new vault shares
      // this session's key. The Manage panel is where that becomes a choice.
      // A guest has no key to share; its new vault gets its own ceremony.
      const carryUnlock = vaultStore.isUnlocked() && !guestOpen;
      const project = await createProject(draftName);
      await setActiveProject(project.id);
      await afterProjectChange(carryUnlock);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    close();
  }

  return (
    <div className="project-switcher">
      <button
        ref={promptRef}
        type="button"
        className="prompt__seg prompt__seg--tomb"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch vault"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {guestOpen ? "guest" : active ? vaultLabel(active) : "personal"}
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
            aria-label="Vaults on this device"
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
          >
            <div className="project-switcher__head">
              <p className="project-switcher__label">Vaults on this device</p>
              <span className="project-switcher__cost">
                switching locks this one
              </span>
            </div>
            <VaultList
              vaults={vaults}
              density="menu"
              onPick={(vault) => void swap(vault)}
            />

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
                placeholder="New vault name"
                aria-label="New vault name"
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setError(null);
                }}
              />
              <button
                type="submit"
                aria-label="Seal a new vault"
                title="Seal a new vault with this vault's key"
                disabled={draftName.trim().length === 0}
              >
                <IconPlus size={14} />
              </button>
            </form>
            <div className="project-switcher__foot">
              <button
                type="button"
                className="unlock__switch"
                onClick={() => {
                  close();
                  navigate(settingsPath("vaults"));
                }}
              >
                Manage
              </button>
            </div>
            {error ? <p className="project-switcher__error">{error}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * After the active project changed: bring its keys into this tab and hand the
 * store its scope. `carryUnlock` is the shared-key road (a new tomb is forked
 * with this session's key; a sealed one opens with it when the wrap matches);
 * otherwise the swap locks, and the unlock screen for that vault is next.
 */
async function afterProjectChangeDefault(carryUnlock: boolean): Promise<void> {
  await enterActiveProjectScope(carryUnlock);
}

export const projectSwitcherSeams = {
  ProjectSwitcher: ProjectSwitcherDefault,
  afterProjectChange: afterProjectChangeDefault,
};

export async function afterProjectChange(carryUnlock: boolean): Promise<void> {
  return projectSwitcherSeams.afterProjectChange(carryUnlock);
}

export function ProjectSwitcher() {
  const Impl = projectSwitcherSeams.ProjectSwitcher;
  return <Impl />;
}

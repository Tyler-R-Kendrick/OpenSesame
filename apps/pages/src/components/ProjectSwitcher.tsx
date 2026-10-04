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

import { settingsPath } from "@opensesame/app-core/lib/crumbs.js";
import {
  createProject,
  projectsState,
  setActiveProject,
  subscribeProjects,
} from "@opensesame/app-core/lib/projects.js";
import {
  GUEST_TOMB,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import {
  type DeviceVault,
  enterActiveProjectScope,
  guestVaultLabel,
  switchToGuest,
  vaultGlyphId,
  vaultLabel,
} from "@opensesame/app-core/lib/vaults.js";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { isTouchPointer } from "../lib/gestures.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { GlyphMark } from "./GlyphMark.js";
import { IconPlus } from "./Icons.js";
import { VaultList } from "./VaultList.js";
import { glyphIsDrawn } from "./prompt-glyph.js";
import { useHold } from "./use-hold.js";

import { useDeviceVaults } from "../bindings/vaults.js";
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

  // Held, the segment does what pressing it does: the list of vaults, by name.
  const hold = useHold(
    useCallback(() => setOpen(true), []),
    glyphIsDrawn,
  );
  const bindSegment = useCallback(
    (element: HTMLButtonElement | null) => {
      promptRef(element);
      hold.bind(element);
    },
    [promptRef, hold.bind],
  );
  const name = guestOpen
    ? guestVaultLabel()
    : active
      ? vaultLabel(active)
      : "personal";

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
        ref={bindSegment}
        type="button"
        className="prompt__seg prompt__seg--tomb prompt__seg--glyph"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={name}
        title="Switch vault"
        onClick={() => {
          if (hold.consumeHold()) return;
          if (open) close();
          else setOpen(true);
        }}
        onContextMenu={(event) => {
          // A finger held here is asking for the vaults, not for the
          // session menu the prompt answers a right-click with.
          if (!isTouchPointer() || !glyphIsDrawn(event.currentTarget)) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <span className="prompt__name">{name}</span>
        <GlyphMark
          className="prompt__glyph"
          kind="vault"
          id={vaultGlyphId(guestOpen ? GUEST_TOMB : (active?.id ?? "personal"))}
        />
      </button>

      {open ? (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors Escape, handled on the menu */}
          <div
            className="project-switcher__backdrop"
            onClick={() => {
              if (!hold.consumeHold()) close();
            }}
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

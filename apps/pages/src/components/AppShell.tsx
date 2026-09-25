import { installRouterNavigate } from "@opensesame/app-core/lib/router-seam.js";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { keyboardIsIdle, landFocus } from "../lib/focus.js";
import {
  createChordState,
  createKeymapHandler,
  focusVaultListing,
  registerKeymapHelp,
} from "../lib/keymap.js";
import { useVaultStore } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { AccountSwitcher } from "./AccountSwitcher.js";
import { Crumbs } from "./Crumbs.js";
import { IconLock } from "./Icons.js";
import { InstallMark } from "./InstallMark.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { MoreMenu } from "./MoreMenu.js";
import { NavDrawer } from "./NavDrawer.js";
import { NavTree } from "./NavTree.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import {
  type SectionRowModel,
  sectionForPath,
  useSections,
} from "./RailRows.js";
import { Statusline } from "./Statusline.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { Wordmark } from "./Wordmark.js";
import { DuressPresentationOverlay } from "./duress/DuressPresentationOverlay.js";

/**
 * A capability removed while its route is current leaves the person on a
 * screen that no longer exists (SURFACE-09). The shell returns to the vault
 * and lands the keyboard there, rather than on a blank pane or on `body`.
 * A cold load of an unregistered path is not this case: no section was ever
 * matched, and the router's own fallback answers it.
 */
function useDeniedRouteFallback(sections: readonly SectionRowModel[]) {
  const location = useLocation();
  const navigate = useNavigate();
  const matchedBefore = useRef(false);
  const landing = useRef(false);
  useEffect(() => {
    const matched = sectionForPath(location.pathname, sections) !== undefined;
    if (matchedBefore.current && !matched) {
      landing.current = true;
      navigate("/vault", { replace: true });
    }
    matchedBefore.current = matched;
  }, [sections, location.pathname, navigate]);
  useEffect(() => {
    if (!landing.current || location.pathname !== "/vault") return;
    landing.current = false;
    focusVaultListing();
    if (keyboardIsIdle()) landFocus(document.getElementById("main"));
  }, [location.pathname]);
}

/**
 * Account, vault switcher, and lock share one session prompt at every width.
 */
function SessionPrompt() {
  const store = useVaultStore();
  const lockRef = useGuideTarget<HTMLButtonElement>("shell.lock");
  return (
    <div className="rail__prompt">
      <AccountSwitcher />
      <span className="prompt__dim" aria-hidden="true">
        @
      </span>
      <ProjectSwitcher />
      <span className="prompt__dim" aria-hidden="true">
        :/
      </span>
      <button
        ref={lockRef}
        type="button"
        className="icon-btn"
        onClick={() => store.lock()}
        aria-label="Lock vault"
        title="Lock vault"
      >
        <IconLock size={17} />
      </button>
    </div>
  );
}

/**
 * The half-typed chord outlives any one shell: a new `navigate`, or a
 * capability's wrapper arriving above the shell, rebuilds the handler, and a
 * `g` typed across that still lands.
 */
const SHELL_CHORD = createChordState();

function Shell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  useDeniedRouteFallback(useSections());
  const [keymapOpen, setKeymapOpen] = useState(false);
  const showKeymap = useCallback(() => setKeymapOpen(true), []);
  const closeKeymap = useCallback(() => setKeymapOpen(false), []);
  const keymap = useMemo(
    () => createKeymapHandler({ navigate, showHelp: showKeymap }, SHELL_CHORD),
    [navigate, showKeymap],
  );

  useEffect(() => {
    window.addEventListener("keydown", keymap, true);
    return () => window.removeEventListener("keydown", keymap, true);
  }, [keymap]);

  // The loader builds a module's context before any component renders, so a
  // capability whose tools navigate reads the router through this seam
  // (router-seam.ts). It is installed while the shell is mounted and taken
  // back when it is not.
  useEffect(() => installRouterNavigate(navigate), [navigate]);

  useEffect(() => registerKeymapHelp(showKeymap), [showKeymap]);

  return (
    <div className="app">
      <a href="#main" className="skip-link visually-hidden">
        Skip to content
      </a>
      <aside className="rail">
        <div className="rail__brand">
          <Wordmark className="rail__wordmark" />
          <InstallMark />
        </div>

        <SessionPrompt />

        <div className="rail__scroll">
          <NavTree />
        </div>
      </aside>

      <div className="main">
        {/* Phone chrome only: on a desktop the rail carries identity and the
            statusline carries plane truth, so the top bar exists where the
            rail is gone. */}
        <header className="topbar">
          {/* Sections at the leading edge, where a drawer's key belongs; plane
              truth, notifications, help and the keymap at the trailing one.
              Between them the bar a phone already had is the whole chrome. */}
          <NavDrawer />
          <SessionPrompt />
          <InstallMark />
          <ThemeToggle />
          <MoreMenu />
        </header>

        <Crumbs />

        <DuressPresentationOverlay />
        {children}
      </div>

      <Statusline />

      <KeymapSheet open={keymapOpen} close={closeKeymap} />
    </div>
  );
}

/**
 * Unlocked chrome. Support is mounted at the app root, not here, and so is
 * every optional section's own state: the connectors module wraps its route
 * and tree in `ConnectionsNavigation` itself, so the shell imports nothing a
 * plan may have excluded.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  return <Shell>{children}</Shell>;
}

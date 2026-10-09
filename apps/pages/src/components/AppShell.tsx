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
import { useKeymapEvents } from "../lib/keymap-events.js";
import {
  createChordState,
  createKeymapHandler,
  focusVaultListing,
  registerKeymapHelp,
} from "../lib/keymap.js";
import { useTabSwipe } from "../lib/tab-swipe-hook.js";
import { useGestures } from "../lib/use-gestures.js";
import { useNarrow } from "../lib/use-narrow.js";
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import { Crumbs } from "./Crumbs.js";
import { InstallMark } from "./InstallMark.js";
import { KeymapSheet } from "./KeymapSheet.js";
import { MobileToolbar } from "./MobileToolbar.js";
import { NavTree } from "./NavTree.js";
import {
  type SectionRowModel,
  sectionForPath,
  useSections,
} from "./RailRows.js";
import { SessionPrompt } from "./SessionPrompt.js";
import { Statusline } from "./Statusline.js";
import { Wordmark } from "./Wordmark.js";
import { DuressPresentationOverlay } from "./duress/DuressPresentationOverlay.js";
import { PageTreeExpansionProvider } from "./page-tree-expansion.js";

/**
 * A capability removed while its route is current leaves the person on a
 * screen that no longer exists (SURFACE-09). The shell returns to the vault
 * and lands the keyboard there, rather than on a blank pane or on `body`.
 * A cold load of an unregistered path is not this case: no section was ever
 * matched, and the router's own fallback answers it. Nor is a navigation to
 * a route that is not a rail section (`/device`, `/claim`, `/agents`): the
 * path changed, the sections did not, and the router either renders the
 * route or falls back itself. Only the same path losing its section counts —
 * comparing the match alone sent every link from a section to such a route
 * back to the vault.
 */
function useDeniedRouteFallback(sections: readonly SectionRowModel[]) {
  const location = useLocation();
  const navigate = useNavigate();
  const last = useRef<{ path: string; matched: boolean } | null>(null);
  const landing = useRef(false);
  useEffect(() => {
    const matched = sectionForPath(location.pathname, sections) !== undefined;
    const before = last.current;
    last.current = { path: location.pathname, matched };
    if (before?.path === location.pathname && before.matched && !matched) {
      landing.current = true;
      navigate("/vault", { replace: true });
    }
  }, [sections, location.pathname, navigate]);
  useEffect(() => {
    if (!landing.current || location.pathname !== "/vault") return;
    landing.current = false;
    focusVaultListing();
    if (keyboardIsIdle()) landFocus(document.getElementById("main"));
  }, [location.pathname]);
}

/**
 * The half-typed chord outlives any one shell: a new `navigate`, or a
 * capability's wrapper arriving above the shell, rebuilds the handler, and a
 * `g` typed across that still lands.
 */
const SHELL_CHORD = createChordState();

function Shell({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const narrow = useNarrow();
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

  // The touch half of the same keymap: two fingers, and a shake (ADR 0170).
  useGestures({ navigate, showHelp: showKeymap, chord: SHELL_CHORD });
  useTabSwipe();

  // The loader builds a module's context before any component renders, so a
  // capability whose tools navigate reads the router through this seam
  // (router-seam.ts). It is installed while the shell is mounted and taken
  // back when it is not.
  useEffect(() => installRouterNavigate(navigate), [navigate]);

  useEffect(() => registerKeymapHelp(showKeymap), [showKeymap]);

  // A macro bound to `on: unlock` or `on: enter:<section>` (ADR 0156).
  useKeymapEvents(useVaultStore(), navigate);

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

        {/* One tree at a time: below the breakpoint the rail is not drawn and
            the vault's first pane carries the tree (`VaultSection`), so a
            second `role="tree"` never shares the page with it. */}
        <div className="rail__scroll">{narrow ? null : <NavTree />}</div>
      </aside>

      <div className="main">
        {/* Phone chrome only: on a desktop the rail carries identity and the
            statusline carries plane truth, so the top bar exists where the
            rail is gone. */}
        <MobileToolbar />

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
  const { tomb } = useVault();
  return (
    <PageTreeExpansionProvider key={tomb}>
      <Shell>{children}</Shell>
    </PageTreeExpansionProvider>
  );
}

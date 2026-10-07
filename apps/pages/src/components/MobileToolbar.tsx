import { useContext, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { useNarrow } from "../lib/use-narrow.js";
import { SupportContext } from "../tutorial/support-context.js";
import { MoreMenu } from "./MoreMenu.js";
import { NavDrawer } from "./NavDrawer.js";
import { sectionForPath, useSections } from "./RailRows.js";
import { LockKey, SessionPrompt } from "./SessionPrompt.js";
import "./mobile-toolbar.css";

const noSubscription = () => () => {};
const noTarget = () => null;

/** Navigation and session controls share one drawer; the current section stays visible. */
export function MobileToolbar() {
  const location = useLocation();
  const section = sectionForPath(location.pathname, useSections());
  const narrow = useNarrow();
  const support = useContext(SupportContext);
  const target = useSyncExternalStore(
    support?.subscribe ?? noSubscription,
    () => support?.view().guide?.tour?.target ?? null,
    noTarget,
  );
  const revealSession =
    narrow && (target === "shell.account" || target === "prompt.tomb");
  return (
    <header className="topbar mobile-toolbar">
      <NavDrawer
        session={<SessionPrompt showLock={false} />}
        revealSession={revealSession}
      />
      <span className="mobile-toolbar__section">
        {section?.label ?? "OpenSesame"}
      </span>
      <LockKey />
      <MoreMenu />
    </header>
  );
}

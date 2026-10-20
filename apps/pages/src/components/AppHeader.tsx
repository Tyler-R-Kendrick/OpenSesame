import { useLocation } from "react-router";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { InstallMark } from "./InstallMark.js";
import { MoreMenu } from "./MoreMenu.js";
import { NavDrawer } from "./NavDrawer.js";
import { NotificationsBar } from "./NotificationsBar.js";
import { sectionForPath, useSections } from "./RailRows.js";
import { SessionPrompt } from "./SessionPrompt.js";
import { ShellUpdateMark } from "./ShellUpdateMark.js";
import { Wordmark } from "./Wordmark.js";
import "./app-header.css";

/** One session header above both panes, at every width. */
export function AppHeader() {
  const location = useLocation();
  const section = sectionForPath(location.pathname, useSections());
  const notificationsRef = useGuideTarget<HTMLDivElement>(
    "shell.notifications",
  );
  return (
    <header className="app-header mobile-toolbar" aria-label="Application">
      <div className="app-header__navigation">
        <NavDrawer />
        <span className="mobile-toolbar__section visually-hidden">
          {section?.label ?? "OpenSesame"}
        </span>
      </div>
      <div className="app-header__brand">
        <Wordmark className="rail__wordmark" />
      </div>
      <SessionPrompt header />
      <div className="app-header__tools">
        <ShellUpdateMark />
        <InstallMark />
        <div ref={notificationsRef} className="app-header__notifications">
          <NotificationsBar />
        </div>
        <div className="app-header__more">
          <MoreMenu />
        </div>
      </div>
    </header>
  );
}

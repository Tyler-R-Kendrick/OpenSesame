/**
 * Section navigation on a phone: one key, and a drawer behind it.
 *
 * It was a bottom bar of five labelled tabs — a full row of the frame, always
 * drawn, for a choice made rarely: this is a vault, and a person lives in the
 * vault. Behind one key the row comes back to the content, and the drawer has
 * room to name each section properly rather than fitting five words into the
 * width of a phone.
 *
 * The key sits where a drawer's key belongs, at the leading edge of the bar
 * the phone already has, and the wordmark moves into the drawer's head — which
 * is where a drawer carries a brand. Nothing floats: a fixed button over the
 * content would cover the thing it was floating above, which is the clutter
 * this removes.
 *
 * The rail is the desktop's navigation. This drawer keeps the
 * two session-level directories the rail leaves out — settings
 * and the activity log — because a phone has no right-click on
 * the session prompt to root the tree in them, so the drawer is
 * where a phone reaches them. Every other section is drawn here
 * exactly as the rail draws it, so a section is never named
 * twice in two places, and an excluded capability has no row
 * here either.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { NavLink, useLocation } from "react-router";
import { useModalFocus } from "../lib/modal-focus.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { IconMenu, IconX } from "./Icons.js";
import { type SectionRowModel, useSections } from "./RailRows.js";
import { Wordmark } from "./Wordmark.js";

/** One section, bound to the same semantic target as its rail row. */
function DrawerRow({
  section,
  onGo,
}: { section: SectionRowModel; onGo: () => void }) {
  const ref = useGuideTarget<HTMLAnchorElement>(section.guide);
  const { to, label, Icon } = section;
  return (
    <NavLink
      ref={ref}
      to={to}
      onClick={onGo}
      className={({ isActive }) => `drawer__row${isActive ? " is-active" : ""}`}
    >
      <Icon size={18} />
      <span className="drawer__name">{label}</span>
    </NavLink>
  );
}

export function NavDrawer({
  session,
  revealSession = false,
}: { session?: ReactNode; revealSession?: boolean }) {
  const [open, setOpen] = useState(false);
  const revealedByGuide = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const guideFocusRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const keyRef = useGuideTarget<HTMLButtonElement>("nav.menu");
  const sections = useSections();
  const location = useLocation();
  // Stable: `useModalFocus` keeps this in its effect deps, and a fresh
  // arrow each render would re-run the effect — re-focusing Close and
  // taking the keyboard off whatever the person was on. `useConnectors`
  // re-renders on a timer, so that fired on its own.
  const close = useCallback(() => {
    revealedByGuide.current = false;
    setOpen(false);
  }, []);
  // A tutorial owns focus on its Next key while it reveals a control. A
  // person's ordinary Sections gesture still lands on the drawer's Close.
  useModalFocus(
    open,
    drawerRef,
    revealedByGuide.current ? guideFocusRef : closeRef,
    close,
  );
  // Next may advance past the Sections key without activating it. Reveal the
  // session controls for the next pointer, and close only a drawer the guide
  // opened; a person's own drawer stays under their control.
  useEffect(() => {
    if (revealSession) {
      setOpen((wasOpen) => {
        if (!wasOpen) revealedByGuide.current = true;
        return true;
      });
    } else if (revealedByGuide.current) {
      revealedByGuide.current = false;
      close();
    }
  }, [close, revealSession]);
  const lastLocation = useRef(location.key);
  useEffect(() => {
    if (lastLocation.current === location.key) return;
    lastLocation.current = location.key;
    close();
  }, [close, location.key]);

  return (
    <>
      <button
        ref={keyRef}
        type="button"
        className="icon-btn topbar__menu"
        aria-label="Sections"
        title="Sections"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          revealedByGuide.current = false;
          setOpen(true);
        }}
      >
        <IconMenu size={18} />
      </button>

      {open ? (
        <div className="sheet-layer">
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={close}
          />
          <div
            ref={drawerRef}
            className="drawer"
            // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
            role="dialog"
            aria-label="Sections"
            aria-modal="true"
          >
            <div className="drawer__head">
              <Wordmark className="drawer__wordmark" />
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                ref={closeRef}
                onClick={close}
              >
                <IconX size={18} />
              </button>
            </div>
            {session ? <div className="drawer__session">{session}</div> : null}
            <nav className="drawer__rows" aria-label="Sections">
              {sections.map((section) => (
                <DrawerRow key={section.to} section={section} onGo={close} />
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}

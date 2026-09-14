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
 * The rail is still the desktop's navigation, unchanged. This is the same
 * `SECTIONS` list it draws, so a section is never named twice in two places.
 */

import { useRef, useState } from "react";
import { NavLink } from "react-router";
import { useModalFocus } from "../lib/modal-focus.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { IconMenu, IconX } from "./Icons.js";
import { SECTIONS } from "./RailRows.js";
import { Wordmark } from "./Wordmark.js";

/** One section, bound to the same semantic target as its rail row. */
function DrawerRow({
  section,
  onGo,
}: { section: (typeof SECTIONS)[number]; onGo: () => void }) {
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

export function NavDrawer() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const keyRef = useGuideTarget<HTMLButtonElement>("nav.menu");
  useModalFocus(open, drawerRef, closeRef, () => setOpen(false));

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
        onClick={() => setOpen(true)}
      >
        <IconMenu size={18} />
      </button>

      {open ? (
        <div className="sheet-layer">
          <button
            type="button"
            className="scrim"
            aria-label="Close"
            onClick={() => setOpen(false)}
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
                onClick={() => setOpen(false)}
              >
                <IconX size={18} />
              </button>
            </div>
            <nav className="drawer__rows" aria-label="Sections">
              {SECTIONS.map((section) => (
                <DrawerRow
                  key={section.to}
                  section={section}
                  onGo={() => setOpen(false)}
                />
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </>
  );
}

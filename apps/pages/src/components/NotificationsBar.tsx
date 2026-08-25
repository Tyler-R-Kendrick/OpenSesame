/**
 * Notifications glyph in the top status bar. Guest login that skipped
 * registered auth lands a claim-ceremony prompt here.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { beginSignIn, defaultUpstream } from "../lib/federation.js";
import { stashCurrentSession } from "../lib/guest-auth.js";
import {
  dismissNotice,
  listNotices,
  subscribeNotices,
} from "../lib/notices.js";
import { loadQueue } from "../lib/queue.js";
import { CeremonyShell } from "./CeremonyShell.js";
import { IconBell, IconX } from "./Icons.js";

export const notificationsBarDependencies = {
  beginSignIn,
  defaultUpstream,
  stashCurrentSession,
};

function NotificationsBarDefault() {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  const queued = loadQueue().length;
  const [open, setOpen] = useState(false);
  const count = notices.length + queued;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    if (!open) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const label =
    count === 0
      ? "Notifications — none"
      : count === 1
        ? "Notifications — 1 pending"
        : `Notifications — ${count} pending`;

  return (
    <>
      <button
        type="button"
        className={["cx__btn", count > 0 ? "cx__btn--attn" : "cx__btn--off"]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <IconBell />
        <span className="cx__pip" aria-hidden="true" />
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
            className="sheet"
            // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
            role="dialog"
            aria-label="Notifications"
            aria-modal="true"
          >
            <div className="sheet__head">
              <span className="sheet__mark" aria-hidden="true">
                <IconBell size={20} />
              </span>
              <div className="sheet__grow">
                <h2>Notifications</h2>
                <p>
                  Guest sessions that skipped registered sign-in wait here for a
                  claim ceremony.
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <IconX size={18} />
              </button>
            </div>
            <div className="sheet__body">
              {count === 0 ? <p className="hint">Nothing waiting.</p> : null}
              {/* The claim prompt already lived in the ceremony's own sheet
                  and had all the ceremony's parts — a what-is statement, a
                  fact, a primary, a dismissal — it just hand-rolled them in a
                  one-off card. Same shape as every other ceremony now. */}
              {notices.map((notice) => (
                <CeremonyShell
                  key={notice.id}
                  ok={false}
                  top="Guest session"
                  name={notice.title}
                  facts={
                    notice.userCode
                      ? [{ key: "Consent code", value: notice.userCode }]
                      : []
                  }
                  primary={{
                    label: "Sign in to claim",
                    onClick: () => {
                      notificationsBarDependencies.stashCurrentSession();
                      void notificationsBarDependencies.beginSignIn(
                        notificationsBarDependencies.defaultUpstream(),
                        {
                          returnTo: "/",
                        },
                      );
                    },
                  }}
                  secondary={{
                    label: "Dismiss",
                    onClick: () => dismissNotice(notice.id),
                  }}
                >
                  <p className="hint">{notice.body}</p>
                </CeremonyShell>
              ))}
              {queued > 0 ? (
                <p className="hint">
                  {queued} staged device or claim action
                  {queued === 1 ? "" : "s"} wait on the Authority tab.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export const notificationsBarSeams = {
  NotificationsBar: NotificationsBarDefault,
};

export function NotificationsBar() {
  const Impl = notificationsBarSeams.NotificationsBar;
  return <Impl />;
}

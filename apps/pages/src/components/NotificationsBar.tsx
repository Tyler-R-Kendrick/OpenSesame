/**
 * Notifications glyph in the top status bar. Guest login that skipped
 * registered auth lands a claim-ceremony prompt here, and pages mirror their
 * standing trouble — Host down, Identity unreachable, a list that failed to
 * load — here instead of stacking banners above their own content.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "react-router";
import { beginSignIn, defaultUpstream } from "../lib/federation.js";
import { useModalFocus } from "../lib/modal-focus.js";
import {
  type Notice,
  dismissNotice,
  listNotices,
  subscribeNotices,
} from "../lib/notices.js";
import { loadQueue } from "../lib/queue.js";
import { buildHealthReport } from "../lib/vault/health.js";
import { useVault } from "../lib/vault/hooks.js";
import { CeremonyLink } from "./CeremonyLauncher.js";
import { CeremonyShell } from "./CeremonyShell.js";
import { IconAlert, IconBell, IconInfo, IconShield, IconX } from "./Icons.js";

export const notificationsBarDependencies = {
  beginSignIn,
  defaultUpstream,
  useVault,
};

function NotificationsBarDefault() {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  const { items } = notificationsBarDependencies.useVault();
  const health = useMemo(() => buildHealthReport(items), [items]);
  const queued = loadQueue().length;
  const [open, setOpen] = useState(false);
  const healthPending = health.findings.length > 0;
  const count = notices.length + queued + (healthPending ? 1 : 0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useModalFocus(open, sheetRef, closeRef, close);

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
            onClick={close}
          />
          <div
            ref={sheetRef}
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
                <p>Claims, password health, and service status.</p>
              </div>
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
            <div className="sheet__body">
              {count === 0 ? <p className="hint">Nothing waiting.</p> : null}
              {healthPending ? (
                <article className="notice-card notice-card--warn">
                  <h3>
                    <IconShield size={16} />
                    Password health
                  </h3>
                  <p>
                    {health.findings.length} of {health.scored} passwords need
                    attention.
                  </p>
                  <div className="actions">
                    <Link
                      className="btn btn--sm btn--primary"
                      to="/vault/health"
                      onClick={close}
                    >
                      Review passwords
                    </Link>
                  </div>
                </article>
              ) : null}
              {/* The claim prompt already lived in the ceremony's own sheet
                  and had all the ceremony's parts — a what-is statement, a
                  fact, a primary, a dismissal — it just hand-rolled them in a
                  one-off card. Same shape as every other ceremony now. Status
                  notices — the standing trouble pages mirror here instead of
                  stacking banners — keep their own tone-accented card. */}
              {notices.map((notice) =>
                notice.kind === "status" ? (
                  <StatusNoticeCard key={notice.id} notice={notice} />
                ) : (
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
                        void notificationsBarDependencies.beginSignIn(
                          notificationsBarDependencies.defaultUpstream(),
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
                ),
              )}
              {queued > 0 ? (
                <p className="hint">
                  {queued} staged device or claim action
                  {queued === 1 ? "" : "s"} wait on Identity.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function StatusNoticeCard({ notice }: { notice: Notice }) {
  const tone = notice.tone ?? "info";
  return (
    <article
      className={`notice-card notice-card--${tone}`}
      // Standing trouble should be announced when it lands in the open sheet.
      role={tone === "err" ? "alert" : undefined}
    >
      <h3>
        {tone === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
        {notice.title}
      </h3>
      <p>{notice.body}</p>
      <div className="actions">
        {notice.retry ? (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => notice.retry?.()}
          >
            {notice.retryLabel ?? "Try again"}
          </button>
        ) : null}
        {notice.ceremony ? (
          // Repair opens as a ceremony sheet in place — never a route change.
          <CeremonyLink id={notice.ceremony}>
            {notice.ceremonyLabel ?? "Repair the connection"}
          </CeremonyLink>
        ) : null}
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => dismissNotice(notice.id)}
        >
          Dismiss
        </button>
      </div>
    </article>
  );
}

export const notificationsBarSeams = {
  NotificationsBar: NotificationsBarDefault,
};

export function NotificationsBar() {
  const Impl = notificationsBarSeams.NotificationsBar;
  return <Impl />;
}

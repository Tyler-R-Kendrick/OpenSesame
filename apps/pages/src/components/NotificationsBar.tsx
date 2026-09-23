/**
 * Notifications glyph in the top status bar. Guest login that skipped
 * registered auth lands a claim-ceremony prompt here, and pages mirror their
 * standing trouble — Host down, Identity unreachable, a list that failed to
 * load — here instead of stacking banners above their own content.
 */

import {
  beginSignIn,
  defaultUpstream,
} from "@opensesame/app-core/lib/federation.js";
import {
  type Notice,
  dismissNotice,
  listNotices,
  subscribeNotices,
} from "@opensesame/app-core/lib/notices.js";
import { loadQueue } from "@opensesame/app-core/lib/queue.js";
import { buildHealthReport } from "@opensesame/app-core/lib/vault/health.js";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "react-router";
import { useModalFocus } from "../lib/modal-focus.js";
import { useVault } from "../lib/vault/hooks.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { CeremonyLink } from "./CeremonyLauncher.js";
import { CeremonyShell } from "./CeremonyShell.js";
import { IconAlert, IconBell, IconInfo, IconShield, IconX } from "./Icons.js";

export const notificationsBarDependencies = {
  beginSignIn,
  defaultUpstream,
  useVault,
};

/**
 * `key` is the icon button the desktop statusline draws. `panel` is the same
 * sheet with no trigger of its own, for the phone's More menu: there is no
 * strip for a bell to sit on, and the sheet cannot be a child of the menu that
 * opened it — closing the menu would unmount it, and leaving the menu open
 * stacks two scrims and squeezes this one into a sliver at the bottom.
 */
export type NotificationsForm = "key" | "panel";

/**
 * What the bell is looking at: the notices, the health report, and the one
 * count over both. Shared rather than recomputed per form, so the phone's More
 * row and the desktop strip's key can never disagree — and so the health scan,
 * which walks every password, runs once per render rather than once per form.
 */
export type NoticesSnapshot = {
  notices: Notice[];
  health: ReturnType<typeof buildHealthReport>;
  queued: number;
  count: number;
};

export function useNotices(): NoticesSnapshot {
  const notices = useSyncExternalStore(subscribeNotices, listNotices);
  const { items } = notificationsBarDependencies.useVault();
  const health = useMemo(() => buildHealthReport(items), [items]);
  const queued = loadQueue().length;
  const count = notices.length + queued + (health.findings.length > 0 ? 1 : 0);
  return { notices, health, queued, count };
}

/** Just the number, for a caller that draws no list. */
export function useNoticeCount(): number {
  return useNotices().count;
}

function NotificationsBarDefault({
  form = "key",
  onClose,
}: { form?: NotificationsForm; onClose?: () => void }) {
  const { notices, health, queued, count } = useNotices();
  const [open, setOpen] = useState(form === "panel");
  const healthPending = health.findings.length > 0;
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);
  const healthRef = useGuideTarget<HTMLAnchorElement>("notifications.health");
  useModalFocus(open, sheetRef, closeRef, close);

  const label =
    count === 0
      ? "Notifications — none"
      : count === 1
        ? "Notifications — 1 pending"
        : `Notifications — ${count} pending`;

  return (
    <>
      {form === "panel" ? null : (
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
      )}
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
                      ref={healthRef}
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
                    facts={(() => {
                      const rows: { key: string; value: string }[] = [];
                      if (notice.userCode) {
                        rows.push({
                          key: "Consent code",
                          value: notice.userCode,
                        });
                      }
                      if (notice.body.includes("backup account")) {
                        rows.push({
                          key: "Backups",
                          value:
                            "Provisional Postgres accounts claim with this sign-in",
                        });
                      }
                      return rows;
                    })()}
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
          className="icon-btn icon-btn--sm"
          onClick={() => dismissNotice(notice.id)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <IconX size={16} />
        </button>
      </div>
    </article>
  );
}

export const notificationsBarSeams = {
  NotificationsBar: NotificationsBarDefault,
};

export function NotificationsBar({
  form,
  onClose,
}: { form?: NotificationsForm; onClose?: () => void } = {}) {
  const Impl = notificationsBarSeams.NotificationsBar;
  return <Impl form={form} onClose={onClose} />;
}

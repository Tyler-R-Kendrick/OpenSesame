/**
 * The toasts: the transient echo of a notice (ADR 0162; the policy is
 * app-core `lib/notice-toast.ts`). A toast carries the tray notice's own words,
 * sits as a fixed block above the statusline (the shell or a shellless
 * screen), and goes after a few seconds unless the person is reading it. It
 * takes no layout space, so an arrival cannot resize a pane. The tray keeps
 * the notice.
 *
 * It is one polite live region, drawn whether or not anything is showing, so
 * an arrival is announced where it is added. A failure is a tone on a notice
 * card, not a box and not an alert (DESIGN.md § Status is a symbol).
 */

import {
  type ToastMessage,
  arrivalSurface,
  desktopRinging,
  subscribeToasts,
  toastOf,
} from "@opensesame/app-core/lib/notice-toast.js";
import { subscribeNoticeArrivals } from "@opensesame/app-core/lib/notices.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ringDesktopNotice, tabAway } from "../lib/notice-desktop.js";
import { IconKey } from "./IconKey.js";
import { IconAlert, IconArrowRight, IconInfo, IconX } from "./Icons.js";

/** How long a toast stays when the person is not reading it. */
export const TOAST_MS = 6000;

/** How many toasts are on screen at once; the rest are only in the tray. */
export const TOAST_LIMIT = 2;

export function ToastStack() {
  const navigate = useNavigate();
  const [shown, setShown] = useState<ToastMessage[]>([]);

  const add = useCallback((toast: ToastMessage) => {
    setShown((current) =>
      [...current.filter((item) => item.id !== toast.id), toast].slice(
        -TOAST_LIMIT,
      ),
    );
  }, []);
  const dismiss = useCallback((id: string) => {
    setShown((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => subscribeToasts(add), [add]);
  useEffect(
    () =>
      subscribeNoticeArrivals((notice) => {
        const surface = arrivalSurface({
          away: tabAway(),
          desktop: desktopRinging(),
        });
        if (surface === "toast") add(toastOf(notice));
        else if (surface === "desktop") ringDesktopNotice(notice, navigate);
      }),
    [add, navigate],
  );

  return (
    <output className="toasts" aria-live="polite">
      {shown.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          onDone={dismiss}
          onOpen={(to) => navigate(to)}
        />
      ))}
    </output>
  );
}

function Toast({
  toast,
  onDone,
  onOpen,
}: {
  toast: ToastMessage;
  onDone: (id: string) => void;
  onOpen: (to: string) => void;
}) {
  // Reading it (a pointer or focus on the card) holds it; leaving resumes the
  // time it had left, so a toast is never cut short by a glance away.
  const [reading, setReading] = useState(false);
  const left = useRef(TOAST_MS);
  const since = useRef(0);
  useEffect(() => {
    if (reading) return;
    since.current = Date.now();
    const timer = setTimeout(() => onDone(toast.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - since.current;
    };
  }, [reading, onDone, toast.id]);

  const { tone } = toast;
  return (
    <article
      className={`notice-card notice-card--${tone} toast`}
      onPointerEnter={() => setReading(true)}
      onPointerLeave={() => setReading(false)}
      onFocus={() => setReading(true)}
      onBlur={() => setReading(false)}
    >
      <h3>
        {tone === "info" ? <IconInfo size={16} /> : <IconAlert size={16} />}
        {toast.title}
      </h3>
      <p>{toast.body}</p>
      <div className="actions">
        {toast.open ? (
          <IconKey
            label={toast.open.label}
            small
            onClick={() => {
              onDone(toast.id);
              if (toast.open) onOpen(toast.open.to);
            }}
          >
            <IconArrowRight size={16} />
          </IconKey>
        ) : null}
        <IconKey label="Dismiss" small onClick={() => onDone(toast.id)}>
          <IconX size={16} />
        </IconKey>
      </div>
    </article>
  );
}

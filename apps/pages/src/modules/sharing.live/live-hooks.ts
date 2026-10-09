/**
 * The live session this tab hosts or has joined, as React state, and the
 * two browser pieces app-core does not touch: `RTCPeerConnection` and this
 * app's own address (ADR 0150).
 */

import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import type {
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  currentGuest,
  currentHost,
  onLiveSessionChange,
} from "@opensesame/app-core/lib/live/session.js";
import { useEffect, useState } from "react";
import type { StatusTone } from "../../components/StatusMark.js";
import { carriersUnavailable } from "./carriers/index.js";

/** A glyph's tone, its short page label, and the tray sentence. */
export type Standing = Readonly<{
  tone: StatusTone;
  label: string;
  tray: string;
}>;

export function standingMark(
  tone: StatusTone,
  label: string,
  tray = label,
): Standing {
  return { tone, label, tray };
}

/** The session this tab joined, and where it stands. */
export type LiveGuestView = Readonly<{
  guest: LiveGuest | null;
  status: GuestStatus | null;
}>;

/** The session this tab hosts, and its state. */
export type LiveHostView = Readonly<{
  host: LiveHost | null;
  state: HostState | null;
}>;

/**
 * What the joiner has typed, and the link in hand, kept in memory across a
 * remount: committing the join road's consent re-plans the page, and the
 * screen can mount again after the person has started typing. Cleared when
 * they close the screen; never written anywhere.
 */
export type JoinDraft = {
  link: LiveLink | null;
  pasted: string;
  code: string;
  name: string;
  note: string;
  /** Why the last ask failed: the form mounts afresh after one. */
  failed: string;
  /** Whether to use the servers the link names (shown before any contact). */
  useRoutes: boolean;
};

export const joinDraft: JoinDraft = {
  link: null,
  pasted: "",
  code: "",
  name: "",
  note: "",
  failed: "",
  useRoutes: true,
};

export function clearJoinDraft(): void {
  Object.assign(joinDraft, {
    link: null,
    pasted: "",
    code: "",
    name: "",
    note: "",
    failed: "",
    useRoutes: true,
  });
}

/** One field of the draft, as React state that writes through. */
export function useDraftField(
  key: "pasted" | "code" | "name" | "note" | "failed",
): [string, (next: string) => void] {
  const [value, setValue] = useState(() => joinDraft[key]);
  return [
    value,
    (next) => {
      joinDraft[key] = next;
      setValue(next);
    },
  ];
}

/** Seams, so a test can stand a fake network in for the browser's. */
export const liveUiSeams = {
  peers: (config: RTCConfiguration): RTCPeerConnection =>
    new RTCPeerConnection(config),
  /**
   * The carrier clients, made by `runtime.ts` from this activation's egress
   * port and taken away again on dispose: until then nothing opens, and a
   * refusal reads as blocked by this installation.
   */
  carriers: carriersUnavailable,
  /**
   * The app's own root: a fresh load there always meets the unlock screen,
   * whose join road takes the link (and asks for consent where Live
   * sessions is off). A path of its own would be a 404 on GitHub Pages.
   */
  joinUrl: () => new URL(import.meta.env.BASE_URL, window.location.origin).href,
  now: () => Date.now(),
};

export function useLiveGuest(): LiveGuestView {
  const [guest, setGuest] = useState(currentGuest);
  const [status, setStatus] = useState<GuestStatus | null>(
    () => guest?.status ?? null,
  );
  useEffect(() => onLiveSessionChange(() => setGuest(currentGuest())), []);
  useEffect(() => {
    if (!guest) {
      setStatus(null);
      return;
    }
    return guest.subscribe(setStatus);
  }, [guest]);
  return { guest, status };
}

export function useLiveHost(): LiveHostView {
  const [host, setHost] = useState(currentHost);
  const [state, setState] = useState<HostState | null>(
    () => host?.state ?? null,
  );
  useEffect(() => onLiveSessionChange(() => setHost(currentHost())), []);
  useEffect(() => {
    if (!host) {
      setState(null);
      return;
    }
    return host.subscribe(setState);
  }, [host]);
  return { host, state };
}

/** Whole minutes and seconds left, for a clock that ticks once a second. */
export function useRemaining(until: number | null): number {
  const [now, setNow] = useState(liveUiSeams.now);
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(liveUiSeams.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, until - now);
}

export function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours} h ${minutes % 60} min left`;
  if (minutes > 0) return `${minutes} min left`;
  return `${Math.ceil(ms / 1000)} s left`;
}

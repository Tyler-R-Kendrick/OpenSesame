/**
 * The live session this tab hosts or has joined, as React state, and the
 * two browser pieces app-core does not touch: `RTCPeerConnection` and this
 * app's own address (ADR 0148).
 */

import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import type {
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import {
  currentGuest,
  currentHost,
  onLiveSessionChange,
} from "@opensesame/app-core/lib/live/session.js";
import { useEffect, useState } from "react";
import type { StatusTone } from "../../components/StatusMark.js";

/** A glyph's tone and the sentence it stands for. */
export type Standing = Readonly<{ tone: StatusTone; label: string }>;

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

/** Seams, so a test can stand a fake network in for the browser's. */
export const liveUiSeams = {
  peers: (config: RTCConfiguration): RTCPeerConnection =>
    new RTCPeerConnection(config),
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

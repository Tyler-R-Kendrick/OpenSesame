/**
 * The live session this tab hosts or has joined, as React state, and the
 * two browser pieces app-core does not touch: the transport sessions run
 * over — WebRTC, built on this browser's `RTCPeerConnection` — and this app's
 * own address (ADR 0150, ADR 0186).
 */

import { forgetPersistedLiveLink } from "@opensesame/app-core/lib/join/invite.js";
import {
  connectionPort,
  offeredBy,
  onConnectionPort,
} from "@opensesame/app-core/lib/live/connection-port.js";
import type { DeviceConnection } from "@opensesame/app-core/lib/live/device-messages.js";
import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import type {
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import type { Rendezvous } from "@opensesame/app-core/lib/live/rendezvous.js";
import {
  currentGuest,
  currentHost,
  onLiveSessionChange,
} from "@opensesame/app-core/lib/live/session.js";
import { webRtc } from "@opensesame/app-core/lib/live/webrtc.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { StatusTone } from "../../components/StatusMark.js";
import { carriersUnavailable } from "./carriers/index.js";
import { liveOwnerCertificate } from "./live-dtls-pin.js";
import { cancelVaultEntry } from "./live-entry.js";
import { joinTrustFields } from "./live-join-trust.js";

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
 * screen can mount again after the person has started typing. An ask that
 * creates the joiner's vault mounts the form again while it is still
 * running, so what it learns afterwards is written here, where the new form
 * reads it. Cleared when they close the screen; never written anywhere.
 */
export type JoinDraft = {
  link: LiveLink | null;
  pasted: string;
  code: string;
  name: string;
  note: string;
  /** Why the last ask failed: the form mounts afresh after one. */
  failed: string;
  /** A refusal that holds the Ask key until the peer trust signal changes. */
  alarm: string;
  /** Whether to use the servers the link names (shown before any contact). */
  useRoutes: boolean;
  /** Optional OOB peer-trust signal from the owner (browser-only; no daemon). */
  peerTrust: string;
};

export const joinDraft: JoinDraft = {
  link: null,
  pasted: "",
  code: "",
  name: "",
  note: "",
  failed: "",
  alarm: "",
  useRoutes: true,
  peerTrust: "",
};

const draftWatchers = new Set<() => void>();

function draftChanged(): void {
  for (const watcher of draftWatchers) watcher();
}

function watchDraft(watcher: () => void): () => void {
  draftWatchers.add(watcher);
  return () => {
    draftWatchers.delete(watcher);
  };
}

export function clearJoinDraft(): void {
  cancelVaultEntry();
  forgetPersistedLiveLink();
  Object.assign(joinDraft, {
    link: null,
    pasted: "",
    code: "",
    name: "",
    note: "",
    failed: "",
    alarm: "",
    useRoutes: true,
    peerTrust: "",
  });
  draftChanged();
}

/**
 * One field of the draft, read from the draft on every render. A write from a
 * form that has since mounted again reaches the form now drawn.
 */
export function useDraftField(
  key: "pasted" | "code" | "name" | "note" | "failed" | "alarm" | "peerTrust",
): [string, (next: string) => void] {
  const value = useSyncExternalStore(watchDraft, () => joinDraft[key]);
  return [
    value,
    (next) => {
      joinDraft[key] = next;
      draftChanged();
    },
  ];
}

/** Seams, so a test can stand a fake network in for the browser's. */
export const liveUiSeams = {
  /** What carries sessions; another `PeerTransport` would plug in here. */
  transport: webRtc((config) => {
    const certificate = liveOwnerCertificate();
    if (!certificate) return new RTCPeerConnection(config);
    return new RTCPeerConnection({ ...config, certificates: [certificate] });
  }),
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
  /** The remembered-key check every ask makes before it is sent. */
  joinTrust: joinTrustFields,
};

export function useLiveGuest(): LiveGuestView {
  const [guest, setGuest] = useState(currentGuest);
  const [status, setStatus] = useState<GuestStatus | null>(
    () => guest?.status ?? null,
  );
  useEffect(() => {
    // The route can remount while the session is starting (a new vault, a
    // capability replan). Reconcile before subscribing so a change that
    // landed between render and effect is not lost.
    setGuest(currentGuest());
    return onLiveSessionChange(() => setGuest(currentGuest()));
  }, []);
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
  useEffect(() => {
    setHost(currentHost());
    return onLiveSessionChange(() => setHost(currentHost()));
  }, []);
  useEffect(() => {
    if (!host) {
      setState(null);
      return;
    }
    return host.subscribe(setState);
  }, [host]);
  return { host, state };
}

/** Whether a carrier has proved it can pass a code without a person. */
export function useRendezvousReady(rendezvous: Rendezvous | null): boolean {
  const [states, setStates] = useState(() => rendezvous?.states ?? []);
  useEffect(() => {
    setStates(rendezvous?.states ?? []);
    return rendezvous?.subscribe(setStates);
  }, [rendezvous]);
  return states.some((state) => state.status === "ready");
}

/** Whole minutes and seconds left, for a clock that ticks once a second. */
export function useRemaining(until: number | null): number {
  const [now, setNow] = useState(liveUiSeams.now);
  const [mountedAt] = useState(liveUiSeams.now);
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => setNow(liveUiSeams.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (until === null) return 0;
  // The catalog crosses the wire as time left in the session; the host's own
  // expiry is an absolute epoch. Accept both rather than showing "0 s left".
  const deadline = until < 1_000_000_000_000 ? mountedAt + until : until;
  return Math.max(0, deadline - now);
}

export function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} d ${hours % 24} h left`;
  if (hours > 0) return `${hours} h ${minutes % 60} min left`;
  if (minutes > 0) return `${minutes} min left`;
  return `${Math.ceil(ms / 1000)} s left`;
}

/**
 * The connections this app could let a device use (ADR 0196): read again when
 * the capability that owns them comes or goes. Empty while it is off, and then
 * nothing about devices is drawn.
 */
export function useOfferedConnections(): readonly DeviceConnection[] {
  const [offered, setOffered] = useState(() => offeredBy(connectionPort()));
  useEffect(
    () => onConnectionPort(() => setOffered(offeredBy(connectionPort()))),
    [],
  );
  return offered;
}

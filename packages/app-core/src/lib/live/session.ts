/**
 * The one live session this tab hosts, and the one it has joined
 * (ADR 0150 §2).
 *
 * They live here rather than in the capability module's activation: a
 * module is disposed and activated again on every lock, unlock and consent
 * commit, and a joiner mid-session must not be dropped because the page
 * re-planned. A hosted session is different on purpose — locking the vault
 * ends it, because the vault it reads from is gone.
 *
 * What does end both, hosted and joined, is the capability going away: the
 * page's resolved plan no longer approves `sharing.live` — an operator
 * withdrew it, or the person switched it off. The UI is gone by then, and a
 * peer connection, carrier sockets and a polling loop must not outlive it.
 * A re-plan that still approves it (a lock, an unlock, a consent commit)
 * changes nothing here (ADR 0150 §7).
 */

import {
  type EffectivePlan,
  capabilityState,
} from "@opensesame/capability-composition";
import type { VaultItem } from "@opensesame/vault-core";
import { compositionStore } from "../capabilities/store.js";
import { persistedRestoreRefuses } from "../document-lifecycle.js";
import { vaultStore } from "../vault/store.js";
import { planRefusal } from "./carrier-policy.js";
import { LiveGuest } from "./guest.js";
import {
  captureHostAuthority,
  guardedLiveCarrierFactory,
} from "./host-authority.js";
import type { LiveHost } from "./host.js";
import { watchDocumentLifecycle } from "./lifecycle-watch.js";
import type { LiveLink } from "./link.js";
import { DIRECT_ONLY, type IceSettings, type PeerFactory } from "./peer.js";
import {
  captureLiveRealmAuthority,
  watchLiveRealmAuthority,
} from "./realm-authority.js";
import type { CarrierFactory, Rendezvous } from "./rendezvous.js";
import { NO_ROUTES, linkRoutes } from "./routes.js";
import {
  guestCarriersFor,
  openCarriers,
  poster,
  rtcServers,
} from "./session-carriers.js";
import { buildHost } from "./session-host.js";
import type { CarrierSpec } from "./transport.js";

export const liveSeams = {
  items: (): readonly VaultItem[] => vaultStore.getSnapshot().items,
  onLock: (handler: () => void): (() => void) => vaultStore.onLock(handler),
  /** The page's resolved plan; null until the composition store has one. */
  plan: (): EffectivePlan | null => compositionStore.getSnapshot().plan,
  /** Hear the composition store publish, on every re-plan and activity note. */
  onPlan: (handler: () => void): (() => void) =>
    compositionStore.subscribe(handler),
};

const CAPABILITY = "sharing.live";

/** Whether a resolved plan approves Live sessions. */
export function planApprovesLive(plan: EffectivePlan): boolean {
  return capabilityState(plan, CAPABILITY)?.approved === true;
}

let host: LiveHost | null = null;
let hostCarriers: Rendezvous | null = null;
let stopLockWatch: (() => void) | null = null;
let guest: LiveGuest | null = null;
let guestCarriers: Rendezvous | null = null;
let stopPlanWatch: (() => void) | null = null;
let hostAuthority: (() => void) | null = null;
let guestAuthority: (() => void) | null = null;
let stopHostRealm: (() => void) | null = null;
let stopGuestRealm: (() => void) | null = null;

/**
 * While a session stands, end both when a resolved plan does not approve
 * Live sessions. A plan not yet resolved says nothing either way.
 */
function watchPlan(): void {
  stopPlanWatch ??= liveSeams.onPlan(holdToPlan);
  holdToPlan();
}

/**
 * Hold a standing session to the plan as it is now: ended when Live sessions
 * is no longer approved, and — still approved — each carrier the new network
 * policy no longer allows closed (a socket stays open until someone shuts it,
 * so a changed policy would otherwise never reach it).
 */
function holdToPlan(): void {
  const plan = liveSeams.plan();
  if (plan === null) return;
  if (!planApprovesLive(plan)) {
    endHosting();
    leaveLive();
    return;
  }
  const allowed = (spec: CarrierSpec): boolean =>
    planRefusal(spec, plan) === null;
  hostCarriers?.enforce(allowed);
  guestCarriers?.enforce(allowed);
}

function unwatchPlanIfIdle(): void {
  if (host || guest) return;
  stopPlanWatch?.();
  stopPlanWatch = null;
}

const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Hear when the hosted or joined session is replaced or cleared. */
export function onLiveSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type { HostInput } from "./host-input.js";
import type { HostInput, RelaySource } from "./host-input.js";
function authorityStands(): boolean {
  return host !== null || guest !== null;
}

function dropAuthority(): void {
  endHosting();
  leaveLive();
}

/** The document navigated away, so a frozen copy must not still be hosting. */
export function noteDocumentLeft(): void {
  if (authorityStands()) dropAuthority();
}

/** A persisted pageshow refuses authority that was live when the document froze. */
export function notePersistedRestore(persisted: boolean): void {
  if (persistedRestoreRefuses({ persisted, hadAuthority: authorityStands() })) {
    dropAuthority();
  }
}

function armRestoreGuard(): void {
  watchDocumentLifecycle(noteDocumentLeft, notePersistedRestore);
}

/**
 * Start hosting; any session this tab was hosting ends first.
 *
 * The lock watch is registered before anything is awaited: building a session
 * awaits, and a vault that locks in that window must not be left with a live
 * session over it. A session whose vault locked while it was being built
 * comes back already ended and is never the current one.
 */
export async function startHosting(input: HostInput): Promise<LiveHost> {
  const check = captureHostAuthority(vaultStore.pinContinuation());
  armRestoreGuard();
  endHosting();
  let started: LiveHost | null = null;
  let carriers: Rendezvous | null = null;
  let locked = false;
  const stopWatch = liveSeams.onLock(() => {
    locked = true;
    if (started && host === started) endHosting();
  });
  let post: ((code: string) => Promise<void>) | null = null;
  const source: RelaySource = { carriers: null };
  try {
    const built = await buildHost(
      input,
      (code) => void post?.(code).catch(() => made.end()),
      source,
      check,
      liveSeams.items,
    );
    const made = built.next;
    started = made;
    check();
    // A session another start installed while this one was building ends.
    endHosting();
    if (locked) {
      made.end("owner");
      stopWatch();
      return made;
    }
    check();
    host = made;
    hostAuthority = check;
    stopHostRealm = watchLiveRealmAuthority(endHosting);
    stopLockWatch = stopWatch;
    watchPlan();
    // The plan may already have withdrawn Live sessions while this was built.
    if (host !== made) return made;
    // The owner's own carriers: a minted credential here is the owner's, not
    // the one the link hands every joiner.
    carriers = openCarriers(
      built.own,
      made.link.secret,
      guardedLiveCarrierFactory(input.carriers, check),
      (code) => void made.receive(code).catch(() => made.end()),
      "owner",
    );
    source.carriers = carriers;
    hostCarriers = carriers;
    if (carriers) {
      const opened = carriers;
      post = poster(opened);
      made.subscribe((state) => {
        if (state.status === "ended") opened.close();
      });
    }
    check();
    changed();
    return made;
  } catch (error) {
    abandon(started, carriers, stopWatch);
    throw error;
  }
}

/**
 * A start that failed leaves nothing behind: the host it made (if it got
 * that far) ends, its carriers close, its lock watch goes, and it is not the
 * current session.
 */
function abandon(
  started: LiveHost | null,
  carriers: Rendezvous | null,
  stopWatch: () => void,
): void {
  stopWatch();
  carriers?.close();
  started?.end("owner");
  if (stopLockWatch === stopWatch) stopLockWatch = null;
  if (carriers && hostCarriers === carriers) hostCarriers = null;
  if (!started || host !== started) return;
  host = null;
  hostAuthority = null;
  stopHostRealm?.();
  stopHostRealm = null;
  try {
    changed();
  } catch {
    // The failure that brought us here is the one to report.
  }
  unwatchPlanIfIdle();
}

export function currentHost(): LiveHost | null {
  try {
    hostAuthority?.();
  } catch {
    endHosting();
  }
  return host;
}

/** The carriers the hosted session listens on, if its profile names any. */
export function currentHostCarriers(): Rendezvous | null {
  currentHost();
  return hostCarriers;
}

/** End the hosted session for everyone. */
export function endHosting(): void {
  stopHostRealm?.();
  stopHostRealm = null;
  hostAuthority = null;
  stopLockWatch?.();
  stopLockWatch = null;
  hostCarriers?.close();
  hostCarriers = null;
  if (!host) return;
  host.end("owner");
  host = null;
  unwatchPlanIfIdle();
  changed();
}

export type JoinInput = Readonly<{
  link: LiveLink;
  code: string | null;
  name: string;
  note: string;
  peers: PeerFactory;
  /**
   * Whether to use what the link names — its ICE servers and carriers. The
   * person agreed to the hosts it lists; without that, direct only.
   */
  useRoutes: boolean;
  carriers?: CarrierFactory;
}>;

/**
 * Start asking to join: the request code comes back for the person to send
 * the owner, and goes out on the link's carriers where they agreed to them.
 * Any session this tab had joined is left first.
 */
export async function joinLive(input: JoinInput): Promise<LiveGuest> {
  const check = captureLiveRealmAuthority();
  armRestoreGuard();
  leaveLive();
  // The join screen refuses a link whose routes do not read; direct here.
  const routes = linkRoutes(input.link) ?? NO_ROUTES;
  const ice: IceSettings = input.useRoutes
    ? { iceServers: rtcServers(routes.ice), relay: routes.relay, addresses: [] }
    : DIRECT_ONLY;
  let next: LiveGuest | null = null;
  const carriers = input.useRoutes
    ? openCarriers(
        routes.carriers,
        input.link.secret,
        guardedLiveCarrierFactory(input.carriers, check),
        (code) => void next?.accept(code).catch(() => next?.leave()),
      )
    : null;
  try {
    check();
    next = new LiveGuest({
      link: input.link,
      code: input.code,
      name: input.name,
      note: input.note,
      ice,
      peers: input.peers,
      carriers: carriers ? guestCarriersFor(carriers) : null,
    });
    check();
    guestCarriers = carriers;
    guest = next;
    guestAuthority = check;
    stopGuestRealm = watchLiveRealmAuthority(leaveLive);
    watchPlan();
    // The plan may already have withdrawn Live sessions: left before it began.
    if (guest !== next) return next;
    changed();
    await next.start();
    check();
    return next;
  } catch (error) {
    carriers?.close();
    if (guest === next) leaveLive();
    else next?.leave();
    throw error;
  }
}

export function currentGuest(): LiveGuest | null {
  try {
    guestAuthority?.();
  } catch {
    leaveLive();
  }
  return guest;
}

/** The carriers the joined session's request goes out on, if any. */
export function currentGuestCarriers(): Rendezvous | null {
  currentGuest();
  return guestCarriers;
}

/** Leave the joined session, dropping everything it held. */
export function leaveLive(): void {
  stopGuestRealm?.();
  stopGuestRealm = null;
  guestAuthority = null;
  guestCarriers?.close();
  guestCarriers = null;
  if (!guest) return;
  guest.leave();
  guest = null;
  unwatchPlanIfIdle();
  changed();
}

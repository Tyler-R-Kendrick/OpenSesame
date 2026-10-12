/**
 * In-tab notices — guest claim prompts and similar "you still need to do this".
 * Not OPFS: a claim token is a bearer, and a reload already dropped the guest
 * vault it belonged to.
 */

import type { ConnectorId } from "./connectors.js";

export type NoticeTone = "info" | "warn" | "err";

export type Notice = {
  id: string;
  /**
   * `federated_link` is a verified upstream identity that has not been attached
   * to a principal yet — the vault was locked when the browser came back, or a
   * reload dropped the in-memory prompt while the assertion lived on in
   * sessionStorage.
   *
   * `status` is a page condition mirrored into the tray — Host down, Identity
   * unreachable, a list that failed to load — so the page itself stays clean.
   * Status notices are keyed by id, not deduped by kind, and go through
   * `setStatusNotice`.
   */
  kind: "guest_claim" | "federated_link" | "status";
  tone?: NoticeTone;
  title: string;
  body: string;
  userCode?: string;
  claimToken?: string;
  verificationUri?: string;
  /**
   * Connector whose repair ceremony fixes this ("host") — opened in place
   * from the tray, never a route change.
   */
  ceremony?: ConnectorId;
  ceremonyLabel?: string;
  /** Re-attempt the failed work from the tray. */
  retry?: (() => void) | undefined;
  retryLabel?: string;
  /** An in-app route the notice points at, opened from the tray. */
  open?: NoticeOpen;
  createdAt: string;
};

/** Where a notice leads: a route of this app and the key's accessible name. */
export type NoticeOpen = { to: string; label: string };

export type StatusNoticeInput = {
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
  ceremony?: ConnectorId;
  ceremonyLabel?: string;
  retry?: (() => void) | undefined;
  retryLabel?: string;
  open?: NoticeOpen;
};

type Listener = () => void;
type ArrivalListener = (notice: Notice) => void;
type PersistListener = (notices: Notice[]) => void;

const listeners = new Set<Listener>();
const arrivalListeners = new Set<ArrivalListener>();
let persistListener: PersistListener | undefined;

let notices: Notice[] = [];

function emit(arrived?: Notice, skipPersist = false): void {
  for (const listener of listeners) listener();
  if (!skipPersist) persistListener?.(notices);
  if (arrived) {
    for (const listener of arrivalListeners) listener(arrived);
  }
}

function listNoticesDefault(): Notice[] {
  return notices;
}

function subscribeNoticesDefault(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function pushNoticeDefault(
  input: Omit<Notice, "id" | "createdAt"> & { id?: string },
): Notice {
  notices = notices.filter((notice) => notice.kind !== input.kind);
  const notice: Notice = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  notices = [...notices, notice];
  emit(notice);
  return notice;
}

/** The same words, to the letter: only a retry closure may differ. */
function sameWords(existing: Notice, input: StatusNoticeInput): boolean {
  return (
    existing.tone === input.tone &&
    existing.title === input.title &&
    existing.body === input.body &&
    existing.ceremony === input.ceremony &&
    existing.ceremonyLabel === input.ceremonyLabel &&
    existing.retryLabel === input.retryLabel &&
    existing.open?.to === input.open?.to &&
    existing.open?.label === input.open?.label
  );
}

function setStatusNoticeDefault(input: StatusNoticeInput): Notice {
  const existing = notices.find((notice) => notice.id === input.id);
  if (existing && sameWords(existing, input)) {
    // Same words — only the retry closure may have changed. Swap it in place
    // so the click calls the fresh one, without an emit that would loop the
    // effect that mirrors a page condition into this store.
    existing.retry = input.retry;
    return existing;
  }
  const notice: Notice = {
    ...input,
    kind: "status",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  notices = [...notices.filter((item) => item.id !== input.id), notice];
  // Standing page conditions update the badge. They are not arrivals: opening
  // the bell sheet here covers the page the person is already using.
  emit();
  return notice;
}

export type AppendStatusNoticeInput = Omit<StatusNoticeInput, "id"> & {
  id?: string;
};

/** A new tray row — claim and live outcomes keep their own history. */
function appendStatusNoticeDefault(input: AppendStatusNoticeInput): Notice {
  const notice: Notice = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    kind: "status",
    createdAt: new Date().toISOString(),
  };
  notices = [...notices, notice];
  emit(notice);
  return notice;
}

function dismissNoticeDefault(id: string): void {
  const next = notices.filter((notice) => notice.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

function clearNoticesDefault(): void {
  if (notices.length === 0) return;
  notices = [];
  emit(undefined, true);
}

function subscribeNoticeArrivalsDefault(listener: ArrivalListener): () => void {
  arrivalListeners.add(listener);
  return () => {
    arrivalListeners.delete(listener);
  };
}

function installNoticePersistenceDefault(listener: PersistListener): void {
  persistListener = listener;
}

function restorePersistedTrayNoticesDefault(restored: Notice[]): void {
  const ephemeral = notices.filter(
    (notice) =>
      notice.kind !== "status" || notice.claimToken || notice.userCode,
  );
  const byId = new Map<string, Notice>();
  for (const notice of restored) byId.set(notice.id, notice);
  for (const notice of notices) {
    if (notice.kind === "status" && !notice.claimToken && !notice.userCode) {
      byId.set(notice.id, notice);
    }
  }
  for (const notice of ephemeral) byId.set(notice.id, notice);
  notices = [...byId.values()].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
  emit();
}

export const noticeSeams = {
  listNotices: listNoticesDefault,
  subscribeNotices: subscribeNoticesDefault,
  pushNotice: pushNoticeDefault,
  setStatusNotice: setStatusNoticeDefault,
  appendStatusNotice: appendStatusNoticeDefault,
  dismissNotice: dismissNoticeDefault,
  clearNotices: clearNoticesDefault,
  subscribeNoticeArrivals: subscribeNoticeArrivalsDefault,
  installNoticePersistence: installNoticePersistenceDefault,
  restorePersistedTrayNotices: restorePersistedTrayNoticesDefault,
};

export function listNotices(): Notice[] {
  return noticeSeams.listNotices();
}

export function subscribeNotices(listener: Listener): () => void {
  return noticeSeams.subscribeNotices(listener);
}

export function pushNotice(
  input: Omit<Notice, "id" | "createdAt"> & { id?: string },
): Notice {
  return noticeSeams.pushNotice(input);
}

export function setStatusNotice(input: StatusNoticeInput): Notice {
  return noticeSeams.setStatusNotice(input);
}

export function appendStatusNotice(input: AppendStatusNoticeInput): Notice {
  return noticeSeams.appendStatusNotice(input);
}

export function subscribeNoticeArrivals(listener: ArrivalListener): () => void {
  return noticeSeams.subscribeNoticeArrivals(listener);
}

export function installNoticePersistence(listener: PersistListener): void {
  noticeSeams.installNoticePersistence(listener);
}

export function restorePersistedTrayNotices(restored: Notice[]): void {
  noticeSeams.restorePersistedTrayNotices(restored);
}

export function dismissNotice(id: string): void {
  noticeSeams.dismissNotice(id);
}

export function clearNotices(): void {
  noticeSeams.clearNotices();
}

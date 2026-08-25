/**
 * In-tab notices — guest claim prompts and similar "you still need to do this".
 * Not OPFS: a claim token is a bearer, and a reload already dropped the guest
 * vault it belonged to.
 */

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
  /** In-app destination for the fix ("Change it in Settings"). */
  linkTo?: string;
  linkLabel?: string;
  /** Re-attempt the failed work from the tray. */
  retry?: () => void;
  retryLabel?: string;
  createdAt: string;
};

export type StatusNoticeInput = {
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
  linkTo?: string;
  linkLabel?: string;
  retry?: () => void;
  retryLabel?: string;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let notices: Notice[] = [];

function emit(): void {
  for (const listener of listeners) listener();
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
  emit();
  return notice;
}

function setStatusNoticeDefault(input: StatusNoticeInput): Notice {
  const existing = notices.find((notice) => notice.id === input.id);
  if (
    existing &&
    existing.tone === input.tone &&
    existing.title === input.title &&
    existing.body === input.body &&
    existing.linkTo === input.linkTo &&
    existing.linkLabel === input.linkLabel &&
    existing.retryLabel === input.retryLabel
  ) {
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
  emit();
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
  emit();
}

export const noticeSeams = {
  listNotices: listNoticesDefault,
  subscribeNotices: subscribeNoticesDefault,
  pushNotice: pushNoticeDefault,
  setStatusNotice: setStatusNoticeDefault,
  dismissNotice: dismissNoticeDefault,
  clearNotices: clearNoticesDefault,
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

export function dismissNotice(id: string): void {
  noticeSeams.dismissNotice(id);
}

export function clearNotices(): void {
  noticeSeams.clearNotices();
}

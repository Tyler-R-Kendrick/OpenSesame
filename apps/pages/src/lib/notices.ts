/**
 * In-tab notices — guest claim prompts and similar "you still need to do this".
 * Not OPFS: a claim token is a bearer, and a reload already dropped the guest
 * vault it belonged to.
 */

export type Notice = {
  id: string;
  /**
   * `federated_link` is a verified upstream identity that has not been attached
   * to a principal yet — the vault was locked when the browser came back, or a
   * reload dropped the in-memory prompt while the assertion lived on in
   * sessionStorage.
   */
  kind: "guest_claim" | "federated_link";
  title: string;
  body: string;
  userCode?: string;
  claimToken?: string;
  verificationUri?: string;
  createdAt: string;
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

export function dismissNotice(id: string): void {
  noticeSeams.dismissNotice(id);
}

export function clearNotices(): void {
  noticeSeams.clearNotices();
}

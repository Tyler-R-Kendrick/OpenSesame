/** @vitest-environment jsdom */
/**
 * Atomic unit tests for the notice store.
 *
 * `notices.ts` is in the Stryker `mutate` set at a 100% break threshold, so
 * every branch, every `emit()` and every filter predicate here is pinned by an
 * assertion that fails if the behavior changes. Notices drive the "you still
 * need to attach your sign-in" prompt (ADR 0033 §4), so a silently dropped
 * emit or a broken dedupe is a user-visible loss, not cosmetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type StatusNoticeInput,
  clearNotices,
  dismissNotice,
  listNotices,
  pushNotice,
  setStatusNotice,
  subscribeNotices,
} from "./notices.js";

afterEach(() => {
  clearNotices();
});

function push(
  kind: "guest_claim" | "federated_link",
  title = "t",
  id?: string,
) {
  return pushNotice({
    kind,
    title,
    body: "b",
    ...(id !== undefined ? { id } : undefined),
  });
}

describe("pushNotice", () => {
  it("returns the stored notice, with a generated id and timestamp", () => {
    const notice = push("guest_claim");
    expect(notice.id).toBeTruthy();
    expect(notice.createdAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(notice.createdAt))).toBe(false);
    expect(listNotices()).toEqual([notice]);
  });

  it("honors an explicit id instead of generating one", () => {
    expect(push("guest_claim", "t", "fixed-id").id).toBe("fixed-id");
  });

  it("replaces any existing notice of the same kind", () => {
    push("guest_claim", "first");
    const second = push("guest_claim", "second");
    expect(listNotices()).toEqual([second]);
    expect(listNotices()).toHaveLength(1);
  });

  it("keeps notices of a different kind", () => {
    const guest = push("guest_claim");
    const federated = push("federated_link");
    // Order matters: the survivor stays first, the new one is appended.
    expect(listNotices()).toEqual([guest, federated]);
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    subscribeNotices(listener);
    push("guest_claim");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function statusInput(over: Partial<StatusNoticeInput> = {}): StatusNoticeInput {
  return {
    id: "host-down",
    tone: "warn",
    title: "Host API unavailable",
    body: "b",
    ...over,
  };
}

describe("setStatusNotice", () => {
  it("stores a status notice keyed by id and emits", () => {
    const listener = vi.fn();
    subscribeNotices(listener);
    const notice = setStatusNotice(statusInput());
    expect(notice.kind).toBe("status");
    expect(notice.createdAt).toBeTruthy();
    expect(listNotices()).toEqual([notice]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not collapse status notices with claim notices or each other", () => {
    const claim = pushNotice({ kind: "guest_claim", title: "t", body: "b" });
    const first = setStatusNotice(statusInput());
    const second = setStatusNotice(statusInput({ id: "identity-session" }));
    expect(listNotices()).toEqual([claim, first, second]);
  });

  it("replaces the notice with the same id when the words change", () => {
    const first = setStatusNotice(statusInput({ body: "first" }));
    const listener = vi.fn();
    subscribeNotices(listener);
    const second = setStatusNotice(statusInput({ body: "second" }));
    expect(listNotices()).toEqual([second]);
    expect(second.createdAt).toBe(first.createdAt);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("compares every wording field when deciding to replace", () => {
    for (const over of [
      { tone: "err" as const },
      { title: "t2" },
      { body: "b2" },
      { linkTo: "/settings" },
      { linkLabel: "Open" },
      { retryLabel: "Again" },
    ]) {
      clearNotices();
      setStatusNotice(statusInput());
      const listener = vi.fn();
      const unsubscribe = subscribeNotices(listener);
      setStatusNotice(statusInput(over));
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    }
  });

  it("swaps only the retry closure in place, without an emit", () => {
    setStatusNotice(statusInput());
    const listener = vi.fn();
    subscribeNotices(listener);
    const retry = vi.fn();
    const kept = setStatusNotice(statusInput({ retry }));
    expect(listener).not.toHaveBeenCalled();
    expect(listNotices()).toEqual([kept]);
    kept.retry?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("is dismissible like any other notice", () => {
    const notice = setStatusNotice(statusInput());
    dismissNotice(notice.id);
    expect(listNotices()).toEqual([]);
  });
});

describe("subscribeNotices", () => {
  it("stops notifying after the returned unsubscribe runs", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);
    push("guest_claim");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    push("federated_link");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every registered subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeNotices(a);
    const offB = subscribeNotices(b);
    push("guest_claim");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});

describe("dismissNotice", () => {
  it("removes only the named notice and emits", () => {
    const guest = push("guest_claim");
    const federated = push("federated_link");
    const listener = vi.fn();
    subscribeNotices(listener);

    dismissNotice(guest.id);
    expect(listNotices()).toEqual([federated]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit when the id matches nothing", () => {
    push("guest_claim");
    const listener = vi.fn();
    subscribeNotices(listener);

    dismissNotice("no-such-id");
    expect(listNotices()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("clearNotices", () => {
  it("empties the list and emits", () => {
    push("guest_claim");
    const listener = vi.fn();
    subscribeNotices(listener);

    clearNotices();
    expect(listNotices()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not emit when already empty", () => {
    const listener = vi.fn();
    subscribeNotices(listener);

    clearNotices();
    expect(listener).not.toHaveBeenCalled();
  });
});
